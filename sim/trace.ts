/** One FFA/practice match with a per-second trace of one of our bots: node sim/trace.ts <seed> '<seats json>' */
import { runMatch } from "./sim.ts"
const seed = Number(process.argv[2] ?? 1)
const ours = JSON.parse(process.argv[3] ?? "[{}]")
const mode = ours.length === 16 ? "ffa" : "practice"
const r = await runMatch({ seed, mode, ours, verbose: true })
for (const x of r.results.sort((a, b) => a.place - b.place)) console.log(x.id, x.label, x.place, x.deathT, x.cause, x.kills, x.dealt, x.taken)
