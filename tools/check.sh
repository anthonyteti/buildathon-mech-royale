#!/usr/bin/env bash
# Conformance check: native (node) and in the match sandbox (linux/amd64 docker image).
# Usage: tools/check.sh [native|docker|all]  (KIT=path to mechfight-kit)
set -euo pipefail
cd "$(dirname "$0")/.."
KIT=${KIT:-../../mech-royale/downloads/kit/mechfight-kit}
MODE=${1:-all}
IMG=${IMG:-teti-mech-bot:dev}
if [[ $MODE == native || $MODE == all ]]; then
  python3 "$KIT/check/check.py" -- node bot.ts
fi
if [[ $MODE == docker || $MODE == all ]]; then
  docker build --platform linux/amd64 -q -t "$IMG" . >/dev/null
  python3 "$KIT/check/check.py" --map-dir /arena -- docker run --rm -i --platform linux/amd64 --network none --cpus 1 --memory 512m --read-only --tmpfs /tmp:rw,size=64m --user 65534:65534 -v "$(cd "$KIT" && pwd)/arena:/arena:ro" "$IMG"
fi
