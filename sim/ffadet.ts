/** FFA detection latency in all-ours free-for-alls. node sim/ffadet.ts '<spec>' n seed0 */
import { spawn } from "node:child_process"
const spec = JSON.parse(process.argv[2] ?? "{}"), n = Number(process.argv[3] ?? 4), seed0 = Number(process.argv[4] ?? 700)
const run = (s: any) => new Promise<any>((res) => {
  const p = spawn(process.execPath, [new URL("./run.ts", import.meta.url).pathname, "--child", JSON.stringify(s)], { stdio: ["ignore", "pipe", "ignore"] })
  let buf = ""; p.stdout.on("data", (d) => (buf += d)); p.on("close", () => { try { res(JSON.parse(buf.trim().split("\n").pop()!)) } catch { res(null) } })
})
const at: number[] = []; let never = 0, diedFirst = 0
for (let i = 0; i < n; i += 2) {
  const outs = await Promise.all([0, 1].filter((k) => i + k < n).map((k) => run({ seed: seed0 + i + k, mode: "ffa", ours: Array(16).fill({ label: "A", ...spec }), maxT: 480 })))
  for (const o of outs) for (const r of o?.results ?? []) { if (r.ffaAt == null) { never++; continue } ; at.push(r.ffaAt); if (r.deathT < r.ffaAt + 0.5) diedFirst++ }
}
at.sort((a, b) => a - b)
const q = (f: number) => at[Math.floor(f * (at.length - 1))]?.toFixed(0)
console.log(`seats ${at.length + never} never ${never} ffaAt p10 ${q(0.1)} p50 ${q(0.5)} p90 ${q(0.9)}`)
