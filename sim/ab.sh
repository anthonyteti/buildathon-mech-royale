#!/usr/bin/env bash
# Paired practice A/B under two house-squad emulator settings. Usage: sim/ab.sh '<A json>' '<B json>' [n]
cd "$(dirname "$0")/.."
A=${1:-'{}'}; B=${2:-'{}'}; N=${3:-36}
echo "harsh:"; node sim/run.ts practice --n "$N" --seed 700 --jobs 2 --a "$A" --b "$B" 2>&1 | tail -3 | cut -c1-120
echo "mild:";  RETALIATE=60 TIER_AIM=0.08,0.05,0.03,0.015 node sim/run.ts practice --n "$N" --seed 900 --jobs 2 --a "$A" --b "$B" 2>&1 | tail -3 | cut -c1-120
