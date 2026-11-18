#!/usr/bin/env bash
#
# push-launcher.sh — atualiza o launcher Dizen na TV SEM reinstalar o .wgt.
#
# Usa a API HTTP do Vetro (dashboard em :8099). O root agent do Vetro executa
# comandos como uid 0 na TV, então dá pra gravar os arquivos do launcher direto
# na cópia instalada e relançar o app — tudo por cima do `/exec`, sem sdb e sem
# mexer no Host PC IP.
#
# Uso:
#   ./tools/push-launcher.sh pair                     # pareia uma vez (grava token no .env)
#   ./tools/push-launcher.sh status                   # root agent conectado?
#   ./tools/push-launcher.sh                          # envia tudo e relança
#   ./tools/push-launcher.sh --watch                  # reenvia a cada save (inotify-tools)
#   ./tools/push-launcher.sh css/themes/wii.css       # só um arquivo (rel. a launcher/)
#   ./tools/push-launcher.sh exec 'ls -la /opt/usr/apps'   # comando avulso como root
#
# Requer: curl, python3 e a TV rooteada (Vetro instalado). Pareie uma vez com
# `pair` (abra o app Vetro na TV pra ver o código de 6 dígitos).
#
# Atenção: só arquivos de CONTEÚDO (html/css/js) são enviados aqui. Mudanças em
# `config.xml` (privilégios, access origin, versão) ou no `icon.png` afetam o
# manifesto/instalação e precisam de reinstalação completa: tools/build-dizen.sh.
#
set -uo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
launcher_dir="$repo_dir/launcher"
env_file="$repo_dir/tools/.env"
PORT="${VETRO_PORT:-8099}"

# ── .env ────────────────────────────────────────────────────────────────────
env_get() { grep -E "^${1}=" "$env_file" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '[:space:]'; }
env_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  touch "$env_file"
  grep -vE "^${key}=" "$env_file" > "$tmp" 2>/dev/null || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$env_file"
}

