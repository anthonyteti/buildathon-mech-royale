/** Dump duel trajectories (TRAJLOG=1) as JSON lines: node sim/traj.ts '<specA>' '<specB>' n dist seed0 */
import { spawn } from "node:child_process"
process.env.TRAJLOG = "1"
const A = JSON.parse(process.argv[2]), B = JSON.parse(process.argv[3]), n = Number(process.argv[4] ?? 8), dist = Number(process.argv[5] ?? 100), seed0 = Number(process.argv[6] ?? 800)
const run = (spec: any) => new Promise<any>((res) => {
  const p = spawn(process.execPath, [new URL("./run.ts", import.meta.url).pathname, "--child", JSON.stringify(spec)], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env } })
  let buf = ""; p.stdout.on("data", (d) => (buf += d)); p.on("close", () => { try { res(JSON.parse(buf.trim().split("\n").pop()!)) } catch { res(null) } })
})
for (let i = 0; i < n; i += 2) {
  const outs = await Promise.all([0, 1].map((k) => run({ seed: seed0 + i + k, mode: "ffa", ours: [A, B, ...Array(14).fill({ label: "A" })], maxT: 120, duel: dist })))
  for (const o of outs) if (o) console.log(JSON.stringify(o.results.filter((r: any) => r.id < 2).map((r: any) => ({ label: r.label, traj: r.traj }))))
}
