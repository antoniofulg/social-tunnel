#!/bin/sh
set -eu
# Build artifacts only. This script never stages a policy or installs a service.
case ${1:-} in bun-linux-x64|bun-linux-arm64) target=$1 ;; *) echo 'supply bun-linux-x64 or bun-linux-arm64' >&2; exit 2 ;; esac
[ "$#" = 2 ] && [ -d "$2" ] || exit 2
out=$(cd -- "$2" && pwd -P)
repo=$(cd -- "$(dirname -- "$0")/../.." && pwd -P)
cd -- "$repo"
for tool in supervisor command direct-witness; do
  case $tool in supervisor) entry=domain-linux-supervisor ;; *) entry=domain-$tool ;; esac
  bun build --compile --target="$target" "server/$entry.ts" --outfile "$out/st-domains-$tool"
done
