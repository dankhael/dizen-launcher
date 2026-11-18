#!/usr/bin/env bash
#
# sync-apps.sh — gera a lista curada de apps + ícones para o launcher Dizen.
#
# Busca a lista classificada na API do Vetro (GET /apps), filtra só os apps que
# fazem sentido num launcher (uiapp, visível, não-sistema, instalado pelo
# usuário), baixa os ícones (GET /apps/icon) e escreve:
#   launcher/js/apps.js     -> window.DIZEN_APPS = [...]
#                              window.DIZEN_SYSTEM = {tv: {svcid, channel, name}, tvplus: {svcid, name}}
#   launcher/icons/*.png    -> ícones (referenciados de forma relativa)
#
# Depois, envie à TV com ./tools/push-launcher.sh (ou use --push).
#
# Uso:
#   ./tools/sync-apps.sh            # só gera os arquivos locais
#   ./tools/sync-apps.sh --push     # gera e envia (js/apps.js + ícones)
#   DIZEN_TV_CHANNEL=4.1 ./tools/sync-apps.sh   # canal da entrada "TV Digital" (padrão 13.1)
#
# Requer: python3 + TV rooteada (Vetro) pareada (tools/.env).
#
set -uo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
launcher_dir="$repo_dir/launcher"
env_file="$repo_dir/tools/.env"

env_get() { grep -E "^${1}=" "$env_file" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '[:space:]'; }

TV_IP="${TV_IP:-$(env_get TV_IP)}"
TOKEN="${VETRO_TOKEN:-$(env_get VETRO_TOKEN)}"
PORT="${VETRO_PORT:-8099}"
PUSH=0
[[ "${1:-}" == "--push" ]] && PUSH=1

[[ -n "$TV_IP" && -n "$TOKEN" ]] || { echo "erro: sem TV_IP/VETRO_TOKEN. Rode: ./tools/push-launcher.sh pair" >&2; exit 2; }

export DIZEN_BASE="http://${TV_IP}:${PORT}"
export DIZEN_TOKEN="$TOKEN"
export DIZEN_LAUNCHER="$launcher_dir"

python3 - <<'PY'
import os, re, json, sys
import urllib.request, urllib.parse

base = os.environ['DIZEN_BASE']
token = os.environ['DIZEN_TOKEN']
launcher = os.environ['DIZEN_LAUNCHER']

def get(path, binary=False):
    req = urllib.request.Request(base + path, headers={'Authorization': 'Bearer ' + token})
    with urllib.request.urlopen(req, timeout=45) as r:
        data = r.read()
        return (data, r.headers.get('Content-Type', '')) if binary else data.decode('utf-8')

def slug(s):
    s = re.sub(r'[^A-Za-z0-9_.-]+', '_', s).strip('_.')
    return s or 'app'

# --- curadoria (edite à vontade) -------------------------------------------
EXCLUDE_ID = {'dizenlaunc.dizen', 'vetrotvapp.app'}      # o próprio launcher + o Vetro
EXCLUDE_NAME = {'vetro', 'dizen', 'security center', 'e-manual'}  # nomes a esconder
EXCLUDE_CATEGORY = {'voice', 'ads', 'privacy', 'tracking', 'support', 'commercial', 'hotel', 'system'}
# ids "companheiros" que não são o app de verdade (só usados no desempate por nome)
JUNK_RE = re.compile(r'dummy|service|worker|preview|companion|_bg|bg[-_]service|oobe|panel', re.I)

try:
    data = json.loads(get('/apps'))
except Exception as e:
    print('erro ao buscar /apps: %s' % e, file=sys.stderr)
    sys.exit(2)

apps = data.get('apps', [])
best = {}  # nome-lower -> (score, aid, name, cat, tem_icon)

