#!/usr/bin/env bash
#
# install-plugin.sh — instala/atualiza o plugin dizen-sync do Vetro na TV.
#
# Usa a API de plugins do próprio Vetro, sem reiniciar a TV: liga o "modo
# desenvolvedor" (necessário para pacote não assinado), desliga o plugin, envia o
# pacote (/plugins/install troca a pasta e descarta o código antigo da memória),
# liga o plugin e desliga o modo desenvolvedor de novo.
#
# Na 1ª tentativa (12/11) o plugin foi copiado direto para a pasta e ligado
# editando plugins.json; depois do reinício a TV voltou com plugins.json sem a
# marca de ligado. Pela API, quem grava o estado é o próprio Vetro.
#
#   ./tools/install-plugin.sh          # instala e mostra o estado
#   ./tools/install-plugin.sh status   # só mostra o estado
#
set -uo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
push="$repo_dir/tools/push-launcher.sh"
src="$repo_dir/plugin/dizen-sync"
dir=/opt/usr/home/owner/share/vetro-plugins
dest="$dir/dizen-sync"
env_get() { grep -E "^${1}=" "$repo_dir/tools/.env" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '[:space:]'; }
base="http://$(env_get TV_IP):${VETRO_PORT:-8099}"
token="$(env_get VETRO_TOKEN)"

status() {
  curl -s -m 10 -H "Authorization: Bearer $token" "$base/plugins" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("host de plugins: modo seguro = %s" % d.get("safeMode"))
mine = [p for p in d.get("plugins", []) if p["id"] == "dizen-sync"]
if not mine:
    print("dizen-sync: ainda não carregado pelo Vetro (carrega no próximo boot da TV)")
for p in mine:
    print("dizen-sync %s: estado=%s ligado=%s erros=%s %s" % (p.get("version"), p.get("state"), p.get("enabled"), p.get("errors"), p.get("lastError") or ""))
    if p.get("detail"):
        print("  " + json.dumps(p["detail"], ensure_ascii=False))
'
}

if [[ "${1:-}" == "status" ]]; then status; exit 0; fi

api() { curl -s -m 60 -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' ${2:+--data-binary "$2"} "$base$1"; }
ok() { python3 -c 'import sys,json
d=json.loads(sys.stdin.read() or "{}")
if d.get("ok") is not True: print("   erro:", d.get("error") or d); sys.exit(1)'; }

bundle="$(python3 -c '
import json, sys, os
src = sys.argv[1]
m = json.load(open(os.path.join(src, "manifest.json")))
files = {n: open(os.path.join(src, n), encoding="utf-8").read() for n in sorted(os.listdir(src)) if n != "manifest.json"}
print(json.dumps({"format": "vetro-plugin", "version": 1, "manifest": m, "files": files}))' "$src")"

api /plugins/developer '{"on":true}' | ok || exit 1
trap 'api /plugins/developer "{\"on\":false}" >/dev/null' EXIT
api /plugins/dizen-sync/disable >/dev/null          # "Unknown plugin" na 1ª instalação: tudo bem
# O host não aguarda a Promise de stop(). Encerre o observador antes de trocar
# seu assembly; uma checagem antiga ainda pode estar terminando na fila root.
"$push" exec 'systemctl stop dizen-power.service 2>/dev/null || true' >/dev/null || exit 1
printf '%s' "$bundle" | curl -s -m 60 -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' --data-binary @- "$base/plugins/install" | ok || exit 1
echo "   ✓ pacote instalado"
api /plugins/dizen-sync/enable | ok || exit 1
echo "   ✓ plugin ligado"
sleep 8
status
