#!/usr/bin/env bash
# Build on the PC; TV uses its existing .NET 3.1 runtime. DOTNET may name an SDK.
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT
"${DOTNET:-dotnet}" build "$repo_dir/tools/power-monitor/PowerMonitor.csproj" -c Release -o "$build_dir" --nologo
base64 -w0 "$build_dir/DizenPower.dll" > "$repo_dir/plugin/dizen-sync/DizenPower.b64"
cp "$build_dir/DizenPower.runtimeconfig.json" "$repo_dir/plugin/dizen-sync/DizenPower.runtimeconfig.json"
node "$repo_dir/tools/check-power.cjs"
