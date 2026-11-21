/** Practice-match behaviour profile (PRACLOG=1): node sim/praclog.ts '<spec>' n seed0 jobs > out.jsonl */
import { spawn } from "node:child_process"
process.env.PRACLOG = "1"
const spec = JSON.parse(process.argv[2] ?? "{}"), n = Number(process.argv[3] ?? 8), seed0 = Number(process.argv[4] ?? 9300), jobs = Number(process.argv[5] ?? 2)
const run = (s: any) => new Promise<any>((res) => {
  const p = spawn(process.execPath, [new URL("./run.ts", import.meta.url).pathname, "--child", JSON.stringify(s)], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env } })
  let buf = ""; p.stdout.on("data", (d) => (buf += d)); p.on("close", () => { try { res(JSON.parse(buf.trim().split("\n").pop()!)) } catch { res(null) } })
})
let next = 0
async function worker() {
  while (next < n) {
    const i = next++
    const o = await run({ seed: seed0 + i, mode: "practice", ours: [spec], maxT: 480 })
    const r = o?.results.find((q: any) => q.label !== "house")
    if (r) console.log(JSON.stringify({ seed: seed0 + i, place: r.place, kills: r.kills, deathT: r.deathT, plog: r.plog }))
  }
}
await Promise.all(Array.from({ length: jobs }, worker))
