/**
 * Movement-only harness: one mech, no enemies, approximate physics (walls, step-up, jump, jet,
 * gravity, energy) and the real zone schedule. Runs the bot's act() in-process to catch navigation
 * failures (stuck, zone deaths) and slow decisions.
 *
 *   node tools/navsim.ts [episodes] [seed]
 */
import { readFileSync } from "node:fs"
import { makeBot } from "../brain.ts"
import { draw } from "../mechfight.ts"
import { GameMap } from "../map.ts"

const KIT = process.env.KIT ?? new URL("../../../mech-royale/downloads/kit/mechfight-kit", import.meta.url).pathname
const cfgAll = JSON.parse(readFileSync(new URL("../../../mech-royale/analysis/config_default.json", import.meta.url), "utf8"))
const map = new GameMap(`${KIT}/arena`, ["v2/world.json", "v2/terrain.i16"])
const M = cfgAll.mech

let seed = Number(process.argv[3] ?? 1)
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}

function solidAt(x: number, y: number, z: number, top: number) {
  // body occupies [z, top]; blocked if a column reaches above z+step or an overhang intersects
  const k = map.idx(x, y)
  if (map.top[k] > z + M.step_up) return true
  const b = map.ohBase[k]
  if (!Number.isNaN(b) && b < top && map.ohTop[k] > z + M.step_up) return true
  return false
}
function bodyBlocked(x: number, y: number, z: number) {
  if (!map.inBounds(x, y)) return true
  const r = M.radius
  for (let a = 0; a < 8; a++) {
    const px = x + Math.cos((a * Math.PI) / 4) * r * 0.9, py = y + Math.sin((a * Math.PI) / 4) * r * 0.9
    if (solidAt(px, py, z, z + M.height)) return true
  }
  return solidAt(x, y, z, z + M.height)
}

/** Highest surface under the footprint that is not above the body (roof edges hold you). */
function groundUnder(x: number, y: number, z: number) {
  let g = -1e9
  const r = M.radius * 0.9
  for (let a = -1; a < 8; a++) {
    const px = a < 0 ? x : x + Math.cos((a * Math.PI) / 4) * r, py = a < 0 ? y : y + Math.sin((a * Math.PI) / 4) * r
    const h = map.topAt(px, py)
    if (h <= z + M.step_up && h > g) g = h
  }
  return g
}

function zoneAt(t: number, centers: [number, number][]) {
  const ph = cfgAll.zone.phases
  let c = cfgAll.zone.start_center as [number, number], r = cfgAll.zone.start_radius
  let t0 = 0
  for (let i = 0; i < ph.length; i++) {
    const p = ph[i]
    const ss = t0 + p.hold_s, se = ss + p.shrink_s
    const nc = centers[i]
    if (t < se) {
      return { center: c, radius: r, next_center: nc, next_radius: p.radius, shrink_start: ss, shrink_end: se, dps: p.dps }
    }
    c = nc; r = p.radius; t0 = se
  }
  return { center: c, radius: r, next_center: c, next_radius: r, shrink_start: t0, shrink_end: t0, dps: 260 }
}

