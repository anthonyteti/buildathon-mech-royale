/**
 * sim-lite: an approximate headless match simulator for local A/B tests.
 * Movement, weapons (gun, laser, lightning, mortar), vision, sounds, zone, loot, crates, NPC drones,
 * cubes, upgrades and supply drops follow protocol.md closely but not exactly. Only relative
 * comparisons between bot variants are meaningful; confirm winners on the practice server.
 *
 * Bots are either our brain (makeBot) or a built-in "house" bot that emulates the practice squad.
 */
import { readFileSync } from "node:fs"
import { makeBot, type PARAMS } from "../brain.ts"
import { GameMap } from "../map.ts"
import { draw } from "../mechfight.ts"
import { ExtBot, extSpec } from "./ext.ts"

type V3 = [number, number, number]
type WK = "gun" | "mortar" | "laser" | "lightning"

const HERE = new URL(".", import.meta.url).pathname
export const KIT = process.env.KIT ?? `${HERE}../../../mech-royale/downloads/kit/mechfight-kit`
export const CFG = JSON.parse(readFileSync(process.env.CFG ?? `${HERE}../../../mech-royale/analysis/config_default.json`, "utf8"))
const MAP = new GameMap(`${KIT}/arena`, ["v2/world.json", "v2/terrain.i16"])

const TAU = Math.PI * 2
const wrap = (a: number) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI }
const hyp = (ax: number, ay: number, bx: number, by: number) => Math.hypot(bx - ax, by - ay)
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o))

class Rng {
  s: number
  constructor(seed: number) { this.s = (seed >>> 0) || 7 }
  next() { let x = this.s; x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; this.s = x; return x / 4294967296 }
  gauss() { const u = Math.max(1e-9, this.next()), v = this.next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v) }
  pick<T>(a: T[]): T { return a[Math.floor(this.next() * a.length)] }
}

type Weapon = { kind: WK; cooldown: number; ammo: number; reload: number; charge: number; held: number; equip: number }
type Controller = { kind: "ours"; act: (obs: any) => any; label: string } | { kind: "house"; tier: number; label: string } | { kind: "ext"; bot: ExtBot; label: string }

type Mech = {
  id: number
  ctrl: Controller
  pos: V3; vel: V3; aim: [number, number]; cmdAim: [number, number]
  grounded: boolean
  hp: number; maxHp: number; energy: number; maxEnergy: number
  lastSpend: number; lastCombat: number
  cubes: number; upgrades: string[]
  stats: Record<string, number>
  wstats: Record<string, Record<string, number>>
  weapons: (Weapon | null)[]
  alive: boolean; deathT: number; place: number; kills: number
  inZone: boolean
  events: any[]
  sounds: any[]
  beams: any[]
  seen: Map<number, number> // id -> last time seen (for memory)
  offer: { id: number; expires: number; choices: any[] } | null
  offersPending: number
  offerSeq: number
  shortUntil: number
  stepAcc: number
  action: any
  lastFire: [boolean, boolean]
  // house bot state
  hunting?: boolean
  strafe?: number; strafeT?: number
  goal?: [number, number] | null
  damageBy: Map<number, number>
  lastDamageT: number
}
type Proj = { id: number; kind: "gun" | "mortar" | "npc"; owner: number; pos: V3; vel: V3; dist: number; dmg: number; range: number; t0: number; ws?: Record<string, number> }
type Npc = { id: number; pos: V3; vel: V3; home: [number, number]; hp: number; alive: boolean; target: number | null; cooldown: number; wanderGoal: [number, number]; aim: number }
type Item = { id: number; pos: V3; hp?: number; kind?: WK }
type Drop = { id: number; pos: V3; landsAt: number; progress: number; holder: number | null; taken: boolean; calledAt: number }

export type SimOptions = {
  seed: number
  mode: "practice" | "ffa"
  /** for practice: overrides for our single bot; for ffa: list of 16 entries (null = house bot) */
  ours: (Partial<typeof PARAMS> | null)[]
  ourSlot?: number
  verbose?: boolean
  maxT?: number
}
export type MechResult = { id: number; label: string; place: number; kills: number; deathT: number; cubes: number; hp: number; cause: string }

const M = CFG.mech
const DT = 1 / CFG.match.tick_hz

function bodyBlocked(x: number, y: number, z: number, r: number, h: number) {
  if (!MAP.inBounds(x, y)) return true
  for (let a = -1; a < 8; a++) {
    const px = a < 0 ? x : x + Math.cos((a * Math.PI) / 4) * r * 0.9, py = a < 0 ? y : y + Math.sin((a * Math.PI) / 4) * r * 0.9
    const k = MAP.idx(px, py)
    if (MAP.top[k] > z + M.step_up) return true
    const b = MAP.ohBase[k]
    if (!Number.isNaN(b) && b < z + h && MAP.ohTop[k] > z + M.step_up) return true
  }
  return false
}
function groundUnder(x: number, y: number, z: number, r: number) {
  let g = -1e9
  for (let a = -1; a < 8; a++) {
    const px = a < 0 ? x : x + Math.cos((a * Math.PI) / 4) * r * 0.9, py = a < 0 ? y : y + Math.sin((a * Math.PI) / 4) * r * 0.9
    const h = MAP.topAt(px, py)
    if (h <= z + M.step_up && h > g) g = h
  }
  return g
}
function openGroundPoint(rng: Rng, cx: number, cy: number, r: number, roof = false): V3 {
  for (let i = 0; i < 400; i++) {
    const a = rng.next() * TAU, d = Math.sqrt(rng.next()) * r
    const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d
    if (!MAP.inBounds(x, y) || x < MAP.minX + 30 || y < MAP.minY + 30 || x > MAP.minX + MAP.nx - 30 || y > MAP.minY + MAP.ny - 30) continue
    const top = MAP.topAt(x, y), g = MAP.groundAt(x, y)
    const isRoof = top - g > 4
    if (roof !== isRoof) continue
    if (isRoof && top - g > 40) continue
    if (bodyBlocked(x, y, top, 2.6, 9)) continue
    return [x, y, top]
  }
  return [cx, cy, MAP.topAt(cx, cy)]
}

