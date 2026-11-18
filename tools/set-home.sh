#!/usr/bin/env bash
#
# set-home.sh — o Dizen como tela inicial da TV (modo "custom launcher" do Vetro).
#
# Ligado: o botão Home abre o Dizen, a Home da Samsung é fechada depois de cada
# Home e o "Autorun Smart Hub" é desligado (a TV liga direto no Dizen ou na
# última entrada, não na Home da Samsung). A Home da Samsung NÃO é desinstalada
# nem desativada: o boot da TV espera por ela. Desligar desfaz tudo, inclusive o
# Autorun (o Vetro guarda o valor anterior).
#
#   ./tools/set-home.sh on       # liga
#   ./tools/set-home.sh off      # devolve o Home para a Samsung
#   ./tools/set-home.sh status
#
set -uo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
env_get() { grep -E "^${1}=" "$repo_dir/tools/.env" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '[:space:]'; }
base="http://$(env_get TV_IP):${VETRO_PORT:-8099}/plugins/launcher/api"
auth="Authorization: Bearer $(env_get VETRO_TOKEN)"
app=dizenlaunc.dizen

show() {
  python3 -c '
import sys, json
d = json.load(sys.stdin)
if d.get("ok") is False: print("erro:", d.get("error")); sys.exit(1)
print("modo: %s · app: %s · desde: %s · autorun desligado pelo Vetro: %s" % (d.get("mode"), d.get("customApp"), d.get("customSince"), d.get("autorunSwitchedOff")))
if d.get("error"): print("último erro:", d["error"])'
}
action() { curl -s -m 120 -X POST -H "$auth" -H 'Content-Type: application/json' -d "$1" "$base/action" | show; }

case "${1:-status}" in
  on)     action "{\"action\":\"enableCustom\",\"appId\":\"$app\"}" ;;
  off)    action '{"action":"disableCustom"}' ;;
  status) curl -s -m 30 -H "$auth" "$base/status" | show ;;
  *)      echo "uso: $0 on|off|status" >&2; exit 2 ;;
esac