for a in apps:
    if a.get('component') != 'uiapp': continue
    if not a.get('show'): continue
    if a.get('system'): continue
    if a.get('origin') != 'installed': continue
    cat = a.get('category') or ''
    if cat in EXCLUDE_CATEGORY: continue
    aid = a.get('appId') or ''
    if aid in EXCLUDE_ID: continue
    name = (a.get('name') or aid).strip()
    if name.lower() in EXCLUDE_NAME: continue
    key = name.lower()
    # entre duplicados de nome, prefere quem tem ícone, categoria de app "de
    # verdade" e id sem cara de serviço/dummy (ex.: Apple TV aria-video vs aria-dummy)
    score = (1 if a.get('iconPath') else 0) + (1 if cat in ('media', 'user') else 0) \
            - (2 if JUNK_RE.search(aid) else 0)
    if key not in best or score > best[key][0]:
        best[key] = (score, aid, name, cat, bool(a.get('iconPath')))

rows = sorted((v for v in best.values()), key=lambda v: v[2].lower())

icons_dir = os.path.join(launcher, 'icons')
os.makedirs(icons_dir, exist_ok=True)

# Alguns pacotes Samsung não expõem um ícone útil: YouTube devolve o catavento
# genérico do Tizen e Prime Video não informa iconPath.
CURATED_ICONS = {
    '9Ur5IzDKqV.TizenYouTube': 'icons/youtube.svg',
    'org.tizen.primevideo': 'icons/prime-video.svg',
}

final = []
n_icons = 0
for score, aid, name, cat, has_icon in rows:
    entry = {'id': aid, 'name': name}
    curated_icon = CURATED_ICONS.get(aid)
    if curated_icon and os.path.isfile(os.path.join(launcher, curated_icon)):
        entry['icon'] = curated_icon
        n_icons += 1
    elif has_icon:
        blob = None
        try:
            blob, _ = get('/apps/icon?appId=' + urllib.parse.quote(aid), binary=True)
            if blob[:4] == b'\x89PNG':
                ext = 'png'
            elif blob[:2] == b'\xff\xd8':
                ext = 'jpg'
            else:
                blob = None
        except Exception:
            blob = None
        if blob:
            fname = slug(aid) + '.' + ext
            with open(os.path.join(icons_dir, fname), 'wb') as f:
                f.write(blob)
            entry['icon'] = 'icons/' + fname
            n_icons += 1
    final.append(entry)

# --- canais: TV Digital e Samsung TV Plus ------------------------------------
# TV aberta e TV Plus são a mesma entrada e a mesma lista de canais (TV Plus =
# canais >= 2000). O launcher sintoniza um canal pelo tv-viewer usando o id de
# serviço (ver systemApps() em launcher/js/main.js); os ids vêm dos caches de
# busca da própria TV: TVS = canais do ar, TVPLUS = Samsung TV Plus.
# (O app "Samsung TV Plus" não abre sem deep link, e seu ícone na TV é o
# catavento genérico do Tizen; o launcher usa icons/sys-tvplus.svg.)
TV_DEFAULT_CHANNEL = os.environ.get('DIZEN_TV_CHANNEL', '13.1')   # canal da entrada "TV Digital"
CACHE_DIR = '/opt/usr/home/owner/apps_rw/com.samsung.tv.fuzzy-search-engine/data'
LINE_RE = re.compile(r'channel_\d+:(\d+),(\d+),(\d+),\d+,[^,]*,([^,]*)')

def channels(cache):
    req = urllib.request.Request(base + '/exec', method='POST',
        data=json.dumps({'cmd': "cat '%s/%s'" % (CACHE_DIR, cache)}).encode(),
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=45) as r:
        text = json.loads(r.read()).get('output') or ''
    out = []
    for line in text.split('\n'):
        m = LINE_RE.match(line)
        if m:
            out.append({'svcid': m.group(1), 'channel': '%s.%s' % (m.group(2), m.group(3)), 'name': m.group(4)})
    return out

