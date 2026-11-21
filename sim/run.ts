/**
 * Tournament runner for sim-lite.
 *
 *   node sim/run.ts practice --n 24 --a '{}' --b '{"coverFight":false}'
 *   node sim/run.ts ffa --n 16 --a '{}' --b '{"chaseAlways":true}' [--house 0]
 *
 * practice: each variant plays the same seeds as our single bot against 15 house bots.
 * ffa: every match seats variant A and B (and optionally house bots) in alternating slots.
 * Runs matches in up to --jobs child processes (default 3). Prints mean score (16 - place) per variant.
 */
import { spawn } from "node:child_process"

const args = process.argv.slice(2)
const flag = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : def
}

if (args[0] === "--child") {
  const { runMatch } = await import("./sim.ts")
  const spec = JSON.parse(args[1])
  const out = runMatch(spec)
  process.stdout.write(JSON.stringify(out) + "\n")
  process.exit(0)
}

const mode = (args[0] ?? "practice") as "practice" | "ffa"
const n = Number(flag("n", "12"))
const seed0 = Number(flag("seed", "1"))
const jobs = Number(flag("jobs", "3"))
const A = { label: "A", ...JSON.parse(flag("a", "{}")) }
const Bs = flag("b", "")
const B = Bs ? { label: "B", ...JSON.parse(Bs) } : null
const houseN = Number(flag("house", "0"))
const maxT = Number(flag("maxT", "480"))

type Job = { spec: any; tag: string }
const queue: Job[] = []
for (let i = 0; i < n; i++) {
  const seed = seed0 + i
  if (mode === "practice") {
    queue.push({ tag: "A", spec: { seed, mode, ours: [A], maxT } })
    if (B) queue.push({ tag: "B", spec: { seed, mode, ours: [B], maxT } })
  } else {
    const ours: any[] = []
    for (let s = 0; s < 16; s++) {
      if (s < houseN) { ours.push(null); continue }
      const k = (s + i) % 2
      ours.push(!B || k === 0 ? A : B)
    }
    // shuffle seats deterministically per match
    for (let s = 15; s > 0; s--) { const j = (seed * 7 + s * 13) % (s + 1); [ours[s], ours[j]] = [ours[j], ours[s]] }
    queue.push({ tag: "ffa", spec: { seed, mode, ours, maxT } })
  }
}

function runChild(job: Job): Promise<any> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [new URL("./run.ts", import.meta.url).pathname, "--child", JSON.stringify(job.spec)], { stdio: ["ignore", "pipe", "inherit"] })
    let buf = ""
    p.stdout.on("data", (d) => (buf += d))
    p.on("close", () => {
      try { resolve({ job, out: JSON.parse(buf.trim().split("\n").pop()!) }) } catch { resolve({ job, out: null }) }
    })
  })
}

const t0 = Date.now()
const results: any[] = []
let next = 0
async function worker() {
  while (next < queue.length) {
    const job = queue[next++]
    results.push(await runChild(job))
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker))

const agg = new Map<string, { score: number[]; kills: number[]; death: number[]; cubes: number[]; causes: Map<string, number>; shots: number; hits: number; dealt: number[]; taken: number[]; drops: number }>()
const add = (label: string, r: any) => {
  if (!agg.has(label)) agg.set(label, { score: [], kills: [], death: [], cubes: [], causes: new Map(), shots: 0, hits: 0, dealt: [], taken: [], drops: 0 })
  const a = agg.get(label)!
  a.drops += r.drops ?? 0; a.shots += r.shots ?? 0; a.hits += r.hits ?? 0; a.dealt.push(r.dealt ?? 0); a.taken.push(r.taken ?? 0)
  a.score.push(16 - r.place); a.kills.push(r.kills); a.death.push(r.deathT); a.cubes.push(r.cubes)
  const c = String(r.cause).replace(/:.*/, "")
  a.causes.set(c, (a.causes.get(c) ?? 0) + 1)
}
let failed = 0
for (const { job, out } of results) {
  if (!out) { failed++; continue }
  for (const r of out.results) {
    if (r.label === "house") { add("house", r); continue }
    add(r.label, r)
  }
  void job
}
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length)
const se = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1) / Math.max(1, a.length)) }
console.log(`${mode}: ${n} matches in ${((Date.now() - t0) / 1000).toFixed(0)} s${failed ? `, ${failed} failed` : ""}`)
for (const [label, a] of agg) {
  console.log(`  ${label.padEnd(6)} score ${mean(a.score).toFixed(2)} ± ${se(a.score).toFixed(2)}  kills ${mean(a.kills).toFixed(2)}  death t ${mean(a.death).toFixed(0)}  cubes ${mean(a.cubes).toFixed(1)}  gun hit ${(a.hits / Math.max(1, a.shots) * 100).toFixed(0)}% dealt ${mean(a.dealt).toFixed(0)} taken ${mean(a.taken).toFixed(0)} drops ${(a.drops / Math.max(1, a.score.length)).toFixed(2)}  causes ${[...a.causes].map(([k, v]) => `${k}:${v}`).join(" ")}`)
}
if (mode === "practice" && B) {
  // paired difference on the same seeds
  const byTag = (tag: string) => results.filter((r) => r.job.tag === tag && r.out).map((r) => ({ seed: r.job.spec.seed, s: 16 - r.out.results.find((x: any) => x.label === tag).place }))
  const a = byTag("A"), b = byTag("B")
  const d = a.map((x) => { const y = b.find((q) => q.seed === x.seed); return y ? y.s - x.s : 0 })
  console.log(`  paired B-A ${mean(d).toFixed(2)} ± ${se(d).toFixed(2)}`)
}