TV_IP="${TV_IP:-$(env_get TV_IP)}"
TOKEN="${VETRO_TOKEN:-$(env_get VETRO_TOKEN)}"
PKG="$(grep -o 'package="[^"]*"' "$launcher_dir/config.xml" | head -1 | sed 's/.*="//;s/"//')"
APP_ID="$(grep -o '<tizen:application id="[^"]*"' "$launcher_dir/config.xml" | head -1 | sed 's/.*id="//;s/"//')"
[[ -z "$APP_ID" ]] && APP_ID="$PKG"

BASE="http://${TV_IP}:${PORT}"

# ── helpers JSON ────────────────────────────────────────────────────────────
jget() { python3 -c 'import sys,json;
d=json.load(sys.stdin)
for k in sys.argv[1:]:
    if isinstance(d,dict): d=d.get(k)
    else: d=None
print("" if d is None else d)' "$@"; }

# ── HTTP ────────────────────────────────────────────────────────────────────
api() { # method path [json-body]
  curl -s -m 45 -X "$1" "$BASE$2" \
    -H "Authorization: Bearer ${TOKEN:-}" \
    -H "Content-Type: application/json" \
    ${3:+--data "$3"}
}

die() { echo "erro: $*" >&2; exit 1; }

require() {
  [[ -n "$TV_IP" ]] || die "TV_IP ausente. Rode: ./tools/push-launcher.sh pair"
  [[ -n "$TOKEN" ]] || die "sem token. Pareie antes: ./tools/push-launcher.sh pair"
}

# ── pair ────────────────────────────────────────────────────────────────────
pair() {
  [[ -n "$TV_IP" ]] || { read -rp "IP da TV: " TV_IP; env_set TV_IP "$TV_IP"; }
  echo "== pedindo código de pareamento (abra o app Vetro na TV pra ver o código)"
  local resp id code confirm token
  resp="$(curl -s -m 10 -X POST "$BASE/auth/pair" -H 'Content-Type: application/json' -d '{"name":"dizen-push"}')"
  id="$(printf '%s' "$resp" | jget id)"
  [[ -n "$id" ]] || die "não consegui iniciar o pareamento: $resp"
  echo "   um código de 6 dígitos deve aparecer na TV (expira em ~2 min)."
  read -rsp "   código na TV: " code; echo
  confirm="$(curl -s -m 10 -X POST "$BASE/auth/confirm" -H 'Content-Type: application/json' -d "{\"id\":\"$id\",\"code\":\"$code\"}")"
  token="$(printf '%s' "$confirm" | jget token)"
  [[ -n "$token" ]] || die "pareamento falhou: $confirm"
  env_set VETRO_TOKEN "$token"
  echo "== ✓ token salvo em tools/.env"
}

# ── exec ────────────────────────────────────────────────────────────────────
do_exec() { # cmd -> imprime output, retorna exit_code
  local resp
  resp="$(api POST /exec "{\"cmd\":$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$1")}")"
  local code out err
  code="$(printf '%s' "$resp" | jget exit_code)"
  out="$(printf '%s' "$resp" | jget output)"
  err="$(printf '%s' "$resp" | jget stderr)"
  [[ -n "$out" ]] && printf '%s\n' "$out"
  [[ -n "$err" ]] && printf '%s\n' "$err" >&2
  if [[ "$code" == "" ]]; then
    printf '   (sem exit_code — resposta: %s)\n' "$resp" >&2
    return 1
  fi
  return "$code"
}

# ── status ──────────────────────────────────────────────────────────────────
status() {
  require
  api GET /exec
  echo
}

# ── descobre a cópia instalada ──────────────────────────────────────────────
discover_root() {
  local d="/opt/usr/apps/$PKG/res/wgt"
  if do_exec "test -f '$d/index.html'" >/dev/null 2>&1; then
    echo "$d"
    return 0
  fi
  do_exec "find /opt/usr/apps/$PKG -name index.html 2>/dev/null | head -1" 2>/dev/null | sed 's|/index.html$||'
}

# ── envia um arquivo (base64 → grava em cima do existente) ──────────────────
send_file() {
  local local_path="$1" remote_path="$2" b64 chunk offset=0
  # garante que o diretório existe (importa p/ temas novos em css/themes/)
  do_exec "mkdir -p '$(dirname "$remote_path")'" >/dev/null 2>&1 || true
  b64="$(base64 -w0 "$local_path")"
  # grava o conteúdo DENTRO do arquivo existente (preserva dono/perm/rótulo SMACK).
  # O /exec limita o comando a ~64 KB, então arquivos grandes (ícones) vão em
  # fatias de base64 decodificadas e anexadas — cada fatia é múltiplo de 4, então
  # decodifica sozinha e o append reconstrói os bytes exatos.
  do_exec "> '$remote_path'" >/dev/null 2>&1 || true
  local chunk_size=20000   # múltiplo de 4; cabe folgado no limite do /exec
  while [[ $offset -lt ${#b64} ]]; do
    chunk="${b64:$offset:$chunk_size}"
    if ! do_exec "printf '%s' '$chunk' | base64 -d >> '$remote_path'" >/dev/null 2>&1; then
      echo "   ✗ falha ao enviar $local_path" >&2
      return 1
    fi
    offset=$((offset + chunk_size))
  done
  echo "   ✓ $remote_path"
}

# ── relança ─────────────────────────────────────────────────────────────────
relaunch() {
  # DIZEN_NO_RELAUNCH=1: só grava os arquivos (tools/sync-daily.sh decide o relançamento)
  [[ -n "${DIZEN_NO_RELAUNCH:-}" ]] && return 0
  do_exec "/usr/bin/app_launcher -k $APP_ID" >/dev/null 2>&1 || true
  do_exec "/usr/bin/app_launcher -s $APP_ID" >/dev/null 2>&1 || true
}

# ── ação principal ──────────────────────────────────────────────────────────
push_files() {
  local root f rel remote
  root="$(discover_root)"
  if [[ -z "$root" ]]; then
    echo "não achei os arquivos do Dizen na TV. Rode:" >&2
    echo "  ./tools/push-launcher.sh exec \"find /opt/usr -maxdepth 5 -name index.html | grep -i dizen\"" >&2
    return 1
  fi
  echo "== cópia instalada: $root"
  for f in "${FILES[@]}"; do
    case "$f" in
      config.xml|icon.png)
        echo "   ⚠ $f: afeta o manifesto/instalação — use tools/build-dizen.sh, não este script." >&2
        continue ;;
    esac
    local_path="$launcher_dir/$f"
    [[ -f "$local_path" ]] || { echo "   (ignorando $f — não existe)" >&2; continue; }
    rel="${f#./}"
    send_file "$local_path" "$root/$rel" || return 1
  done
  echo "== relançando $APP_ID"
  relaunch
}

# ── parse de argumentos ─────────────────────────────────────────────────────
CMD=""
FILES=()
WATCH=0
while (($#)); do
  case "$1" in
    pair|status|exec) CMD="$1"; shift ;;
    --watch) WATCH=1; shift ;;
    --port) PORT="${2:?--port precisa de valor}"; shift 2 ;;
    -h|--help) sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) FILES+=("$1"); shift ;;
  esac
done

case "$CMD" in
  pair) pair; exit 0 ;;
  status) status; exit 0 ;;
  exec)
    require
    do_exec "${FILES[*]:-true}"   # FILES guarda o comando (sem aspas)
    exit $?
    ;;
esac

require

# arquivos a enviar (texto; icon.png é ignorado)
if ((${#FILES[@]} == 0)); then
  FILES=(config.xml index.html)
  while IFS= read -r f; do FILES+=("$f"); done < <(cd "$launcher_dir" && find css js icons -type f | sort)
fi

if ((WATCH)); then
  command -v inotifywait >/dev/null 2>&1 || die "inotifywait não encontrado (instale inotify-tools)"
  echo "== assistindo $launcher_dir (Ctrl-C p/ sair)"
  while true; do
    inotifywait -q -r -e close_write,moved_to,create \
      --exclude '\.(wgt|tmp|swp|swx|png)$' "$launcher_dir" >/dev/null 2>&1 || true
    sleep 0.3
    push_files
  done
else
  push_files
fi
