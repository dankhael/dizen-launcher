#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
simulator_dir="${TIZEN_SIMULATOR_DIR:-$HOME/tizen-studio/tools/sec-tv-simulator}"

if [[ ! -x "$simulator_dir/simulator" ]]; then
  printf 'TV Simulator não encontrado em %s\n' "$simulator_dir" >&2
  exit 1
fi

cd -- "$simulator_dir"
exec ./simulator "--file=$repo_dir/launcher/index.html?preview=1"
