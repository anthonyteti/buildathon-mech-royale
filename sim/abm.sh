#!/usr/bin/env bash
# Paired practice A/B under the calibrated ("mild") house squad. Usage: sim/abm.sh '<A json>' '<B json>' [n] [seed]
cd "$(dirname "$0")/.."
RETALIATE=60 TIER_AIM=0.08,0.05,0.03,0.015 node sim/run.ts practice --n "${3:-48}" --seed "${4:-9000}" --jobs 2 --a "$1" --b "$2" 2>&1 | grep -E "^  [AB] |paired" | cut -c1-100
