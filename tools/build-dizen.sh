#!/usr/bin/env bash
#
# build-dizen.sh — empacota, assina e INSTALA o launcher Dizen na TV (reinstalação
# completa). Use quando mudar config.xml (privilégios/access) ou icon.png — coisas
# que afetam o manifesto e que o push-launcher.sh não cobre.
#
# Caminho que funciona com a TV rooteada (Host PC IP = 127.0.0.1, sem sdb do PC):
#   1. empacota (zip)
#   2. assina com o apps2samsung-cli (cert Partner, sem tocar na TV)
#   3. sobe o .wgt assinado via /exec (root) e instala com o Vetro (vd_appinstall)
#
# Uso:
#   ./tools/build-dizen.sh [TV_IP] [--partner|--public]
#
# Requer: zip, python3, curl, apps2samsung-cli e TV rooteada (Vetro) pareada
# (tools/.env com VETRO_TOKEN).
#
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
launcher_dir="$repo_dir/launcher"
env_file="$repo_dir/tools/.env"

env_get() { grep -E "^${1}=" "$env_file" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '[:space:]'; }

TV_IP="$(env_get TV_IP)"
PORT="${VETRO_PORT:-8099}"
TOKEN="${VETRO_TOKEN:-$(env_get VETRO_TOKEN)}"
PARTNER_FLAG="--partner"  # mesmo certificado autor da versão instalada
for arg in "$@"; do
  case "$arg" in
    --partner) ;;
    --public) PARTNER_FLAG="" ;;
    *) TV_IP="$arg" ;;
  esac
done

[[ -n "$TV_IP" ]] || { echo "Uso: $0 [TV_IP] [--partner|--public]" >&2; exit 2; }
[[ -n "$TOKEN" ]] || { echo "sem VETRO_TOKEN. Rode: ./tools/push-launcher.sh pair" >&2; exit 2; }

# Descobre o apps2samsung-cli (só pra assinar)
# (APPS2SAMSUNG_CLI no ambiente ou em tools/.env, senão o do PATH)
CLI="${APPS2SAMSUNG_CLI:-$(env_get APPS2SAMSUNG_CLI)}"
[[ -n "$CLI" ]] || CLI="$(command -v apps2samsung-cli 2>/dev/null || true)"
[[ -z "$CLI" || ! -x "$CLI" ]] && { echo "apps2samsung-cli não encontrado (preciso dele pra assinar)." >&2; exit 2; }

OUT="${TMPDIR:-/tmp}/dizen.wgt"
SIGNED="${TMPDIR:-/tmp}/dizen-signed.wgt"

echo "== launcher: $launcher_dir"
echo "== validando config.xml"
python3 -c 'import xml.dom.minidom; xml.dom.minidom.parse("'$launcher_dir'/config.xml")'

# Garante que o package id tem 10 caracteres
PKG="$(grep -o 'package="[^"]*"' "$launcher_dir/config.xml" | head -1 | sed 's/.*="//;s/"//')"
if [[ ${#PKG} -ne 10 ]]; then
  echo "ERRO: package id '$PKG' tem ${#PKG} caracteres; Tizen exige exatamente 10." >&2
  exit 1
fi
echo "== package id: $PKG (10 chars ✓)"

cd "$launcher_dir"
echo "== empacotando $OUT"
rm -f "$OUT" "$SIGNED"
zip -q -r -D "$OUT" config.xml index.html css js icon.png
[[ -d icons ]] && zip -q -r -D "$OUT" icons
[[ -d audio ]] && zip -q -r -D "$OUT" audio

echo "== assinando (Partner, DUID da TV)"
"$CLI" sign "$OUT" -o "$SIGNED" --tv "$TV_IP" $PARTNER_FLAG >/dev/null

# ── sobe o .wgt assinado via /exec (em fatias) e instala ────────────────────
BASE="http://${TV_IP}:${PORT}"
exec_cmd() {
  local resp code
  resp="$(curl -s -m 90 -X POST "$BASE/exec" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,sys;print(json.dumps({"cmd":sys.argv[1]}))' "$1")")"
  code="$(printf '%s' "$resp" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("exit_code",""))' 2>/dev/null)"
  [[ "$code" == "0" ]] || { echo "erro no exec: $resp" >&2; return 1; }
}

echo "== subindo $SIGNED pra TV"
b64="$(base64 -w0 "$SIGNED")"
exec_cmd "> /tmp/dizen-signed.wgt"
offset=0; sz=50000
while [[ $offset -lt ${#b64} ]]; do
  chunk="${b64:$offset:$sz}"
  exec_cmd "printf '%s' '$chunk' | base64 -d >> /tmp/dizen-signed.wgt"
  offset=$((offset + sz))
done

echo "== instalando (vd_appinstall via Vetro)"
resp="$(curl -s -m 150 -X POST "$BASE/install" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"path":"/tmp/dizen-signed.wgt"}')"
printf '%s\n' "$resp" | python3 -c 'import sys,json;
d=json.load(sys.stdin)
print("   packageId:", d.get("packageId"))
print("   submitted:", d.get("submitted"))
print("   ", (d.get("output") or d.get("error") or "").strip().splitlines()[-1] if (d.get("output") or d.get("error")) else "")
if d.get("submitted") is not True: sys.exit(1)'

# O Vetro só confirma o envio ao gerenciador, que pode recusar o pacote depois.
expected_sha="$(sha256sum "$launcher_dir/config.xml" | cut -d' ' -f1)"
installed_sha=""
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  installed_sha="$(curl -s -m 15 -X POST "$BASE/exec" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,sys;print(json.dumps({"cmd":"sha256sum /opt/usr/apps/"+sys.argv[1]+"/res/wgt/config.xml"}))' "$PKG")" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("output","").split(" ")[0])' 2>/dev/null || true)"
  [[ "$installed_sha" == "$expected_sha" ]] && break
  sleep 2
done
[[ "$installed_sha" == "$expected_sha" ]] || { echo "erro: atualização não confirmada na TV (verifique certificado de autor)" >&2; exit 1; }
echo "== manifesto instalado verificado"

# O webappservice pode manter a cópia por appId de uma instalação anterior,
# mesmo atualizando a cópia por packageId. Preserve dono/SMACK ao sobrescrever.
exec_cmd "if [ -f /opt/share/webappservice/apps_icon/all/$PKG.dizen/icon.png ]; then cat /opt/usr/apps/$PKG/res/wgt/icon.png > /opt/share/webappservice/apps_icon/all/$PKG.dizen/icon.png; fi"

# relança o app (a reinstalação derruba o processo)
echo "== relançando"
exec_cmd "/usr/bin/app_launcher -k $PKG.dizen" || true
exec_cmd "/usr/bin/app_launcher -s $PKG.dizen" || true
echo "== pronto. Abra o Dizen na TV (botão Home)."