export async function runMatch(opt: SimOptions): Promise<{ results: MechResult[]; t: number }> {
  const rng = new Rng(opt.seed * 7919 + 13)
  const cfg = CFG
  const W = cfg.weapons
  const N = cfg.match.mechs
  let nextId = 20
  const newId = () => nextId++
  // --- zone schedule ---
  const centers: [number, number][] = []
  {
    let c = cfg.zone.start_center as [number, number], r = cfg.zone.start_radius
    for (const p of cfg.zone.phases) {
      const room = r - p.radius
      let nc: [number, number] = c
      for (let i = 0; i < 50; i++) {
        const a = rng.next() * TAU, d = Math.sqrt(rng.next()) * room * 0.95
        nc = [c[0] + Math.cos(a) * d, c[1] + Math.sin(a) * d]
        if (nc[0] > MAP.minX + 60 && nc[0] < MAP.minX + MAP.nx - 60 && nc[1] > MAP.minY + 60 && nc[1] < MAP.minY + MAP.ny - 60) break
      }
      centers.push(nc)
      c = nc; r = p.radius
    }
  }
  function zoneAt(t: number) {
    const ph = cfg.zone.phases
    let c = cfg.zone.start_center as [number, number], r = cfg.zone.start_radius, t0 = 0
    for (let i = 0; i < ph.length; i++) {
      const p = ph[i], ss = t0 + p.hold_s, se = ss + p.shrink_s
      if (t < se) return { center: c, radius: r, next_center: centers[i], next_radius: p.radius, shrink_start: ss, shrink_end: se, dps: p.dps }
      c = centers[i]; r = p.radius; t0 = se
    }
    return { center: c, radius: r, next_center: c, next_radius: r, shrink_start: t0, shrink_end: t0, dps: ph[ph.length - 1].dps }
  }
  function zoneCircle(t: number) {
    const z = zoneAt(t)
    const f = t <= z.shrink_start ? 0 : t >= z.shrink_end ? 1 : (t - z.shrink_start) / (z.shrink_end - z.shrink_start)
    return { cx: z.center[0] + (z.next_center[0] - z.center[0]) * f, cy: z.center[1] + (z.next_center[1] - z.center[1]) * f, r: z.radius + (z.next_radius - z.radius) * f, dps: z.dps, z }
  }

  // --- mechs ---
  const mechs: Mech[] = []
  const spawns: V3[] = []
  const sc = cfg.zone.start_center, sr = cfg.zone.start_radius * cfg.match.spawn_zone_fraction
  for (let i = 0; i < N; i++) {
    let p: V3 = openGroundPoint(rng, sc[0], sc[1], sr)
    for (let k = 0; k < 60; k++) {
      if (spawns.every((q) => hyp(q[0], q[1], p[0], p[1]) > cfg.match.spawn_min_separation)) break
      p = openGroundPoint(rng, sc[0], sc[1], sr)
    }
    spawns.push(p)
  }
  const ourSlot = opt.ourSlot ?? Math.floor(rng.next() * N)
  const tiers = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3]
  let houseIdx = 0
  for (let i = 0; i < N; i++) {
    let ctrl: Controller
    const spec = opt.mode === "practice" ? (i === ourSlot ? (opt.ours[0] ?? {}) : null) : opt.ours[i]
    if (spec && (spec as any).ext) {
      ctrl = { kind: "ext", bot: new ExtBot(extSpec((spec as any).ext)), label: (spec as any).label ?? (spec as any).ext }
    } else if (spec) {
      const hello = { type: "hello", protocol: "mechfight/1", slot: i, seed: opt.seed * 31 + i, map: { dir: `${KIT}/arena`, files: ["v2/world.json", "v2/terrain.i16"] }, config: cfg } as any
      const bot = makeBot(hello, spec)
      ctrl = { kind: "ours", act: (o: any) => bot.act(o), label: (spec as any).label ?? "ours" }
    } else {
      ctrl = { kind: "house", tier: tiers[houseIdx++ % tiers.length], label: "house" }
    }
    mechs.push({
      id: i, ctrl, pos: [...spawns[i]] as V3, vel: [0, 0, 0], aim: [rng.next() * TAU - Math.PI, 0], cmdAim: [0, 0], grounded: true,
      hp: M.hp, maxHp: M.hp, energy: M.energy, maxEnergy: M.energy, lastSpend: -9, lastCombat: -9, cubes: 0, upgrades: [],
      stats: clone(M), wstats: clone(W), weapons: [{ kind: "gun", cooldown: 0, ammo: W.gun.mag, reload: 0, charge: 0, held: 0, equip: 0 }, null],
      alive: true, deathT: -1, place: 0, kills: 0, inZone: true, events: [], sounds: [], beams: [], seen: new Map(), offer: null, offersPending: 0, offerSeq: 0,
      shortUntil: -9, stepAcc: 0, action: {}, lastFire: [false, false], damageBy: new Map(), lastDamageT: -99,
    })
  }
  const ours = mechs.filter((m) => m.ctrl.kind === "ours" || m.ctrl.kind === "ext")
  await Promise.all(mechs.filter((m) => m.ctrl.kind === "ext").map(async (m) => {
    const hello = { type: "hello", protocol: "mechfight/1", slot: m.id, seed: opt.seed * 31 + m.id, map: { dir: `${KIT}/arena`, files: ["v2/world.json", "v2/terrain.i16"] }, config: cfg }
    const ok = await (m.ctrl as any).bot.hello(hello)
    if (!ok && opt.verbose) console.error(`ext ${m.ctrl.label} not ready`)
  }))
  const extTimeout = Number(process.env.EXT_TIMEOUT_MS ?? 200)

  // --- world items ---
  const projs: Proj[] = []
  const pickups: Item[] = []
  const crates: Item[] = []
  const cubes: Item[] = []
  const npcs: Npc[] = []
  const drops: Drop[] = []
  const lootKinds: WK[] = ["mortar", "laser", "lightning"]
  for (let i = 0; i < cfg.loot.floor_count; i++) pickups.push({ id: 8000 + i, pos: openGroundPoint(rng, 0, 0, 600, rng.next() < cfg.loot.floor_roof_fraction), kind: rng.pick(lootKinds) })
  let pickupSeq = 8000 + cfg.loot.floor_count
  for (let i = 0; i < cfg.crates.count; i++) crates.push({ id: 1000 + i, pos: openGroundPoint(rng, 0, 0, 600, rng.next() < cfg.crates.roof_fraction), hp: cfg.crates.hp })
  let cubeSeq = 5000
  for (let i = 0; i < cfg.npc.count; i++) {
    const p = openGroundPoint(rng, 0, 0, 550)
    npcs.push({ id: 100 + i, pos: p, vel: [0, 0, 0], home: [p[0], p[1]], hp: cfg.npc.hp, alive: true, target: null, cooldown: 0, wanderGoal: [p[0], p[1]], aim: 0 })
  }

  // --- helpers ---
  const sizeOf = (m: Mech) => 1 + cfg.cubes.size_per_cube * m.cubes
  const radiusOf = (m: Mech) => M.radius * sizeOf(m)
  const heightOf = (m: Mech) => M.height * sizeOf(m)
  const dmgMult = (m: Mech) => 1 + cfg.cubes.damage_per_cube * Math.min(m.cubes, cfg.cubes.stat_cap)
  const centerOf = (m: Mech): V3 => [m.pos[0], m.pos[1], m.pos[2] + heightOf(m) / 2]
  const eyeOf = (m: Mech): V3 => [m.pos[0], m.pos[1], m.pos[2] + M.eye_height * sizeOf(m)]
  const muzzleOf = (m: Mech): V3 => {
    const cy = Math.cos(m.aim[1])
    return [m.pos[0] + Math.cos(m.aim[0]) * cy * 3, m.pos[1] + Math.sin(m.aim[0]) * cy * 3, m.pos[2] + M.muzzle_height * sizeOf(m) + Math.sin(m.aim[1]) * 3]
  }
  const los = (a: V3, b: V3) => MAP.los(a[0], a[1], a[2], b[0], b[1], b[2])
  let t = 0
  let aliveCount = N

  function emitSound(kind: string, at: V3, except: number) {
    const range = cfg.sound.range[kind] ?? 100
    for (const m of mechs) {
      if (!m.alive || m.id === except) continue
      const d = Math.hypot(at[0] - m.pos[0], at[1] - m.pos[1])
      if (d > range) continue
      const bearing = Math.atan2(at[1] - m.pos[1], at[0] - m.pos[0]) + rng.gauss() * (cfg.sound.bearing_noise_deg * Math.PI / 180) * (m.stats.hearing ?? 1)
      m.sounds.push({ kind, bearing: wrap(bearing), dist: d < cfg.sound.near ? "near" : d < cfg.sound.mid ? "mid" : "far", age: 0 })
    }
  }

  function damageMech(v: Mech, amount: number, weapon: string, from: V3 | null, by: number | null, effect?: string) {
    if (!v.alive || amount <= 0) return
    let rear = false
    if (from && by != null) {
      const dir = Math.atan2(from[1] - v.pos[1], from[0] - v.pos[0])
      if (Math.abs(wrap(dir - v.aim[0])) > (M.front_arc_deg * Math.PI) / 360) { rear = true; amount *= M.rear_mult }
      amount *= 1 - (v.stats.armor ?? 0)
    }
    v.hp -= amount
    ;(v as any).taken = ((v as any).taken ?? 0) + amount
    const src = by == null ? "zone" : by >= 100 ? "npc" : weapon
    ;(v as any).takenBy = (v as any).takenBy ?? {}
    ;(v as any).takenBy[src] = ((v as any).takenBy[src] ?? 0) + amount
    if (by != null && by < 16) (mechs[by] as any).dealt = ((mechs[by] as any).dealt ?? 0) + amount
    v.lastCombat = t
    v.lastDamageT = t
    const bearing = from ? Math.atan2(from[1] - v.pos[1], from[0] - v.pos[0]) : null
    v.events.push({ type: "damaged", amount: Math.round(amount * 10) / 10, weapon, bearing, by, ...(rear ? { rear: true } : {}) })
    if (by != null && by < 16) {
      const a = mechs[by]
      a.lastCombat = t
      a.events.push({ type: "hit", target: v.id, amount: Math.round(amount * 10) / 10, weapon, ...(effect ? { effect } : {}), ...(rear ? { rear: true } : {}) })
      v.damageBy.set(by, t)
    }
    if (v.hp <= 0) killMech(v, by, weapon)
  }
  const deathsThisTick: Mech[] = []
  function killMech(v: Mech, by: number | null, cause: string) {
    v.alive = false
    v.deathT = t
    ;(v as any).cause = cause + (by != null ? `:${by < 16 ? mechs[by].ctrl.label : "npc"}` : "")
    deathsThisTick.push(v)
    if (v.ctrl.kind === "ext") { const b = v.ctrl.bot; setTimeout(() => b.end(v.place, v.kills), 0) }
    emitSound("death", v.pos, v.id)
    for (const w of v.weapons) if (w && w.kind !== "gun") pickups.push({ id: pickupSeq++, pos: [v.pos[0] + rng.next() * 2 - 1, v.pos[1] + rng.next() * 2 - 1, v.pos[2]], kind: w.kind })
    const n = v.cubes + (by != null && by < 16 ? cfg.cubes.death_drop_extra : 0)
    for (let i = 0; i < n; i++) cubes.push({ id: cubeSeq++, pos: [v.pos[0] + rng.next() * 3 - 1.5, v.pos[1] + rng.next() * 3 - 1.5, v.pos[2]] })
    if (by != null && by < 16) { mechs[by].kills++; mechs[by].events.push({ type: "kill", target: v.id }) }
  }
  function damageNpc(n: Npc, amount: number, by: number) {
    if (!n.alive) return
    n.hp -= amount
    n.target = by
    if (by < 16) { mechs[by].lastCombat = t; mechs[by].events.push({ type: "hit", target: n.id, amount, weapon: "x" }) }
    if (n.hp <= 0) {
      n.alive = false
      for (let i = 0; i < cfg.npc.cubes; i++) cubes.push({ id: cubeSeq++, pos: [n.pos[0] + rng.next() * 2 - 1, n.pos[1] + rng.next() * 2 - 1, n.pos[2]] })
    }
  }
  function damageCrate(c: Item, amount: number, by: number) {
    if ((c.hp ?? 0) <= 0) return
    c.hp = (c.hp ?? 0) - amount
    if (by < 16) { mechs[by].lastCombat = t; mechs[by].events.push({ type: "hit", target: c.id, amount, weapon: "x" }) }
    if ((c.hp ?? 0) <= 0) {
      emitSound("crate", c.pos, -1)
      cubes.push({ id: cubeSeq++, pos: [...c.pos] as V3 })
      if (rng.next() < cfg.loot.crate_weapon_chance) pickups.push({ id: pickupSeq++, pos: [c.pos[0] + 1, c.pos[1], c.pos[2]], kind: rng.pick(lootKinds) })
    }
  }

  // ray/segment vs mech cylinder: returns param s in [0,1] of first hit or -1
  function segHitsCyl(a: V3, b: V3, m: { pos: V3 }, r: number, h: number): number {
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const fx = a[0] - m.pos[0], fy = a[1] - m.pos[1]
    const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r
    let s0: number
    if (A < 1e-9) { if (C > 0) return -1; s0 = 0 } else {
      const disc = B * B - 4 * A * C
      if (disc < 0) return -1
      const sq = Math.sqrt(disc)
      s0 = (-B - sq) / (2 * A)
      const s1 = (-B + sq) / (2 * A)
      if (s1 < 0 || s0 > 1) return -1
      if (s0 < 0) s0 = 0
    }
    const z = a[2] + (b[2] - a[2]) * s0
    if (z >= m.pos[2] && z <= m.pos[2] + h) return s0
    return -1
  }
  function firstSolid(a: V3, b: V3): number {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    const n = Math.max(1, Math.ceil(d / 0.7))
    for (let i = 1; i <= n; i++) {
      const f = i / n
      if (MAP.solid(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f)) return (i - 1) / n
    }
    return -1
  }

  // --- firing ---
  function fireGun(m: Mech, w: Weapon) {
    const ws = m.wstats.gun
    const spread = (ws.spread_deg * Math.PI) / 180
    const yaw = m.aim[0] + rng.gauss() * spread, pitch = m.aim[1] + rng.gauss() * spread
    const dir: V3 = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)]
    projs.push({ id: newId(), kind: "gun", owner: m.id, pos: muzzleOf(m), vel: [dir[0] * ws.speed, dir[1] * ws.speed, dir[2] * ws.speed], dist: 0, dmg: ws.damage * dmgMult(m), range: ws.range, t0: t })
    w.ammo--
    ;(m as any).shots = ((m as any).shots ?? 0) + 1
    w.cooldown = ws.cooldown
    if (w.ammo <= 0) w.reload = ws.reload
    emitSound("gun", m.pos, m.id)
    ;(m as any).lastShotT = t
  }
  function fireMortar(m: Mech, w: Weapon) {
    const ws = m.wstats.mortar
    const dir: V3 = [Math.cos(m.aim[1]) * Math.cos(m.aim[0]), Math.cos(m.aim[1]) * Math.sin(m.aim[0]), Math.sin(m.aim[1])]
    const p: V3 = [m.pos[0] + dir[0] * 3, m.pos[1] + dir[1] * 3, m.pos[2] + heightOf(m) + 0.5 + dir[2] * 3]
    projs.push({ id: newId(), kind: "mortar", owner: m.id, pos: p, vel: [dir[0] * ws.speed, dir[1] * ws.speed, dir[2] * ws.speed], dist: 0, dmg: dmgMult(m), range: 1e9, t0: t, ws })
    w.cooldown = ws.cooldown
    emitSound("mortar", m.pos, m.id)
  }
  function fireLaser(m: Mech, w: Weapon) {
    const ws = m.wstats.laser
    const frac = ws.min_frac + (1 - ws.min_frac) * Math.min(1, w.charge / ws.charge)
    const a = muzzleOf(m)
    const dir: V3 = [Math.cos(m.aim[1]) * Math.cos(m.aim[0]), Math.cos(m.aim[1]) * Math.sin(m.aim[0]), Math.sin(m.aim[1])]
    const b: V3 = [a[0] + dir[0] * ws.range, a[1] + dir[1] * ws.range, a[2] + dir[2] * ws.range]
    let sHit = firstSolid(a, b)
    if (sHit < 0) sHit = 1
    let best: Mech | Npc | Item | null = null, bs = sHit, kind = ""
    for (const v of mechs) { if (!v.alive || v.id === m.id) continue; const s = segHitsCyl(a, b, v, radiusOf(v), heightOf(v)); if (s >= 0 && s < bs) { bs = s; best = v; kind = "m" } }
    for (const n of npcs) { if (!n.alive) continue; const s = segHitsCyl(a, b, n, cfg.npc.radius, cfg.npc.height); if (s >= 0 && s < bs) { bs = s; best = n; kind = "n" } }
    for (const c of crates) { if ((c.hp ?? 0) <= 0) continue; const s = segHitsCyl(a, b, c, cfg.crates.radius, cfg.crates.height); if (s >= 0 && s < bs) { bs = s; best = c; kind = "c" } }
    const end: V3 = [a[0] + (b[0] - a[0]) * bs, a[1] + (b[1] - a[1]) * bs, a[2] + (b[2] - a[2]) * bs]
    const dmg = ws.damage * frac * dmgMult(m)
    if (kind === "m") {
      const v = best as Mech
      const cook = v.weapons.some((x) => x?.kind === "mortar")
      damageMech(v, dmg * (cook ? 1 + ws.cookoff : 1), "laser", m.pos, m.id, cook ? "cookoff" : undefined)
    } else if (kind === "n") damageNpc(best as Npc, dmg, m.id)
    else if (kind === "c") damageCrate(best as Item, dmg, m.id)
    for (const o of mechs) if (o.alive && o.id !== m.id) o.beams.push({ by: m.id, kind: "laser", path: [a, end], age: 0 })
    w.charge = 0; w.held = 0
    w.cooldown = ws.cooldown
    emitSound("laser", m.pos, m.id)
  }
  function fireLightning(m: Mech, w: Weapon) {
    const ws = m.wstats.lightning
    if (m.energy < ws.energy) return
    m.energy -= ws.energy; m.lastSpend = t
    w.cooldown = ws.cooldown
    emitSound("lightning", m.pos, m.id)
    const eye = muzzleOf(m)
    const cone = (ws.cone_deg * Math.PI) / 180 / 2
    type Tg = { kind: "m" | "n" | "c"; ref: any; p: V3 }
    const all: Tg[] = []
    for (const v of mechs) if (v.alive && v.id !== m.id) all.push({ kind: "m", ref: v, p: centerOf(v) })
    for (const n of npcs) if (n.alive) all.push({ kind: "n", ref: n, p: [n.pos[0], n.pos[1], n.pos[2] + 1.75] })
    for (const c of crates) if ((c.hp ?? 0) > 0) all.push({ kind: "c", ref: c, p: [c.pos[0], c.pos[1], c.pos[2] + 1.2] })
    let first: Tg | null = null, fd = ws.range
    for (const g of all) {
      const d = hyp(m.pos[0], m.pos[1], g.p[0], g.p[1])
      if (d > fd) continue
      if (Math.abs(wrap(Math.atan2(g.p[1] - m.pos[1], g.p[0] - m.pos[0]) - m.aim[0])) > cone) continue
      if (!los(eye, g.p)) continue
      fd = d; first = g
    }
    const path: V3[] = [eye]
    if (!first) {
      path.push([eye[0] + Math.cos(m.aim[0]) * ws.range, eye[1] + Math.sin(m.aim[0]) * ws.range, eye[2]])
    } else {
      let cur: Tg = first, dmg = ws.damage * dmgMult(m)
      const hitSet = new Set<any>()
      for (let j = 0; j <= ws.chain; j++) {
        hitSet.add(cur.ref)
        path.push(cur.p)
        if (cur.kind === "m") {
          const v = cur.ref as Mech
          damageMech(v, dmg, "lightning", path[path.length - 2], m.id, v.weapons.some((x) => x?.kind === "laser") ? "short" : undefined)
          if (v.weapons.some((x) => x?.kind === "laser")) { v.shortUntil = t + ws.short_s; for (const x of v.weapons) if (x?.kind === "laser") { x.charge = 0; x.held = 0 } }
        } else if (cur.kind === "n") damageNpc(cur.ref, dmg, m.id)
        else damageCrate(cur.ref, dmg, m.id)
        let nx: Tg | null = null, nd = ws.chain_range
        for (const g of all) {
          if (hitSet.has(g.ref) || (g.kind === "m" && !(g.ref as Mech).alive)) continue
          const d = Math.hypot(g.p[0] - cur.p[0], g.p[1] - cur.p[1], g.p[2] - cur.p[2])
          if (d < nd && los(cur.p, g.p)) { nd = d; nx = g }
        }
        if (!nx) break
        cur = nx
        dmg *= ws.chain_falloff
      }
    }
    for (const o of mechs) if (o.alive && o.id !== m.id) o.beams.push({ by: m.id, kind: "lightning", path, age: 0 })
  }
  function explode(p: Proj, at: V3, direct: Mech | null) {
    const ws = p.ws!
    const owner = mechs[p.owner]
    emitSound("explosion", at, -1)
    if (direct) damageMech(direct, ws.damage * p.dmg, "mortar", at, p.owner, "concuss")
    for (const v of mechs) {
      if (!v.alive) continue
      const c = centerOf(v)
      const d = Math.max(0, Math.hypot(c[0] - at[0], c[1] - at[1], c[2] - at[2]) - radiusOf(v))
      if (d > ws.splash_radius) continue
      if (!los(at, c)) continue
      const f = 1 - (1 - ws.splash_edge) * (d / ws.splash_radius)
      let dmg = ws.splash * f * p.dmg
      if (v.id === p.owner) dmg *= M.self_damage_mult
      damageMech(v, dmg, "mortar", at, v.id === p.owner ? null : p.owner)
      const dir = Math.atan2(c[1] - at[1], c[0] - at[0])
      v.vel[0] += Math.cos(dir) * ws.knock * f; v.vel[1] += Math.sin(dir) * ws.knock * f; v.vel[2] += ws.knock_up * f
      v.grounded = false
      v.energy = Math.max(0, v.energy - ws.drain * f)
      if (v.alive && v.id !== p.owner) v.events.push({ type: "effect", effect: "concuss", by: p.owner })
    }
    for (const n of npcs) if (n.alive && Math.hypot(n.pos[0] - at[0], n.pos[1] - at[1]) < ws.splash_radius) damageNpc(n, ws.splash * 0.6 * p.dmg, p.owner)
    for (const c of crates) if ((c.hp ?? 0) > 0 && Math.hypot(c.pos[0] - at[0], c.pos[1] - at[1]) < ws.splash_radius) damageCrate(c, ws.splash * 0.6 * p.dmg, p.owner)
    void owner
  }

  // --- vision ---
  function sees(m: Mech, p: V3, r = 0): boolean {
    const d = hyp(m.pos[0], m.pos[1], p[0], p[1])
    const near = cfg.vision.near_range + (m.stats.near_range_bonus ?? 0)
    const far = cfg.vision.range + (m.stats.vision_bonus ?? 0)
    if (d > far + r) return false
    if (d > near + r) {
      const dy = Math.abs(wrap(Math.atan2(p[1] - m.pos[1], p[0] - m.pos[0]) - m.aim[0]))
      if (dy > (cfg.vision.fov_deg * Math.PI) / 360) return false
    }
    return los(eyeOf(m), p)
  }
  function seesMech(m: Mech, v: Mech) {
    return sees(m, centerOf(v)) || sees(m, [v.pos[0], v.pos[1], v.pos[2] + heightOf(v) - 0.3])
  }

  // --- observation ---
  function buildObs(m: Mech, tick: number) {
    const zc = zoneAt(t)
    const visMechs: any[] = []
    for (const v of mechs) {
      if (!v.alive || v.id === m.id) continue
      if (seesMech(m, v)) m.seen.set(v.id, t)
      const st = m.seen.get(v.id)
      if (st == null || t - st > cfg.vision.memory_s) continue
      visMechs.push({ id: v.id, kind: "mech", pos: [...v.pos], vel: [...v.vel], aim: [...v.aim], hp: Math.round(v.hp * 10) / 10, max_hp: v.maxHp, cubes: v.cubes,
        weapons: v.weapons.filter((w) => w).map((w) => w!.kind), charging: v.weapons.some((w) => w?.kind === "laser" && w.charge > 0) })
    }
    for (const n of npcs) {
      if (!n.alive) continue
      const c: V3 = [n.pos[0], n.pos[1], n.pos[2] + 1.75]
      if (sees(m, c)) m.seen.set(n.id, t)
      const st = m.seen.get(n.id)
      if (st == null || t - st > cfg.vision.memory_s) continue
      visMechs.push({ id: n.id, kind: "npc", pos: [...n.pos], vel: [...n.vel], aim: [n.aim, 0], hp: n.hp, max_hp: cfg.npc.hp })
    }
    const visProj = projs.filter((p) => p.owner !== m.id && sees(m, p.pos)).map((p) => ({ id: p.id, kind: p.kind, pos: [...p.pos], vel: [...p.vel] }))
    const visCr = crates.filter((c) => (c.hp ?? 0) > 0 && sees(m, [c.pos[0], c.pos[1], c.pos[2] + 1.2])).map((c) => ({ id: c.id, pos: [...c.pos], hp: c.hp }))
    const visCu = cubes.filter((c) => sees(m, [c.pos[0], c.pos[1], c.pos[2] + 0.5])).map((c) => ({ id: c.id, pos: [...c.pos] }))
    const visPk = pickups.filter((c) => sees(m, [c.pos[0], c.pos[1], c.pos[2] + 0.5])).map((c) => ({ id: c.id, kind: c.kind, pos: [...c.pos] }))
    const beams = m.beams.filter((b) => sees(m, b.path[0]) || sees(m, b.path[b.path.length - 1]))
    const obs = {
      type: "obs", tick, t: Math.round(t * 100) / 100, alive: aliveCount,
      self: {
        id: m.id, pos: [...m.pos], vel: [...m.vel], aim: [...m.aim], hp: Math.round(m.hp * 10) / 10, max_hp: m.maxHp, energy: Math.round(m.energy), max_energy: m.maxEnergy,
        grounded: m.grounded, cubes: m.cubes, upgrades: [...m.upgrades], in_zone: m.inZone,
        weapons: m.weapons.map((w) => w ? { kind: w.kind, cooldown: Math.max(w.cooldown, w.equip), ...(w.kind === "gun" ? { ammo: w.ammo, reload: Math.max(0, w.reload) } : {}), ...(w.kind === "laser" ? { charge: w.charge } : {}), stats: { ...m.wstats[w.kind] } } : null),
        stats: { ...m.stats, radius: radiusOf(m), height: heightOf(m), eye_height: M.eye_height * sizeOf(m), muzzle_height: M.muzzle_height * sizeOf(m) },
      },
      mechs: visMechs, projectiles: visProj, crates: visCr, cubes: visCu, pickups: visPk,
      sounds: m.sounds, beams, events: m.events,
      zone: zc, offer: m.offer, drops: drops.filter((d) => !d.taken).map((d) => ({ id: d.id, pos: [...d.pos], radius: cfg.drops.radius, lands_in: Math.max(0, d.landsAt - t), capture_s: cfg.drops.capture_s, progress: d.progress, holder: d.holder })),
    }
    m.sounds = []; m.events = []; m.beams = []
    return obs
  }

  // --- upgrades ---
  const upgrades = cfg.upgrades as any[]
  function applyUpgrade(m: Mech, id: string) {
    const u = upgrades.find((x) => x.id === id)
    if (!u) return
    m.upgrades.push(id)
    for (const e of u.effects) {
      const [root, a, b] = e.path.split(".")
      const obj = root === "mech" ? m.stats : m.wstats[a]
      const key = root === "mech" ? a : b
      if (e.mul != null) obj[key] *= e.mul
      if (e.add != null) obj[key] = (obj[key] ?? 0) + e.add
      if (root === "mech" && key === "hp") { const old = m.maxHp; m.maxHp = M.hp * (m.stats.hp / M.hp) * (1 + cfg.cubes.hp_per_cube * Math.min(m.cubes, cfg.cubes.stat_cap)); m.hp += m.maxHp - old }
      if (root === "mech" && key === "energy") m.maxEnergy = m.stats.energy
    }
    m.events.push({ type: "upgrade", id })
  }
  function makeOffer(m: Mech) {
    const held = new Set(m.weapons.filter((w) => w).map((w) => w!.kind))
    const ok = upgrades.filter((u) => (!u.requires || held.has(u.requires)) && m.upgrades.filter((x) => x === u.id).length < u.max)
    const choices: any[] = []
    while (choices.length < 3 && ok.length) choices.push(ok.splice(Math.floor(rng.next() * ok.length), 1)[0])
    if (!choices.length) return
    m.offer = { id: ++m.offerSeq, expires: t + cfg.bot.offer_timeout_s, choices: choices.map((c) => ({ id: c.id, name: c.name, desc: c.desc })) }
  }
  function gainCube(m: Mech, n = 1) {
    for (let i = 0; i < n; i++) {
      const before = Math.min(m.cubes, cfg.cubes.stat_cap)
      m.cubes++
      const after = Math.min(m.cubes, cfg.cubes.stat_cap)
      if (after > before) { const old = m.maxHp; m.maxHp = m.stats.hp * (1 + cfg.cubes.hp_per_cube * after); m.hp += m.maxHp - old }
      if (cfg.cubes.upgrade_thresholds.includes(m.cubes)) m.offersPending++
    }
    m.events.push({ type: "pickup", cubes: m.cubes })
  }

  // --- house bot AI (emulates the practice squad: shared vision, hunts our bot, weakest first) ---
  const RETALIATE = Number(process.env.RETALIATE ?? 1e9)
  const HUNT_KNOW = (process.env.HUNT_KNOW ?? "1") === "1"
  const tierAim = (process.env.TIER_AIM ?? "0.06,0.04,0.025,0.012").split(",").map(Number)
  const tierLead = (process.env.TIER_LEAD ?? "0,0.5,0.8,1").split(",").map(Number)
  let squadKnown: { pos: V3; vel: V3; t: number } | null = null
  function houseHunters(): Set<number> {
    const target = ours[0]
    const houses = mechs.filter((m) => m.alive && m.ctrl.kind === "house")
    const houseDead = mechs.filter((m) => !m.alive && m.ctrl.kind === "house").length
    let n = 1 + houseDead + (t > 150 ? 1 : 0) + (t > 220 ? 2 : 0)
    if (t > 300) n = 99
    houses.sort((a, b) => (a.ctrl as any).tier - (b.ctrl as any).tier || a.id - b.id)
    void target
    return new Set(houses.slice(0, n).map((m) => m.id))
  }
  function houseAct(m: Mech, hunters: Set<number>, practice: boolean) {
    const tier = (m.ctrl as any).tier as number
    const act: any = { move: [0, 0], aim: m.cmdAim, fire: [false, false] }
    const zc = zoneCircle(t)
    const zn = zoneAt(t)
    // pick enemy
    let enemy: Mech | null = null
    if (practice) {
      const o = ours[0]
      if (o && o.alive) {
        const seenBySquad = mechs.some((h) => h.alive && h.ctrl.kind === "house" && seesMech(h, o))
        if (seenBySquad) squadKnown = { pos: [...o.pos] as V3, vel: [...o.vel] as V3, t }
        else if (!HUNT_KNOW && (o as any).lastShotT != null && t - (o as any).lastShotT < 0.2 && (!squadKnown || t - squadKnown.t > 1)) {
          // gunfire gives a rough fix to every house bot within earshot
          squadKnown = { pos: [o.pos[0] + rng.gauss() * 15, o.pos[1] + rng.gauss() * 15, o.pos[2]] as V3, vel: [0, 0, 0], t }
        }
        const d = hyp(m.pos[0], m.pos[1], o.pos[0], o.pos[1])
        const attacked = (m.damageBy.get(o.id) ?? -99) > t - 8 && d < RETALIATE
        if (hunters.has(m.id) || attacked || (seesMech(m, o) && d < 45)) enemy = o
      }
    } else {
      let bd = 1e9
      for (const v of mechs) {
        if (!v.alive || v.id === m.id || !seesMech(m, v)) continue
        const d = hyp(m.pos[0], m.pos[1], v.pos[0], v.pos[1])
        if (d < bd) { bd = d; enemy = v }
      }
    }
    if (m.offer) act.pick = 0
    let goal: [number, number] | null = null
    let wantFace: number | null = null
    if (enemy) {
      const visible0 = seesMech(m, enemy)
      if (!visible0 && practice && !HUNT_KNOW && (!squadKnown || t - squadKnown.t > 20)) {
        // no recent fix on us: sweep toward the next circle like everyone else
        enemy = null
      }
    }
    if (enemy) {
      const visible = seesMech(m, enemy)
      const ep = visible || !squadKnown || !practice ? enemy.pos : squadKnown.pos
      const d = hyp(m.pos[0], m.pos[1], ep[0], ep[1])
      const hasL = m.weapons.find((w) => w?.kind === "lightning")
      const want = hasL ? 25 : 60
      if (t > (m.strafeT ?? 0)) { m.strafe = rng.next() < 0.5 ? 1 : -1; m.strafeT = t + 0.7 + rng.next() * 1.5 }
      const toE = Math.atan2(ep[1] - m.pos[1], ep[0] - m.pos[0])
      if (visible) {
        const radial = Math.max(-1, Math.min(1, (d - want) / 20))
        act.move = [Math.cos(toE) * radial + Math.cos(toE + Math.PI / 2) * (m.strafe ?? 1) * 0.8, Math.sin(toE) * radial + Math.sin(toE + Math.PI / 2) * (m.strafe ?? 1) * 0.8]
        // aim with lead and noise
        const c = centerOf(enemy)
        const mz = muzzleOf(m)
        const flight = d / m.wstats.gun.speed
        const lead = tierLead[tier]
        const ap: V3 = [c[0] + enemy.vel[0] * flight * lead, c[1] + enemy.vel[1] * flight * lead, c[2]]
        const laser = m.weapons.find((w) => w?.kind === "laser")
        const aimP = laser && laser.charge > 0 ? c : ap
        const yaw = Math.atan2(aimP[1] - m.pos[1], aimP[0] - m.pos[0]) + rng.gauss() * tierAim[tier]
        const pitch = Math.atan2(aimP[2] - mz[2], hyp(m.pos[0], m.pos[1], aimP[0], aimP[1])) + rng.gauss() * tierAim[tier] * 0.5
        act.aim = [yaw, pitch]
        const err = Math.abs(wrap(yaw - m.aim[0]))
        const clear = los(mz, c)
        m.weapons.forEach((w, i) => {
          if (!w) return
          if (w.kind === "gun") act.fire[i] = clear && err < 0.05 && d < m.wstats.gun.range
          else if (w.kind === "lightning") act.fire[i] = clear && d < m.wstats.lightning.range && err < 0.2
          else if (w.kind === "laser") {
            if (m.shortUntil > t) act.fire[i] = false
            else if (w.charge < m.wstats.laser.charge) act.fire[i] = clear && d < m.wstats.laser.range
            else act.fire[i] = !(clear && err < 0.03)
          } else if (w.kind === "mortar") {
            act.fire[i] = d > 30 && d < 200 && err < 0.05 && rng.next() < 0.3
            if (act.fire[i]) {
              const v = m.wstats.mortar.speed, g = m.wstats.mortar.gravity
              const disc = v ** 4 - g * (g * d * d + 2 * (c[2] - m.pos[2] - 9.5) * v * v)
              if (disc > 0) act.aim = [yaw, Math.atan((v * v - Math.sqrt(disc)) / (g * d))]
              else act.fire[i] = false
            }
          }
        })
      } else {
        goal = [ep[0], ep[1]]
        wantFace = toE
      }
    } else {
      // loot nearby weapons, else wait inside the next circle
      const has2 = m.weapons[1] != null
      if (!has2) {
        let best: Item | null = null, bd = 120
        for (const p of pickups) { const d = hyp(m.pos[0], m.pos[1], p.pos[0], p.pos[1]); if (d < bd && Math.abs(p.pos[2] - m.pos[2]) < 15) { bd = d; best = p } }
        if (best) { goal = [best.pos[0], best.pos[1]]; if (bd < 3.5) act.take = best.id }
      }
      if (!goal) {
        if (!m.goal || hyp(m.goal[0], m.goal[1], zn.next_center[0], zn.next_center[1]) > zn.next_radius * 0.7) {
          const a = rng.next() * TAU, r = Math.sqrt(rng.next()) * zn.next_radius * 0.6
          m.goal = [zn.next_center[0] + Math.cos(a) * r, zn.next_center[1] + Math.sin(a) * r]
        }
        if (hyp(m.pos[0], m.pos[1], m.goal[0], m.goal[1]) > 8) goal = m.goal
      }
      act.aim = [m.aim[0] + 0.3, 0]
    }
    // zone safety
    if (hyp(m.pos[0], m.pos[1], zc.cx, zc.cy) > zc.r - 5) goal = [zc.cx, zc.cy]
    if (goal) {
      const yaw = Math.atan2(goal[1] - m.pos[1], goal[0] - m.pos[0])
      act.move = [Math.cos(yaw), Math.sin(yaw)]
      if (wantFace != null) act.aim = [wantFace, 0]
      // climb over whatever is in the way
      const ahead = MAP.topAt(m.pos[0] + Math.cos(yaw) * 4, m.pos[1] + Math.sin(yaw) * 4)
      if (ahead > m.pos[2] + 1.2) { if (m.grounded) act.jump = true; else act.boost = true }
      if (!m.grounded && ahead > m.pos[2] - 1) act.boost = true
    }
    if (m.weapons.some((w) => w?.kind === "gun" && w.ammo < 4) && !enemy) act.reload = true
    return act
  }

  // --- NPC drones ---
  function npcStep(n: Npc) {
    const homeD = hyp(n.pos[0], n.pos[1], n.home[0], n.home[1])
    let tgt: Mech | null = n.target != null && n.target < 16 ? mechs[n.target] : null
    if (tgt && (!tgt.alive || hyp(n.pos[0], n.pos[1], tgt.pos[0], tgt.pos[1]) > cfg.npc.deaggro_range || homeD > cfg.npc.chase_leash)) { tgt = null; n.target = null }
    if (!tgt && homeD < cfg.npc.leash) {
      for (const m of mechs) {
        if (!m.alive) continue
        if (hyp(n.pos[0], n.pos[1], m.pos[0], m.pos[1]) < cfg.npc.aggro_range && los([n.pos[0], n.pos[1], n.pos[2] + 3], centerOf(m))) { tgt = m; n.target = m.id; break }
      }
    }
    let gx: number, gy: number
    if (tgt) { gx = tgt.pos[0]; gy = tgt.pos[1] } else {
      if (hyp(n.pos[0], n.pos[1], n.wanderGoal[0], n.wanderGoal[1]) < 2) { const a = rng.next() * TAU, r = rng.next() * cfg.npc.leash; n.wanderGoal = [n.home[0] + Math.cos(a) * r, n.home[1] + Math.sin(a) * r] }
      gx = n.wanderGoal[0]; gy = n.wanderGoal[1]
    }
    const d = hyp(n.pos[0], n.pos[1], gx, gy)
    const keep = tgt ? 20 : 0
    if (d > keep + 1) {
      const yaw = Math.atan2(gy - n.pos[1], gx - n.pos[0])
      const nx = n.pos[0] + Math.cos(yaw) * cfg.npc.speed * DT, ny = n.pos[1] + Math.sin(yaw) * cfg.npc.speed * DT
      if (MAP.topAt(nx, ny) <= n.pos[2] + 1.2) { n.pos = [nx, ny, MAP.topAt(nx, ny)]; n.vel = [Math.cos(yaw) * cfg.npc.speed, Math.sin(yaw) * cfg.npc.speed, 0] }
      else n.vel = [0, 0, 0]
    } else n.vel = [0, 0, 0]
    n.cooldown -= DT
    if (tgt) {
      n.aim = Math.atan2(tgt.pos[1] - n.pos[1], tgt.pos[0] - n.pos[0])
      const from: V3 = [n.pos[0], n.pos[1], n.pos[2] + 3]
      if (n.cooldown <= 0 && los(from, centerOf(tgt))) {
        n.cooldown = cfg.npc.cooldown
        const c = centerOf(tgt)
        const sp = (cfg.npc.spread_deg * Math.PI) / 180
        const yaw = Math.atan2(c[1] - from[1], c[0] - from[0]) + rng.gauss() * sp
        const pitch = Math.atan2(c[2] - from[2], hyp(from[0], from[1], c[0], c[1])) + rng.gauss() * sp
        const s = cfg.npc.projectile_speed
        projs.push({ id: newId(), kind: "npc", owner: n.id, pos: from, vel: [Math.cos(pitch) * Math.cos(yaw) * s, Math.cos(pitch) * Math.sin(yaw) * s, Math.sin(pitch) * s], dist: 0, dmg: cfg.npc.damage, range: 150, t0: t })
        emitSound("npc_gun", from, -1)
      }
    }
  }

  // --- main loop ---
  const maxT = opt.maxT ?? cfg.match.duration_s
  const decideEvery = cfg.match.decide_every
  let tick = 0
  const practice = opt.mode === "practice"
  const timing: number[] = []
  while (t < maxT) {
    // drops
    for (const ct of cfg.drops?.times ?? []) {
      if (Math.abs(t - ct) < DT / 2) {
        const zn = zoneAt(t + cfg.drops.fall_s)
        const p = openGroundPoint(rng, zn.next_center[0], zn.next_center[1], zn.next_radius * cfg.drops.spread)
        drops.push({ id: 20000 + drops.length, pos: p, landsAt: t + cfg.drops.fall_s, progress: 0, holder: null, taken: false, calledAt: t })
      }
    }
    if (tick % decideEvery === 0) {
      const hunters = practice ? houseHunters() : new Set<number>()
      const extActs = new Map<number, Promise<any>>()
      for (const m of mechs) {
        if (!m.alive || m.ctrl.kind !== "ext") continue
        if (!m.offer && m.offersPending > 0) { m.offersPending--; makeOffer(m) }
        if (m.offer && t >= m.offer.expires) { applyUpgrade(m, m.offer.choices[0].id); m.offer = null }
        extActs.set(m.id, m.ctrl.bot.act(buildObs(m, tick), extTimeout))
      }
      const extRes = new Map<number, any>()
      for (const [id, pr] of extActs) extRes.set(id, await pr)
      for (const m of mechs) {
        if (!m.alive) continue
        let a: any
        if (m.ctrl.kind === "ext") {
          a = extRes.get(m.id) ?? { move: m.action.move, aim: m.action.aim, boost: m.action.boost }
        } else if (m.ctrl.kind === "ours") {
          if (!m.offer && m.offersPending > 0) { m.offersPending--; makeOffer(m) }
          if (m.offer && t >= m.offer.expires) { applyUpgrade(m, m.offer.choices[0].id); m.offer = null }
          const obs = buildObs(m, tick)
          draw.clear()
          const t0 = performance.now()
          try { a = m.ctrl.act(obs) } catch (e) { if (opt.verbose) console.error(e); a = { move: m.action.move, aim: m.action.aim } }
          timing.push(performance.now() - t0)
          a.label = (draw.take() as any)?.label
          if (process.env.SIMTRACE && tick % 10 === 0 && (!process.env.TRACE_ID || String(m.id) === process.env.TRACE_ID)) {
            const en = mechs.filter((v) => v.alive && v.id !== m.id).map((v) => ({ v, d: hyp(m.pos[0], m.pos[1], v.pos[0], v.pos[1]) })).filter((q) => q.d < 200).sort((p, q) => p.d - q.d).slice(0, 3)
            const dmg = (obs.events as any[]).filter((e) => e.type === "damaged").map((e) => `${e.weapon}${Math.round(e.amount)}${e.rear ? "R" : ""}`).join(",")
            console.error(`t=${t.toFixed(1)} hp=${Math.round(m.hp)} en=${Math.round(m.energy)} w=${m.weapons.map((w) => w ? w.kind[0] + (w.kind === "gun" ? w.ammo : "") : "-").join("")} ${a.label} | ${en.map((q) => `${q.v.id}:${Math.round(q.d)}m${seesMech(m, q.v) ? "V" : ""}${(q.v.ctrl as any).tier}${q.v.weapons.map((w) => w ? w.kind[0] : "").join("")}`).join(" ")} | ${dmg}`)
          }
        } else {
          if (!m.offer && m.offersPending > 0) { m.offersPending--; makeOffer(m) }
          if (m.offer && t >= m.offer.expires) { applyUpgrade(m, m.offer.choices[0].id); m.offer = null }
          a = houseAct(m, hunters, practice)
        }
        m.action = a
        if (a.aim) m.cmdAim = [a.aim[0], Math.max(M.min_pitch, Math.min(M.max_pitch, a.aim[1]))]
        if (m.offer && a.pick != null && m.offer.choices[a.pick]) { applyUpgrade(m, m.offer.choices[a.pick].id); m.offer = null }
        if (a.reload) for (const w of m.weapons) if (w?.kind === "gun" && w.reload <= 0 && w.ammo < m.wstats.gun.mag) w.reload = m.wstats.gun.reload
        if (a.take != null) {
          const p = pickups.find((q) => q.id === a.take)
          if (!p) m.events.push({ type: "take_failed", id: a.take, reason: "gone" })
          else if (hyp(m.pos[0], m.pos[1], p.pos[0], p.pos[1]) > cfg.loot.pickup_radius || Math.abs(p.pos[2] - m.pos[2]) > 4) m.events.push({ type: "take_failed", id: a.take, reason: "range" })
          else if (m.weapons.some((w) => w?.kind === p.kind)) m.events.push({ type: "take_failed", id: a.take, reason: "have" })
          else {
            let slot = m.weapons.findIndex((w) => !w)
            if (slot < 0 && a.drop != null) slot = a.drop
            if (slot < 0) m.events.push({ type: "take_failed", id: a.take, reason: "full" })
            else {
              const old = m.weapons[slot]
              if (old) { const id = pickupSeq++; pickups.push({ id, pos: [...m.pos] as V3, kind: old.kind }); m.events.push({ type: "dropped", id, kind: old.kind, slot }) }
              pickups.splice(pickups.indexOf(p), 1)
              const k = p.kind as WK
              m.weapons[slot] = { kind: k, cooldown: 0, ammo: k === "gun" ? m.wstats.gun.mag : 0, reload: 0, charge: 0, held: 0, equip: Math.max(cfg.loot.equip_s, m.wstats[k].cooldown ?? 0) }
              m.events.push({ type: "took", id: p.id, kind: k, slot })
            }
          }
        }
      }
    }
    // physics + weapons per tick
    for (const m of mechs) {
      if (!m.alive) continue
      const a = m.action
      // torso slew
      const tr = (m.stats.turn_rate ?? 4) * DT, pr = (m.stats.pitch_rate ?? 3) * DT
      const dy = wrap(m.cmdAim[0] - m.aim[0])
      m.aim[0] = wrap(m.aim[0] + Math.max(-tr, Math.min(tr, dy)))
      m.aim[1] += Math.max(-pr, Math.min(pr, m.cmdAim[1] - m.aim[1]))
      // weapons
      const fire = a.fire ?? [false, false]
      m.weapons.forEach((w, i) => {
        if (!w) return
        w.cooldown = Math.max(0, w.cooldown - DT)
        w.equip = Math.max(0, w.equip - DT)
        if (w.kind === "gun" && w.reload > 0) { w.reload -= DT; if (w.reload <= 0) { w.reload = 0; w.ammo = m.wstats.gun.mag } }
        const held = !!fire[i] && tick % decideEvery < decideEvery
        if (w.kind === "laser") {
          if (m.shortUntil > t) { w.charge = 0; w.held = 0; return }
          if (held && w.cooldown <= 0 && w.equip <= 0) {
            if (w.charge < m.wstats.laser.charge) { if (w.charge === 0) emitSound("laser_charge", m.pos, m.id); w.charge = Math.min(m.wstats.laser.charge, w.charge + DT) }
            else { w.held += DT; if (w.held >= m.wstats.laser.hold_s) fireLaser(m, w) }
          } else if (w.charge > 0) {
            if (w.charge >= m.wstats.laser.min_charge) fireLaser(m, w)
            else w.charge += DT
          }
          return
        }
        if (!held || w.cooldown > 0 || w.equip > 0) return
        if (w.kind === "gun") { if (w.ammo > 0 && w.reload <= 0) fireGun(m, w) }
        else if (w.kind === "lightning") fireLightning(m, w)
        else if (w.kind === "mortar") fireMortar(m, w)
      })
      // movement
      const mv = a.move ?? [0, 0]
      const ml = Math.min(1, Math.hypot(mv[0], mv[1]))
      const md = ml > 1e-6 ? [mv[0] / Math.hypot(mv[0], mv[1]), mv[1] / Math.hypot(mv[0], mv[1])] : [0, 0]
      const charging = m.weapons.some((w) => w?.kind === "laser" && w.charge > 0)
      let spd = m.stats.walk_speed * ml
      let spent = false
      if (a.boost && m.grounded && ml > 0.1 && m.energy > 0) { spd = m.stats.boost_speed * ml; m.energy -= m.stats.boost_drain * DT; spent = true; if (tick % 10 === 0) emitSound("boost", m.pos, m.id) }
      if (charging) spd *= M.charge_move_mult
      const dvx = md[0] * spd - m.vel[0], dvy = md[1] * spd - m.vel[1]
      const acc = (m.grounded ? m.stats.ground_accel : m.stats.air_accel) * DT
      const dl = Math.hypot(dvx, dvy)
      if (dl > acc) { m.vel[0] += (dvx / dl) * acc; m.vel[1] += (dvy / dl) * acc } else { m.vel[0] += dvx; m.vel[1] += dvy }
      if (a.jump && m.grounded && tick % decideEvery === 0) { m.vel[2] = m.stats.jump_speed; m.grounded = false }
      if (a.boost && !m.grounded && m.energy > 0) { m.vel[2] = Math.min(m.stats.max_rise_speed, m.vel[2] + m.stats.jet_accel * DT); m.energy -= m.stats.jet_drain * DT; spent = true; if (tick % 10 === 0) emitSound("jet", m.pos, m.id) }
      m.vel[2] -= m.stats.gravity * DT
      if (spent) m.lastSpend = t
      else if (t - m.lastSpend > m.stats.energy_regen_delay) m.energy = Math.min(m.maxEnergy, m.energy + m.stats.energy_regen * DT)
      m.energy = Math.max(0, m.energy)
      const r = radiusOf(m), h = heightOf(m)
      const nx = m.pos[0] + m.vel[0] * DT, ny = m.pos[1] + m.vel[1] * DT
      const z = m.pos[2]
      if (bodyBlocked(m.pos[0], m.pos[1], z, r, h) || !bodyBlocked(nx, ny, z, r, h)) { m.pos[0] = nx; m.pos[1] = ny }
      else if (!bodyBlocked(nx, m.pos[1], z, r, h)) { m.pos[0] = nx; m.vel[1] = 0 }
      else if (!bodyBlocked(m.pos[0], ny, z, r, h)) { m.pos[1] = ny; m.vel[0] = 0 }
      else { m.vel[0] = 0; m.vel[1] = 0 }
      const g = groundUnder(m.pos[0], m.pos[1], z, r)
      let nz = z + m.vel[2] * DT
      const k = MAP.idx(m.pos[0], m.pos[1])
      const ob = MAP.ohBase[k]
      if (!Number.isNaN(ob) && z + h <= ob && nz + h > ob) { nz = ob - h; m.vel[2] = Math.min(0, m.vel[2]) }
      if (nz <= g) { nz = g; m.vel[2] = 0; m.grounded = true }
      else if (m.grounded && nz - g < 0.3 && m.vel[2] <= 0) { nz = g; m.vel[2] = 0 }
      else m.grounded = false
      m.pos[2] = nz
      // footsteps
      const hs = Math.hypot(m.vel[0], m.vel[1])
      if (m.grounded && hs > cfg.sound.step_speed && !(a.boost)) { m.stepAcc += DT; if (m.stepAcc >= cfg.sound.step_every) { m.stepAcc = 0; emitSound("step", m.pos, m.id) } }
    }
    // separate overlapping mechs
    for (let i = 0; i < mechs.length; i++) for (let j = i + 1; j < mechs.length; j++) {
      const a = mechs[i], b = mechs[j]
      if (!a.alive || !b.alive) continue
      const d = hyp(a.pos[0], a.pos[1], b.pos[0], b.pos[1]), rr = radiusOf(a) + radiusOf(b)
      if (d < rr && d > 1e-3 && Math.abs(a.pos[2] - b.pos[2]) < 8) {
        const push = (rr - d) / 2, ux = (b.pos[0] - a.pos[0]) / d, uy = (b.pos[1] - a.pos[1]) / d
        if (!bodyBlocked(a.pos[0] - ux * push, a.pos[1] - uy * push, a.pos[2], radiusOf(a), 9)) { a.pos[0] -= ux * push; a.pos[1] -= uy * push }
        if (!bodyBlocked(b.pos[0] + ux * push, b.pos[1] + uy * push, b.pos[2], radiusOf(b), 9)) { b.pos[0] += ux * push; b.pos[1] += uy * push }
      }
    }
    // projectiles
    for (let i = projs.length - 1; i >= 0; i--) {
      const p = projs[i]
      const a: V3 = [...p.pos] as V3
      if (p.kind === "mortar") p.vel[2] -= p.ws!.gravity * DT
      const b: V3 = [a[0] + p.vel[0] * DT, a[1] + p.vel[1] * DT, a[2] + p.vel[2] * DT]
      const segLen = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
      let sHit = firstSolid(a, b)
      let hitM: Mech | null = null, hitN: Npc | null = null, hitC: Item | null = null
      let bs = sHit < 0 ? 2 : sHit
      const pr = cfg.projectile.gun_radius ?? 0.3
      for (const v of mechs) { if (!v.alive || v.id === p.owner) continue; const s = segHitsCyl(a, b, v, radiusOf(v) + pr, heightOf(v)); if (s >= 0 && s < bs) { bs = s; hitM = v; hitN = null; hitC = null } }
      if (p.kind !== "npc") {
        for (const n of npcs) { if (!n.alive) continue; const s = segHitsCyl(a, b, n, cfg.npc.radius + pr, cfg.npc.height); if (s >= 0 && s < bs) { bs = s; hitN = n; hitM = null; hitC = null } }
        for (const c of crates) { if ((c.hp ?? 0) <= 0) continue; const s = segHitsCyl(a, b, c, cfg.crates.radius + pr, cfg.crates.height); if (s >= 0 && s < bs) { bs = s; hitC = c; hitM = null; hitN = null } }
      }
      if (bs <= 1) {
        const at: V3 = [a[0] + (b[0] - a[0]) * bs, a[1] + (b[1] - a[1]) * bs, a[2] + (b[2] - a[2]) * bs]
        if (p.kind === "mortar") explode(p, at, hitM)
        if (hitM && p.kind === "gun" && p.owner < 16) (mechs[p.owner] as any).hits = ((mechs[p.owner] as any).hits ?? 0) + 1
        if (p.kind === "mortar") { /* handled above */ }
        else if (hitM) damageMech(hitM, p.dmg, p.kind === "npc" ? "npc" : "gun", [a[0] - p.vel[0] * 0.2, a[1] - p.vel[1] * 0.2, a[2]], p.owner)
        else if (hitN) damageNpc(hitN, p.dmg, p.owner)
        else if (hitC) damageCrate(hitC, p.dmg, p.owner)
        if (p.kind === "npc" && hitM) { hitM.lastCombat = t }
        projs.splice(i, 1)
        continue
      }
      p.pos = b
      p.dist += segLen
      if (p.dist > p.range || t - p.t0 > 8 || !MAP.inBounds(b[0], b[1])) projs.splice(i, 1)
    }
    // npcs
    for (const n of npcs) if (n.alive) npcStep(n)
    // cubes
    for (let i = cubes.length - 1; i >= 0; i--) {
      const c = cubes[i]
      let best: Mech | null = null, bd = cfg.cubes.pickup_radius
      for (const m of mechs) { if (!m.alive) continue; const d = hyp(m.pos[0], m.pos[1], c.pos[0], c.pos[1]); if (d < bd && Math.abs(m.pos[2] - c.pos[2]) < 4) { bd = d; best = m } }
      if (best) { gainCube(best); cubes.splice(i, 1) }
    }
    // drops
    for (const d of drops) {
      if (d.taken || t < d.landsAt) continue
      const inRing = mechs.filter((m) => m.alive && hyp(m.pos[0], m.pos[1], d.pos[0], d.pos[1]) < cfg.drops.radius && Math.abs(m.pos[2] - d.pos[2]) < 6)
      if (inRing.length === 1) {
        if (d.holder !== inRing[0].id) { d.holder = inRing[0].id; d.progress = 0 }
        d.progress += DT
        if (d.progress >= cfg.drops.capture_s) {
          const m = inRing[0]
          d.taken = true
          gainCube(m, cfg.drops.cubes)
          m.hp = m.maxHp; m.energy = m.maxEnergy
          m.events.push({ type: "drop", id: d.id, cubes: m.cubes })
          ;(m as any).drops = ((m as any).drops ?? 0) + 1
        }
      } else if (inRing.length === 0) { d.holder = null; d.progress = 0 }
    }
    // zone + regen
    const zc = zoneCircle(t)
    for (const m of mechs) {
      if (!m.alive) continue
      m.inZone = hyp(m.pos[0], m.pos[1], zc.cx, zc.cy) <= zc.r
      if (!m.inZone) {
        m.hp -= zc.dps * DT
        m.lastCombat = t
        if (tick % decideEvery === 0) m.events.push({ type: "damaged", amount: zc.dps * DT * decideEvery, weapon: "zone", bearing: null, by: null })
        if (m.hp <= 0) killMech(m, null, "zone")
      } else if (t - m.lastCombat > m.stats.regen_delay && m.hp < m.maxHp) {
        m.hp = Math.min(m.maxHp, m.hp + m.stats.regen_per_s * DT)
      }
    }
    if (deathsThisTick.length) {
      const place = aliveCount - deathsThisTick.length + 1
      for (const v of deathsThisTick) v.place = place
      aliveCount -= deathsThisTick.length
      deathsThisTick.length = 0
    }
    for (const m of mechs) for (const s of m.sounds) s.age += DT
    t += DT
    tick++
    if (aliveCount <= 1) break
    if (ours.every((o) => !o.alive)) break
  }
  // survivors ranked by HP
  const surv = mechs.filter((m) => m.alive).sort((a, b) => b.hp - a.hp)
  surv.forEach((m, i) => { m.place = i + 1; m.deathT = t })
  // dead-early end (our bots all dead): remaining house bots outlive us; places already set for the dead
  const results: MechResult[] = mechs.map((m) => ({ id: m.id, label: m.ctrl.label, place: m.place, kills: m.kills, deathT: Math.round(m.deathT * 10) / 10, cubes: m.cubes, hp: Math.round(m.hp), cause: (m as any).cause ?? (m.alive ? "alive" : "?"), shots: (m as any).shots ?? 0, hits: (m as any).hits ?? 0, loadout: m.weapons.filter((w) => w).map((w) => w!.kind).join("+"), takenBy: (m as any).takenBy ?? {}, drops: (m as any).drops ?? 0, dealt: Math.round((m as any).dealt ?? 0), taken: Math.round((m as any).taken ?? 0) }))
  if (opt.verbose) {
    timing.sort((a, b) => a - b)
    console.error(`match t=${t.toFixed(1)} act p50 ${timing[timing.length >> 1]?.toFixed(2)} p99 ${timing[Math.floor(timing.length * 0.99)]?.toFixed(2)} max ${timing[timing.length - 1]?.toFixed(2)}`)
  }
  for (const m of mechs) if (m.ctrl.kind === "ext") m.ctrl.bot.end(m.place, m.kills)
  const extStats = mechs.filter((m) => m.ctrl.kind === "ext").map((m) => ({ label: m.ctrl.label, late: (m.ctrl as any).bot.late, answered: (m.ctrl as any).bot.answered }))
  if (opt.verbose && extStats.length) console.error(JSON.stringify(extStats))
  return { results, t }
}
