/** Shot-miss diagnostics: run duels and summarise per-shot logs (SHOTLOG=1). node sim/shots.ts '<specA>' '<specB>' n dist */
import { spawn } from "node:child_process"
process.env.SHOTLOG = "1"
const A = JSON.parse(process.argv[2] ?? "{}"), B = JSON.parse(process.argv[3] ?? "{}")
const n = Number(process.argv[4] ?? 6), dist = Number(process.argv[5] ?? 90), seed0 = Number(process.argv[6] ?? 500)
const run = (spec: any) => new Promise<any>((res) => {
  const p = spawn(process.execPath, [new URL("./run.ts", import.meta.url).pathname, "--child", JSON.stringify(spec)], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env } })
  let buf = ""; p.stdout.on("data", (d) => (buf += d)); p.on("close", () => { try { res(JSON.parse(buf.trim().split("\n").pop()!)) } catch { res(null) } })
})
const logs: Record<string, number[][]> = {}
const wins: Record<string, number> = {}
for (let i = 0; i < n; i += 2) {
  const outs = await Promise.all([0, 1].map((k) => { const pair = (i + k) % 2 === 0 ? [A, B] : [B, A]; return run({ seed: seed0 + i + k, mode: "ffa", ours: [...pair, ...Array(14).fill({ label: "A" })], maxT: 120, duel: dist }) }))
  for (const out of outs) for (const r of out?.results ?? []) {
    if (r.id > 1) continue
    ;(logs[r.label] ??= []).push(...(r.shotLog ?? []))
    if (r.place === 1) wins[r.label] = (wins[r.label] ?? 0) + 1
  }
}
for (const [lab, L] of Object.entries(logs)) {
  const hits = L.filter((s) => s[0]).length
  const miss = L.filter((s) => !s[0])
  const missSteady = miss.filter((s) => s[2] < 3).length
  const steady = L.filter((s) => s[2] < 3)
  const med = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1] ?? 0
  console.log(`${lab}: wins ${wins[lab] ?? 0} shots ${L.length} hit ${(100 * hits / L.length).toFixed(0)}% | target steady(dv<3) ${steady.length} hit ${(100 * steady.filter((s) => s[0]).length / Math.max(1, steady.length)).toFixed(0)}% | misses: steady ${missSteady} jinked ${miss.length - missSteady}, median miss ${med(miss.map((s) => s[1]))} m, median dist ${med(L.map((s) => s[3]))}, target speed med ${med(L.map((s) => s[4]))}`)
}
for (const [lab, L] of Object.entries(logs)) {
  const by: Record<string, number[]> = {}
  for (const s of L) { const k = `${s[5] || "?"}${(s[2] as number) < 3 ? ":steady" : ":jink"}`; (by[k] ??= [0, 0]); by[k][0]++; by[k][1] += s[0] as number }
  console.log(`${lab} shots by target mode: ` + Object.entries(by).sort((a, b) => b[1][0] - a[1][0]).map(([k, v]) => `${k} ${v[0]}/${Math.round(100 * v[1] / v[0])}%`).join(", "))
}