function episode(ep: number) {
  // zone centres: each next circle inside the current one
  const centers: [number, number][] = []
  let c = cfgAll.zone.start_center as [number, number], r = cfgAll.zone.start_radius
  for (const p of cfgAll.zone.phases) {
    const room = r - p.radius
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * room * 0.9
    let nc: [number, number] = [c[0] + Math.cos(a) * d, c[1] + Math.sin(a) * d]
    nc = [Math.max(map.minX + 40, Math.min(map.minX + map.nx - 40, nc[0])), Math.max(map.minY + 40, Math.min(map.minY + map.ny - 40, nc[1]))]
    centers.push(nc)
    c = nc; r = p.radius
  }
  // spawn on open ground inside 0.8 r
  let x = 0, y = 0
  for (let i = 0; i < 1000; i++) {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * 448
    x = 41.3 + Math.cos(a) * d; y = -72.8 + Math.sin(a) * d
    if (map.inBounds(x, y) && map.topAt(x, y) - map.groundAt(x, y) < 0.5 && !bodyBlocked(x, y, map.topAt(x, y))) break
  }
  let z = map.topAt(x, y)
  let vx = 0, vy = 0, vz = 0, energy = 100, hp = 1400, grounded = true, lastSpend = 0
  const hello = { type: "hello", protocol: "mechfight/1", slot: 3, seed: 1000 + ep, map: { dir: `${KIT}/arena`, files: ["v2/world.json", "v2/terrain.i16"] }, config: cfgAll } as any
  const bot = makeBot(hello)
  const times: number[] = []
  let outside = 0, zoneDmg = 0, jets = 0, maxStill = 0, still = 0
  let lastPos = [x, y]
  let tick = 0
  let action: any = {}
  let deathT = -1
  const labels = new Map<string, number>()
  for (tick = 0; tick < 20 * Number(process.env.TEND ?? 380); tick += 2) {
    const t = tick / 20
    const zone = zoneAt(t, centers)
    // instantaneous circle for damage
    const f = t <= zone.shrink_start ? 0 : t >= zone.shrink_end ? 1 : (t - zone.shrink_start) / (zone.shrink_end - zone.shrink_start)
    const cx = zone.center[0] + (zone.next_center[0] - zone.center[0]) * f, cy = zone.center[1] + (zone.next_center[1] - zone.center[1]) * f
    const cr = zone.radius + (zone.next_radius - zone.radius) * f
    const inZone = Math.hypot(x - cx, y - cy) <= cr
    const obs = {
      type: "obs", tick, t, alive: Number(process.env.ALIVE ?? 1),
      self: { id: 3, pos: [x, y, z], vel: [vx, vy, vz], aim: action.aim ?? [0, 0], hp, max_hp: 1400, energy, max_energy: 100, grounded, cubes: 0, upgrades: [], in_zone: inZone,
        weapons: [{ kind: "gun", cooldown: 0, ammo: 12, reload: 0, stats: cfgAll.weapons.gun }, null], stats: M },
      mechs: [], projectiles: [], crates: [], cubes: [], pickups: [], sounds: [], beams: [], events: [], zone, offer: null, drops: [],
    } as any
    const a0 = performance.now()
    draw.clear()
    action = bot.act(obs)
    action.debug = draw.take()
    times.push(performance.now() - a0)
    const lab = String((action.debug?.label) ?? "")
    if (process.env.TRACE === String(ep) && tick % 2 === 0) console.log(`t=${t.toFixed(1)} pos=${[x, y, z].map((v) => v.toFixed(1))} v=${[vx, vy, vz].map((v) => v.toFixed(1))} g=${grounded ? 1 : 0} en=${energy.toFixed(0)} hp=${hp.toFixed(0)} in=${inZone ? 1 : 0} mv=${(action.move ?? []).map((v: number) => v.toFixed(2))} j=${action.jump ? 1 : 0} b=${action.boost ? 1 : 0} | ${lab}`)
    for (let s = 0; s < 2; s++) {
      const dt = 0.05
      const mv = action.move ?? [0, 0]
      const ml = Math.min(1, Math.hypot(mv[0], mv[1]))
      const mdir = Math.hypot(mv[0], mv[1]) > 1e-6 ? [mv[0] / Math.hypot(mv[0], mv[1]), mv[1] / Math.hypot(mv[0], mv[1])] : [0, 0]
      let spd = M.walk_speed * ml
      let spent = false
      if (action.boost && grounded && ml > 0.1 && energy > 0) { spd = M.boost_speed * ml; energy -= M.boost_drain * dt; spent = true }
      const dvx = mdir[0] * spd - vx, dvy = mdir[1] * spd - vy
      const acc = (grounded ? M.ground_accel : M.air_accel) * dt
      const dl = Math.hypot(dvx, dvy)
      if (dl > acc) { vx += (dvx / dl) * acc; vy += (dvy / dl) * acc } else { vx += dvx; vy += dvy }
      if (action.jump && grounded && s === 0) { vz = M.jump_speed; grounded = false }
      if (action.boost && !grounded && energy > 0) { vz = Math.min(M.max_rise_speed, vz + M.jet_accel * dt); energy -= M.jet_drain * dt; spent = true; jets++ }
      vz -= M.gravity * dt
      if (spent) lastSpend = t
      else if (t - lastSpend > M.energy_regen_delay) energy = Math.min(100, energy + M.energy_regen * dt)
      energy = Math.max(0, energy)
      // horizontal with sliding
      const nx = x + vx * dt, ny = y + vy * dt
      if (bodyBlocked(x, y, z) || !bodyBlocked(nx, ny, z)) { x = nx; y = ny }
      else if (!bodyBlocked(nx, y, z)) { x = nx; vy = 0 }
      else if (!bodyBlocked(x, ny, z)) { y = ny; vx = 0 }
      else { vx = 0; vy = 0 }
      // vertical
      const g = groundUnder(x, y, z)
      let nz = z + vz * dt
      const k = map.idx(x, y)
      const ob = map.ohBase[k]
      if (!Number.isNaN(ob) && z + M.height <= ob && nz + M.height > ob) { nz = ob - M.height; vz = Math.min(0, vz) }
      if (nz <= g) { nz = g; vz = 0; grounded = true }
      else if (grounded && nz - g < 0.3 && vz <= 0) { nz = g; vz = 0 }
      else grounded = false
      if (g > z && g - z <= M.step_up && grounded) nz = g
      z = nz
    }
    if (!inZone) { outside += 0.1; zoneDmg += zone.dps * 0.1; hp -= zone.dps * 0.1 }
    else if (t > 5) hp = Math.min(1400, hp + 4.5)
    const moved = Math.hypot(x - lastPos[0], y - lastPos[1])
    const wants = Math.hypot(...((action.move ?? [0, 0]) as [number, number])) > 0.3
    if (wants && moved < 0.05) { still += 0.1; maxStill = Math.max(maxStill, still) } else still = 0
    lastPos = [x, y]
    const key = lab.split(" ")[0] + " " + (lab.split(" ")[1] ?? "")
    labels.set(key, (labels.get(key) ?? 0) + 1)
    if (hp <= 0) { deathT = t; break }
  }
  times.sort((a, b) => a - b)
  const st = /st (\d+)/.exec(String(action.debug?.label ?? ""))
  console.log(`ep ${ep}: ${deathT >= 0 ? `DIED t=${deathT.toFixed(0)}` : "alive"} outside ${outside.toFixed(1)}s zoneDmg ${zoneDmg.toFixed(0)} stucks ${st ? st[1] : "?"} maxStill ${maxStill.toFixed(1)}s jets ${jets} final ${[x, y, z].map((v) => v.toFixed(0))} centre ${centers[centers.length - 1].map((v) => v.toFixed(0))} | act p50 ${times[times.length >> 1].toFixed(2)} p99 ${times[Math.floor(times.length * 0.99)].toFixed(2)} max ${times[times.length - 1].toFixed(2)} ms`)
  return { died: deathT >= 0, outside }
}

const n = Number(process.argv[2] ?? 6)
let deaths = 0, out = 0
for (let ep = 0; ep < n; ep++) {
  const r = episode(ep)
  if (r.died) deaths++
  out += r.outside
}
console.log(`episodes ${n} deaths ${deaths} mean outside ${(out / n).toFixed(1)}s`)