system = {}
try:
    aired = channels('TVS_pt_BR.cch')
    pick = [c for c in aired if c['channel'] == TV_DEFAULT_CHANNEL] or aired[:1]
    if pick:
        system['tv'] = pick[0]
        if pick[0]['channel'] != TV_DEFAULT_CHANNEL:
            print('aviso: canal %s não existe na TV; "TV Digital" vai abrir no %s (%s)'
                  % (TV_DEFAULT_CHANNEL, pick[0]['channel'], pick[0]['name']), file=sys.stderr)
    plus = channels('TVPLUS_pt_BR.cch')
    if plus:
        system['tvplus'] = {'svcid': plus[0]['svcid'], 'name': plus[0]['name']}
except Exception as e:
    print('aviso: não consegui ler a lista de canais da TV: %s' % e, file=sys.stderr)
print('   TV Digital -> %s' % ('%(channel)s %(name)s' % system['tv'] if 'tv' in system else 'último canal (sem lista de canais)'))
print('   Samsung TV Plus -> %s' % (system['tvplus']['name'] if 'tvplus' in system else 'sem canal conhecido; a entrada não aparece'))

# ── Aparelhos nas portas HDMI ───────────────────────────────────────────────
# A Home da Samsung guarda, por porta, o nome que ela detectou (ou que o dono
# editou) em .sourceCache. Vira o PADRÃO do logo de cada entrada HDMI no
# launcher; a escolha feita em Configurações > Entradas HDMI tem prioridade.
# É um cache: mostra o que a Samsung viu por último, não o que está ligado agora.
SOURCE_CACHES = ['com.samsung.tv.csfs', 'com.samsung.tv.home.media']
KNOWN_DEVICES = [('ps5', r'playstation|ps ?5|ps ?4'), ('switch', r'switch|nintendo'), ('steamdeck', r'steam ?deck|steam')]
try:
    hdmi = {}
    for pkg in SOURCE_CACHES:
        req = urllib.request.Request(base + '/exec', method='POST',
            data=json.dumps({'cmd': "cat '/opt/usr/home/owner/apps_rw/%s/data/.sourceCache'" % pkg}).encode(),
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=45) as r:
            text = (json.loads(r.read()).get('output') or '').strip()
        try:
            cache = json.loads(text[text.index('{'):text.rindex('}') + 1])
        except ValueError:
            continue
        for key, src in cache.items():
            m = re.match(r'HDMI(\d)$', key)
            label = (src.get('EditName') or src.get('DetectedName') or '') if isinstance(src, dict) else ''
            for dev, pattern in KNOWN_DEVICES:
                if m and re.search(pattern, label, re.I):
                    hdmi[m.group(1)] = dev
                    print('   HDMI %s -> %s ("%s", cache da Samsung)' % (m.group(1), dev, label))
                    break
        break
    if hdmi:
        system['hdmi'] = hdmi
except Exception as e:
    print('aviso: não consegui ler o cache de entradas da TV: %s' % e, file=sys.stderr)

# js/apps.js (via <script>, mais robusto que fetch local em Tizen antigo)
js = '/* gerado por tools/sync-apps.sh — não edite */\nwindow.DIZEN_APPS = ' + \
     json.dumps(final, ensure_ascii=False) + ';\nwindow.DIZEN_SYSTEM = ' + \
     json.dumps(system, ensure_ascii=False) + ';\n'
with open(os.path.join(launcher, 'js', 'apps.js'), 'w') as f:
    f.write(js)

print('== %d apps curados (de %d no total), %d com ícone' % (len(final), len(apps), n_icons))
print('   -> launcher/js/apps.js + launcher/icons/')
PY

if (( PUSH )); then
  "$repo_dir/tools/push-launcher.sh" js/apps.js js/main.js js/themes.js css/style.css \
    css/themes/appletv.css css/themes/wii.css
  # envia também os ícones (podem ser novos)
  if [[ -d "$launcher_dir/icons" ]]; then
    while IFS= read -r f; do
      "$repo_dir/tools/push-launcher.sh" "icons/${f#$launcher_dir/icons/}"
    done < <(find "$launcher_dir/icons" -type f)
  fi
fi
