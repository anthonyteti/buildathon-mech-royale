#!/usr/bin/env python3
"""Feed the kit's recorded stream to the bot one observation at a time and print a summary of each action.
Usage: tools/replay.py [--every N] -- <bot command...>"""
import gzip, json, os, subprocess, sys, time
KIT = os.environ.get("KIT", os.path.join(os.path.dirname(__file__), "../../../mech-royale/downloads/kit/mechfight-kit"))
KIT = os.path.abspath(KIT)
args = sys.argv[1:]
every = 1
if args and args[0] == "--every":
    every = int(args[1]); args = args[2:]
if args and args[0] == "--": args = args[1:]
cmd = args or ["node", "bot.ts"]
p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
lines = gzip.open(os.path.join(KIT, "check/stream.jsonl.gz"), "rt").read().splitlines()
times = []
for i, l in enumerate(lines):
    m = json.loads(l)
    if m["type"] == "hello":
        m["map"]["dir"] = os.path.join(KIT, "arena")
    p.stdin.write(json.dumps(m) + "\n"); p.stdin.flush()
    if m["type"] == "end":
        break
    t0 = time.perf_counter()
    out = json.loads(p.stdout.readline())
    times.append((time.perf_counter() - t0) * 1000)
    if m["type"] != "obs":
        print("ready", out, f"{times[-1]:.0f} ms"); continue
    s = m["self"]
    vis = [(x["id"], x["kind"][0], round(((x["pos"][0]-s["pos"][0])**2+(x["pos"][1]-s["pos"][1])**2)**.5)) for x in m["mechs"]]
    if i % every == 0 or any(out.get("fire") or []):
        lab = (out.get("debug") or {}).get("label")
        print(f"t={m['t']:5.1f} pos={[round(v) for v in s['pos']]} hp={s['hp']:.0f} en={s['energy']:.0f} aim={[round(v,2) for v in s['aim']]} | mv={[round(v,2) for v in out.get('move',[])]} b={int(bool(out.get('boost')))} j={int(bool(out.get('jump')))} aim={[round(v,2) for v in out.get('aim',[])]} fire={out.get('fire')} take={out.get('take')} {lab} vis={vis}")
p.wait(timeout=5)
times = sorted(times[1:])
print(f"answers {len(times)}  p50 {times[len(times)//2]:.2f} ms  p99 {times[int(len(times)*.99)]:.2f}  max {times[-1]:.2f}")
