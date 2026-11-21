/** How often and when the FFA detector fires in practice-mode matches. node sim/ffacheck.ts '<spec>' n seed0 */
import { spawn } from "node:child_process"
const spec = JSON.parse(process.argv[2] ?? "{}"), n = Number(process.argv[3] ?? 12), seed0 = Number(process.argv[4] ?? 900)
const run = (s: any) => new Promise<any>((res) => {
  const p = spawn(process.execPath, [new URL("./run.ts", import.meta.url).pathname, "--child", JSON.stringify(s)], { stdio: ["ignore", "pipe", "ignore"] })
  let buf = ""; p.stdout.on("data", (d) => (buf += d)); p.on("close", () => { try { res(JSON.parse(buf.trim().split("\n").pop()!)) } catch { res(null) } })
})
const rows: string[] = []
let trig = 0, score = 0, m = 0
for (let i = 0; i < n; i += 2) {
  const outs = await Promise.all([0, 1].filter((k) => i + k < n).map((k) => run({ seed: seed0 + i + k, mode: "practice", ours: [{ label: "A", ...spec }], maxT: 480 })))
  for (const [j, o] of outs.entries()) {
    if (o) o.seed = seed0 + i + j
    const r = o?.results.find((q: any) => q.label === "A"); if (!r) continue
    m++; score += 16 - r.place; if (r.ffaAt != null) trig++
    rows.push(`seed ${o.seed ?? "?"} place ${r.place} kills ${r.kills} death ${r.deathT} ffaAt ${r.ffaAt}`)
  }
}
console.log(rows.join("\n"))
console.log(`matches ${m} mean score ${(score / m).toFixed(2)} ffa triggered ${trig}`)
