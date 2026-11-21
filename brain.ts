/** Mech Royale bot logic: zone-safe navigation, lead-aimed shooting, loot, dodging. */
import { type ActorObs, type BotAction, draw, type Hello, type Observation, type WeaponObs } from "./mechfight.ts"
import { GameMap } from "./map.ts"
import { NavGrid, Planner } from "./nav.ts"

type V3 = [number, number, number]

const TAU = Math.PI * 2
const wrap = (a: number) => {
  a = (a + Math.PI) % TAU
  if (a < 0) a += TAU
  return a - Math.PI
}
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const hyp2 = (ax: number, ay: number, bx: number, by: number) => Math.hypot(bx - ax, by - ay)

const UPGRADE_PRIO_FFA = [
  "plating", "armor", "nanites", "gun_rate", "lightning_efficiency", "laser_damage", "gun_damage",
  "laser_charge", "lightning_range", "gun_mag", "servos", "gun_velocity", "mortar_reload", "lightning_chain",
  "capacitor", "reactor", "jets", "gyros", "sensors", "mortar_splash", "mortar_velocity", "laser_pierce",
]
const UPGRADE_PRIO = [
  "armor", "plating", "gun_rate", "lightning_efficiency", "laser_damage", "gun_damage", "nanites",
  "laser_charge", "lightning_range", "gun_mag", "gun_velocity", "mortar_reload", "lightning_chain",
  "servos", "reactor", "capacitor", "jets", "gyros", "mortar_splash", "mortar_velocity", "sensors", "laser_pierce",
]
/** Behaviour switches, so A/B variants are one-line changes. */
export const PARAMS = {
  /** follow a mech that dropped out of sight (v1 did this whenever our HP was above 50%) */
  chaseAlways: false,
  /** v1 healing: stand still in place when below 60% HP; otherwise heal from cover if we can find it */
  healStill: false,
  /** practice: roam at full speed (looking for drones, crates, cubes) until this time */
  roamFastUntil: 150,
  /** duck into cover while the gun reloads or when losing the HP race */
  coverFight: true,
  /** practice too: only fight mechs that attack us, come close, or are nearly dead (never poke idle house bots) */
  selectiveFights: true,
  /** distance under which any visible mech is fought when fights are selective */
  engageRange: 55,
  /** with selective fights in practice: fight any visible mech within this distance */
  practiceEngageRange: 60,
  /** practice: instead of the plain engage range, fight mechs that aim at us (within this many radians; 0 = off) out to hunterRange, and any mech within hunterClose */
  hunterAim: 0,
  hunterRange: 150,
  hunterClose: 30,
  /** allow switching to the free-for-all survival policy */
  ffaMode: true,
  /** play the free-for-all policy from t=0 in every match */
  ffaStart: false,
  /** stricter free-for-all detector (fewer false triggers in practice) */
  strictDetect: true,
  /** with strictDetect: deaths of other mechs (not by us) that switch to the free-for-all policy before 120 s / before 200 s / at any time, and the mech-vs-mech fire evidence needed */
  ffaDead1: 4,
  ffaDead2: 5,
  ffaDead3: 7,
  ffaInfight: 4,
  /** preferred distance when we only have the gun */
  gunRange: 70,
  /** practice only: preferred distance with only the gun / with a laser (0 = same as gunRange / laserRange) */
  practiceGunRange: 140,
  practiceLaserRange: 130,
  /** sideways component while strafing in a fight (0..1) */
  strafe: 0.9,
  /** ignore mechs farther than this unless they are shooting at us */
  maxEngage: 200,
  /** shoot back at a drone that is hitting us before poking distant mechs */
  npcThreat: true,
  /** mechs closer than this keep priority over a drone that is hitting us (unless below 40% HP) */
  npcOverride: 80,
  /** a drone that is hitting us beats any mech above 40% HP */
  npcAlways: false,
  /** practice upgrade order override (comma list, best first); empty = built-in */
  upgradeOrder: "",
  /** free-for-all upgrade order override (comma list, best first); empty = built-in */
  upgradeOrderFfa: "",
  /** keep away from drones (they open fire within 45 m) while mechs are around or we are hurt */
  npcAvoid: false,
  /** strafe direction flips every flipMin + rand * flipRand seconds */
  /** target score: metres added per HP point of the target (lower HP = preferred) */
  hpWeight: 0.05,
  /** fraction of the target's velocity used for gun lead */
  leadScale: 1,
  /** per-decision smoothing factor for target velocity used in lead (1 = raw) */
  velSmooth: 1,
  /** adapt gun lead to how often the target changes velocity: acceleration (m/s^2) where lead starts dropping (0 = off) */
  adaptiveLead: 0,
  leadMin: 0.4,
  /** fight movement: irregular jinks across the line of fire (0 = off; value = weight of range keeping) */
  jink: 0,
  jinkMin: 0.3,
  jinkRand: 0.4,
  /** random spread (radians) around the perpendicular for each jink */
  jinkSpread: 1.0,
  /** free-for-all: a mech that hurt us stays engaged for this many seconds */
  engageMemory: 6,
  /** free-for-all: with nothing to shoot, keep looking toward the last threat for this many seconds */
  watchThreat: 4,
  /** free-for-all: in view of a mech we avoid and with no cover, sidestep at this speed fraction (0 = stand still; 0.42 stays silent) */
  hideJink: 0,
  /** free-for-all: target score metres per HP point (focus the weakest) */
  hpWeightFfa: 0.05,
  /** free-for-all: fight any visible mech below this HP fraction within weakRange */
  weakFrac: 0.4,
  weakRange: 150,
  /** free-for-all: also fight a mech that others damaged in the last 4 s, below thirdPartyFrac HP, within weakRange (0 = off) */
  thirdPartyFrac: 0,
  /** free-for-all: with two or more mechs hitting us, fight from a spot hidden from the others */
  multiCover: false,
  /** apply multiCover / multiRetreat in practice too */
  multiPractice: false,
  /** free-for-all: with two or more mechs hitting us and HP below this fraction, break off to cover (0 = off) */
  multiRetreat: 0,
  /** free-for-all: hold on a deep roof spot (no edge within 8 m) inside the next circle instead of a sheltered ground spot */
  ffaRoof: false,
  /** gun lead learned per target: score several lead predictors on each mech's observed track and aim with the best */
  aimLearn: true,
  /** strafe flips always reverse direction (instead of a random new side) */
  flipAlt: true,
  /** also fire the gun when the commanded aim is within one tick of torso slew (the torso turns before the shot leaves) */
  fireSlew: false,
  /** multiplier on the aim error we accept before firing the gun */
  fireTol: 1,
  /** the same in free-for-all mode */
  fireTolFfa: 1,
  /** sidestep incoming gun bullets */
  dodgeBullets: false,
  /** charging lasers aimed at us: 0 ignore, 1 duck into cover if any, 2 also jink sideways when there is none */
  laserDodge: 1,
  /** step out of a mortar shell's landing zone */
  dodgeMortar: true,
  /** below 60% HP with no target, move out of sight of the last threat */
  healCover: true,
  /** go for cubes this far away even while a target is in view */
  cubeFightRange: 25,
  /** practice: after this time, wait on a roof near the next circle instead of roaming (0 = off) */
  roofAfter: 0,
  /** practice: before this time, actively walk to remembered drones to farm cubes (0 = off) */
  farmUntil: 0,
  flipMin: 0.35,
  flipRand: 0.4,
  /** when two or more mechs are on us, back off to a longer range */
  kite: false,
  /** score bonus (metres) for a mech that hurt us in the last 4 s */
  attackerBonus: 40,
  /** swing round to face a mech that is hitting us from out of view */
  faceAttacker: false,
  /** do not start healing until this long after the last hit */
  healCalm: 0,
  /** in a fight with other mechs around, move to a nearby spot that keeps the target in sight but hides us from the others */
  fightPos: false,
  /** after a fight, sit in a sheltered spot until HP is back above this fraction (0 = off) */
  healTo: 0,
  /** second-weapon preference, best first */
  weaponOrder: "laser,lightning,mortar",
  /** with a laser in hand, open fights out to this range */
  laserEngage: 150,
  /** preferred distance with a laser in hand */
  laserRange: 90,
  /** preferred distance with lightning in hand */
  lightningRange: 28,
}

const WEAPON_PRIO: Record<string, number> = { lightning: 3, laser: 2, mortar: 1, gun: 0 }

class Rng {
  s: number
  constructor(seed: number) { this.s = (seed >>> 0) || 1 }
  next() {
    let x = this.s
    x ^= x << 13; x >>>= 0
    x ^= x >>> 17
    x ^= x << 5; x >>>= 0
    this.s = x
    return x / 4294967296
  }
}

/** Map and nav grid are read-only, so several bots in one process (the simulator) can share them. */
const sharedMaps = new Map<string, { map: GameMap; nav: NavGrid | null }>()

export function makeBot(hello: Hello, overrides: Partial<typeof PARAMS> = {}) {
  const P = { ...PARAMS, ...overrides }
  const wprio: Record<string, number> = { gun: 0 }
  P.weaponOrder.split(",").forEach((k, i, arr) => { wprio[k] = arr.length - i })
  const cfg = hello.config
  const mapKey = hello.map.dir + "|" + hello.map.files.join(",")
  let shared = sharedMaps.get(mapKey)
  const firstLoad = !shared
  if (!shared) {
    const m = new GameMap(hello.map.dir, hello.map.files)
    let n: NavGrid | null = null
    if (m.ok) {
      try { n = new NavGrid(m) } catch (e) { console.error("nav init failed", e) }
    }
    shared = { map: m, nav: n }
    sharedMaps.set(mapKey, shared)
  }
  const map = shared.map
  const rng = new Rng(hello.seed)
  const W = cfg.weapons
  const stepUp = cfg.mech.step_up ?? 1.2

  // --- memory ---
  let lastT = 0
  let actT0 = 0
  let threatYaw: number | null = null
  let threatT = -99
  const posHist: { t: number; x: number; y: number; z: number }[] = []
  let stuckUntil = -1
  let stuckDir = 0
  let detourSign = 1
  let strafeSign = 1
  let strafeFlipT = 0
  let wanderGoal: [number, number] | null = null
  let wanderT = -99
  let wanderFfa = false
  let wanderNc: [number, number] = [0, 0]
  let goalId = -1
  let goalSince = 0
  const blacklist = new Map<number, number>() // id -> until t
  let climbing = false
  let lastTargetId = -1
  let lastDamageT = -99
  let dodgeUntil = -1
  let dodgeDir = 0
  let stuckCount = 0
  let jinkUntil = -1
  const jinkiness = new Map<number, { vx: number; vy: number; t: number; acc: number }>()
  const velEma = new Map<number, { vx: number; vy: number; t: number }>()
  let jinkYaw = 0
  let jinkSpeed = 1
  let lastHitBy = -1
  let fightSpot: { t: number; p: [number, number] | null; id: number } | null = null
  let healSpot: [number, number] | null = null
  const knownNpcs = new Map<number, { x: number; y: number; t: number }>()
  const recentMechs = new Map<number, { pos: [number, number, number]; t: number }>()
  let lastHitBearing = 0
  let lastHitT = -99
  /** weapons seen on the ground (they never despawn; forgotten once we see the spot empty) */
  const knownPickups = new Map<number, { kind: string; pos: [number, number, number]; t: number }>()
  let goalBudget = 10
  // practice (house squad hunting us) vs free-for-all detection
  let ffa = P.ffaStart
  const lastHitOn = new Map<number, number>()
  const hurtByOther = new Map<number, number>() // mech id -> last time it lost HP to someone else
  let ourKills = 0
  let infight = 0
  const lastHp = new Map<number, number>()
  let lastMechSeenT = -99
  const chargeStart = new Map<number, number>()
  let dodgeBoost = false
  let dodgeCover = false
  const lastVis = new Map<number, number>() // mech id -> last time we had line of sight
  const attackers = new Map<number, number>() // mech id -> last time it hurt us
  // per-mech track for learned lead: recent positions, pending predictions, and a hit-rate score per predictor
  // lead predictors: k >= 0 scales the current velocity; -1 mean velocity over 0.6 s, -2 half of it;
  // -3 velocity extrapolated with the latest acceleration (capped at walk speed); -4 / -5: 0.75 v plus half / a quarter of the acceleration term
  const LEAD_K = [1, 0.75, 0.5, 0.25, 0, -1, -2, -3, -4, -5]
  type Track = { h: { t: number; x: number; y: number; vx: number; vy: number }[]; pend: { due: number; ux: number; uy: number; r: number; px: number[]; py: number[] }[]; sc: number[]; n: number; seen: number }
  const tracks = new Map<number, Track>()
  const trackAt = (tk: Track, tt: number): [number, number] | null => {
    const h = tk.h
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].t <= tt && h[i].t >= tt) {
        const f = (tt - h[i - 1].t) / Math.max(1e-6, h[i].t - h[i - 1].t)
        return [h[i - 1].x + (h[i].x - h[i - 1].x) * f, h[i - 1].y + (h[i].y - h[i - 1].y) * f]
      }
    }
    return null
  }
  const meanVel = (tk: Track, w: number): [number, number] | null => {
    const h = tk.h
    if (h.length < 2) return null
    const last = h[h.length - 1]
    let j = h.length - 1
    while (j > 0 && last.t - h[j - 1].t <= w + 0.01) j--
    const dt = last.t - h[j].t
    if (dt < w * 0.6) return null
    return [(last.x - h[j].x) / dt, (last.y - h[j].y) / dt]
  }
  const predVel = (tk: Track, k: number, vx: number, vy: number, tau = 0.4): [number, number] => {
    if (k >= 0) return [vx * k, vy * k]
    if (k <= -3) {
      const h = tk.h, n = h.length
      let ax = 0, ay = 0
      if (n >= 2 && h[n - 1].t - h[n - 2].t < 0.25) {
        const dt = Math.max(0.05, h[n - 1].t - h[n - 2].t)
        ax = (h[n - 1].vx - h[n - 2].vx) / dt; ay = (h[n - 1].vy - h[n - 2].vy) / dt
        const am = Math.hypot(ax, ay)
        if (am > 58.5) { ax *= 58.5 / am; ay *= 58.5 / am }
      }
      if (k === -3) {
        let ex = vx + ax * tau * 0.5, ey = vy + ay * tau * 0.5
        const sp = Math.hypot(ex, ey), cap = Math.max(11.7, Math.hypot(vx, vy))
        if (sp > cap) { ex *= cap / sp; ey *= cap / sp }
        return [(vx + ex) / 2, (vy + ey) / 2]
      }
      const af = k === -4 ? 0.5 : 0.25
      return [vx * 0.75 + 0.5 * ax * tau * af, vy * 0.75 + 0.5 * ay * tau * af]
    }
    const mv = meanVel(tk, 0.6)
    if (!mv) return [vx * 0.5, vy * 0.5]
    return k === -1 ? mv : [mv[0] * 0.5, mv[1] * 0.5]
  }

  function zoneNow(obs: Observation) {
    const z = obs.zone
    const ss = z.shrink_start, se = z.shrink_end
    const f = obs.t <= ss ? 0 : obs.t >= se ? 1 : (obs.t - ss) / Math.max(1e-6, se - ss)
    return {
      cx: z.center[0] + (z.next_center[0] - z.center[0]) * f,
      cy: z.center[1] + (z.next_center[1] - z.center[1]) * f,
      r: z.radius + (z.next_radius - z.radius) * f,
    }
  }

  /** Fraction of 8 directions with something solid within 16 m at body height: how sheltered a spot is. */
  function coverScore(px: number, py: number, pz: number): number {
    let blocked = 0
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4
      for (const r of [4, 8, 12, 16]) {
        if (map.solid(px + Math.cos(a) * r, py + Math.sin(a) * r, pz + 5)) { blocked++; break }
      }
    }
    return blocked / 8
  }
  /** Best sheltered, reachable-looking spot within `rad` of (nx,ny) that stays within `rIn` of the circle centre. */
  function pickHold(nx: number, ny: number, rad: number, cx: number, cy: number, rIn: number, z: number): [number, number] {
    let best: [number, number] = [nx, ny], bestSc = -Infinity
    for (let k = 0; k < 40; k++) {
      const a = rng.next() * TAU, r = k === 0 ? 0 : Math.sqrt(rng.next()) * rad
      const px = nx + Math.cos(a) * r, py = ny + Math.sin(a) * r
      if (!map.inBounds(px, py) || hyp2(px, py, cx, cy) > rIn + 1) continue
      const pz = map.topAt(px, py)
      if (pz - map.groundAt(px, py) > 30) continue
      // the body must fit: nothing tall within 3 m
      let fits = true
      for (let q = 0; q < 8 && fits; q++) if (map.topAt(px + Math.cos(q * 0.785) * 3, py + Math.sin(q * 0.785) * 3) > pz + 1.2) fits = false
      if (!fits) continue
      const sc = coverScore(px, py, pz) - r / 120 - Math.abs(pz - z) / 200
      if (sc > bestSc) { bestSc = sc; best = [px, py] }
    }
    return best
  }

  /** A flat roof spot 8-30 m up, near an edge, inside the circle, close to (nx,ny); null if none. */
  function pickRoof(nx: number, ny: number, rad: number, cx: number, cy: number, rIn: number, deep = false): [number, number] | null {
    let best: [number, number] | null = null, bestSc = -Infinity
    for (let k = 0; k < 120; k++) {
      const a = rng.next() * TAU, r = Math.sqrt(rng.next()) * rad
      const px = nx + Math.cos(a) * r, py = ny + Math.sin(a) * r
      if (!map.inBounds(px, py) || hyp2(px, py, cx, cy) > rIn) continue
      const pz = map.topAt(px, py), g = map.groundAt(px, py)
      if (pz - g < 8 || pz - g > 30) continue
      let flat = true, edges = 0
      for (let q = 0; q < 8 && flat; q++) {
        const ax = Math.cos(q * 0.785), ay = Math.sin(q * 0.785)
        const h3 = map.topAt(px + ax * 3.5, py + ay * 3.5)
        if (Math.abs(h3 - pz) > 1) flat = false
        if (map.topAt(px + ax * 8, py + ay * 8) < pz - 4) edges++
      }
      if (!flat || (deep ? edges > 0 : edges === 0 || edges > 4)) continue
      const sc = -r / 60 - Math.abs(edges - 2) * 0.2
      if (sc > bestSc) { bestSc = sc; best = [px, py] }
    }
    return best
  }
  let roofSpot: [number, number] | null = null
  let roofNc: [number, number] = [1e9, 1e9]

  /** Pull a goal point inside the current (moving) circle, keeping a margin from its edge. */
  function clampToZone(g: [number, number], zn: { cx: number; cy: number; r: number }): [number, number] {
    const lim = Math.max(0, zn.r - Math.max(6, zn.r * 0.35))
    const d = hyp2(zn.cx, zn.cy, g[0], g[1])
    if (d <= lim) return g
    return [zn.cx + ((g[0] - zn.cx) / d) * lim, zn.cy + ((g[1] - zn.cy) / d) * lim]
  }

  /** Steering with a short obstacle probe. Returns [mx,my,jump,boost]. */
  function steer(obs: Observation, yaw: number, speed: number): { mx: number; my: number; jump: boolean; boost: boolean } {
    const me = obs.self
    const [x, y, z] = me.pos
    const lim = z + stepUp + 0.3
    const blocked = (a: number): number => {
      // returns obstacle height above us (0 = clear)
      let worst = 0
      for (const d of [3.2, 5, 7]) {
        for (const lat of [-1.8, 0, 1.8]) {
          const px = x + Math.cos(a) * d - Math.sin(a) * lat
          const py = y + Math.sin(a) * d + Math.cos(a) * lat
          if (!map.inBounds(px, py)) return 99
          const h = map.topAt(px, py)
          if (h > lim) worst = Math.max(worst, h - z)
        }
      }
      return worst
    }
    let jump = false, boost = false
    if (!map.ok) return { mx: Math.cos(yaw) * speed, my: Math.sin(yaw) * speed, jump, boost }
    const h0 = blocked(yaw)
    let dir = yaw
    if (h0 > 0) {
      let found = false
      const offs = [0.35, 0.7, 1.05, 1.4, 1.75]
      for (const o of offs) {
        for (const sgn of [detourSign, -detourSign]) {
          if (blocked(yaw + sgn * o) === 0) {
            dir = yaw + sgn * o
            detourSign = sgn
            found = true
            break
          }
        }
        if (found) break
      }
      const climbable = h0 < 45 && me.energy > 15 + h0 * 1.4
      if (!found || climbing) {
        if (climbable) {
          dir = yaw
          climbing = true
        } else if (!found) {
          dir = yaw + detourSign * 1.6
        }
      }
    } else climbing = false
    if (climbing) {
      if (me.grounded) jump = true
      else boost = true
      // stop jetting once our feet clear the obstacle ahead
      const ahead = map.topAt(x + Math.cos(dir) * 4, y + Math.sin(dir) * 4)
      if (!me.grounded && z > ahead + 1.0) boost = false
      if (h0 === 0 && me.grounded) climbing = false
    }
    return { mx: Math.cos(dir) * speed, my: Math.sin(dir) * speed, jump, boost }
  }

  // --- path planning ---
  let nav: NavGrid | null = null
  let planner: Planner | null = null
  if (map.ok && shared.nav) {
    try {
      nav = shared.nav
      planner = new Planner(nav)
      // warm up the JIT on the hot paths (planner, line of sight) while the hello budget is generous
      const w0 = performance.now()
      const pts = [[0, 0, 300, 200], [-300, -200, 250, 250], [200, -250, -250, 150], [-100, 250, 100, -250]]
      for (let rep = 0; rep < (firstLoad ? 3 : 0) && performance.now() - w0 < 4000; rep++) {
        for (const [ax, ay, bx, by] of pts) {
          planner.begin(ax, ay, map.topAt(ax, ay), bx, by)
          while (planner.step(50) === "running" && performance.now() - w0 < 4000) {}
          map.los(ax, ay, map.topAt(ax, ay) + 8, bx, by, map.topAt(bx, by) + 4.5)
        }
      }
      planner.state = "idle"
    } catch (e) {
      console.error("nav init failed", e)
    }
  }
  let plan: { gx: number; gy: number; path: number[]; ptr: number; t: number } | null = null
  let pending: { gx: number; gy: number } | null = null
  let forceReplan = false
  let navLabel = ""

  /** Is the straight line from (x,y) to (bx,by) walkable for a body standing at z? */
  function lineClear(x: number, y: number, z: number, bx: number, by: number): boolean {
    const d = hyp2(x, y, bx, by)
    const n = Math.ceil(d)
    const ux = (bx - x) / Math.max(d, 1e-6), uy = (by - y) / Math.max(d, 1e-6)
    const lim = z + stepUp
    for (let s = 1; s <= n; s++) {
      const f = Math.min(s, d)
      const px = x + ux * f, py = y + uy * f
      for (const lat of [-1.6, 0, 1.6]) {
        if (map.topAt(px - uy * lat, py + ux * lat) > lim) return false
      }
    }
    return true
  }

  /** Closest walkable spot within maxR of us that a viewer at (ex,ey,ez) cannot see. */
  function findCover(x: number, y: number, z: number, ex: number, ey: number, ez: number, maxR: number): [number, number] | null {
    for (const r of [3, 5, 7.5, 10, 13, 16, 20]) {
      if (r > maxR) break
      let best: [number, number] | null = null, bestScore = Infinity
      for (let k = 0; k < 16; k++) {
        const a = (k * Math.PI) / 8
        const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r
        const pz = map.topAt(px, py)
        if (pz > z + stepUp || pz < z - 6) continue
        if (!lineClear(x, y, z, px, py)) continue
        if (map.los(ex, ey, ez, px, py, pz + 4.5) || map.los(ex, ey, ez, px, py, pz + 8.5)) continue
        // prefer spots that do not move us toward the viewer
        const sc = -hyp2(px, py, ex, ey)
        if (sc < bestScore) { bestScore = sc; best = [px, py] }
      }
      if (best) return best
    }
    return null
  }
  let coverCache: { id: number; t: number; p: [number, number] | null } | null = null


  /** Move toward (gx,gy) along a planned path; falls back to local steering. */
  function navMove(obs: Observation, gx: number, gy: number, speed: number): { mx: number; my: number; jump: boolean; boost: boolean } {
    const me = obs.self
    const [x, y, z] = me.pos
    const t = obs.t
    const dGoal = hyp2(x, y, gx, gy)
    if (!nav || !planner) return steer(obs, Math.atan2(gy - y, gx - x), speed)
    if (dGoal < 10 && lineClear(x, y, z, gx, gy)) {
      navLabel = "direct"
      return steer(obs, Math.atan2(gy - y, gx - x), Math.min(speed, 0.3 + dGoal / 10))
    }
    // replanning
    const goalMoved = !plan || hyp2(plan.gx, plan.gy, gx, gy) > Math.max(8, dGoal * 0.15)
    let offPath = false
    if (plan && plan.path.length) {
      const c = plan.path[Math.min(plan.ptr, plan.path.length - 1)]
      offPath = hyp2(x, y, nav.cx(c), nav.cy(c)) > 10
    }
    const stale = plan != null && t - plan.t > 5
    if ((goalMoved || offPath || stale || forceReplan) && planner.state !== "running") {
      planner.begin(x, y, z, gx, gy)
      pending = { gx, gy }
      forceReplan = false
    } else if (planner.state === "running" && pending && hyp2(pending.gx, pending.gy, gx, gy) > Math.max(15, dGoal * 0.3)) {
      planner.begin(x, y, z, gx, gy)
      pending = { gx, gy }
    }
    if (planner.state === "running") {
      const r = planner.step(Math.max(0.5, Math.min(5, 15 - (performance.now() - actT0))), me.max_energy)
      if (r === "done" && pending) {
        plan = { gx: pending.gx, gy: pending.gy, path: planner.path.slice(), ptr: 0, t }
        planner.state = "idle"
      } else if (r === "fail") planner.state = "idle"
    }
    if (!plan || plan.path.length < 2 || hyp2(plan.gx, plan.gy, gx, gy) > 40) {
      navLabel = "steer"
      return steer(obs, Math.atan2(gy - y, gx - x), speed)
    }
    // follow
    const P = plan.path
    let best = plan.ptr, bd = Infinity
    for (let i = plan.ptr; i < Math.min(P.length, plan.ptr + 25); i++) {
      const d = hyp2(x, y, nav.cx(P[i]), nav.cy(P[i])) - (i - plan.ptr) * 0.05
      if (d < bd) { bd = d; best = i }
    }
    plan.ptr = best
    if (best >= P.length - 1) {
      navLabel = "end"
      return steer(obs, Math.atan2(gy - y, gx - x), speed)
    }
    const H = nav.h
    // climb needed soon?
    let climbIdx = -1
    for (let i = best + 1; i < Math.min(P.length, best + 4); i++) {
      const prevH = i === best + 1 ? z + 0.4 : H[P[i - 1]]
      if (H[P[i]] > prevH + stepUp - 0.1 || H[P[i]] > z + 2.5) { climbIdx = i; break }
      if (hyp2(x, y, nav.cx(P[i]), nav.cy(P[i])) > 6) break
    }
    if (climbIdx >= 0) {
      let hT = H[P[climbIdx]]
      for (let i = climbIdx; i < Math.min(P.length, climbIdx + 3); i++) hT = Math.max(hT, H[P[i]])
      const need = (hT - z) * 1.6 + 6
      const tx = nav.cx(P[Math.min(P.length - 1, climbIdx + 1)]), ty = nav.cy(P[Math.min(P.length - 1, climbIdx + 1)])
      const yaw = Math.atan2(ty - y, tx - x)
      navLabel = `climb ${Math.round(hT - z)}`
      if (me.grounded && me.energy < need && me.energy < me.max_energy - 2) {
        // wait for energy at the wall
        return { mx: Math.cos(yaw) * 0.2, my: Math.sin(yaw) * 0.2, jump: false, boost: false }
      }
      const up = z < hT + 0.8
      return { mx: Math.cos(yaw), my: Math.sin(yaw), jump: me.grounded && up, boost: !me.grounded && up }
    }
    // lookahead: farthest path point reachable in a straight line without climbing
    let tgt = best + 1
    for (let i = Math.min(P.length - 1, best + 10); i > best + 1; i--) {
      let ok = true
      for (let k = best + 1; k <= i; k++) if (H[P[k]] > (k === best + 1 ? z + 0.4 : H[P[k - 1]]) + stepUp - 0.1 || H[P[k]] > z + 2.5) { ok = false; break }
      if (ok && lineClear(x, y, z, nav.cx(P[i]), nav.cy(P[i]))) { tgt = i; break }
    }
    const tx = nav.cx(P[tgt]), ty = nav.cy(P[tgt])
    navLabel = `path ${P.length - best}`
    // airborne after a climb: keep jetting over the lip if the surface under the target is above us
    const yaw = Math.atan2(ty - y, tx - x)
    const boostAir = !me.grounded && H[P[tgt]] > z - 0.5 && me.vel[2] < 2
    const sp = me.grounded ? speed : 1
    return { mx: Math.cos(yaw) * sp, my: Math.sin(yaw) * sp, jump: false, boost: boostAir }
  }

  function targetHeight(a: ActorObs): number {
    if (a.kind === "npc") return (cfg.npc.height ?? 3.5) * 0.5
    const s = 1 + (cfg.cubes.size_per_cube as number ?? 0.05) * (a.cubes ?? 0)
    return (cfg.mech.height ?? 9) * s * 0.5
  }
  function targetRadius(a: ActorObs): number {
    if (a.kind === "npc") return cfg.npc.radius ?? 1.8
    const s = 1 + (cfg.cubes.size_per_cube as number ?? 0.05) * (a.cubes ?? 0)
    return (cfg.mech.radius ?? 2.5) * s
  }

  /** Lead solution for a straight-flying projectile. Returns aim point. */
  function lead(mx: number, my: number, mz: number, p: V3, v: V3, speed: number, latency: number): V3 {
    const px = p[0] + v[0] * latency, py = p[1] + v[1] * latency, pz = p[2] + v[2] * latency
    const dx = px - mx, dy = py - my, dz = pz - mz
    const a = v[0] * v[0] + v[1] * v[1] + v[2] * v[2] - speed * speed
    const b = 2 * (dx * v[0] + dy * v[1] + dz * v[2])
    const c = dx * dx + dy * dy + dz * dz
    let t = Math.sqrt(c) / speed
    const disc = b * b - 4 * a * c
    if (Math.abs(a) > 1e-6 && disc >= 0) {
      const s = Math.sqrt(disc)
      const t1 = (-b - s) / (2 * a), t2 = (-b + s) / (2 * a)
      const cands = [t1, t2].filter((q) => q > 0)
      if (cands.length) t = Math.min(...cands)
    }
    t = Math.min(t, 2)
    return [px + v[0] * t, py + v[1] * t, pz + v[2] * t]
  }

  /** Mortar pitch for horizontal distance R and height difference dz. */
  function mortarPitch(R: number, dz: number, high: boolean, speed: number, g: number): number | null {
    const v2 = speed * speed
    const disc = v2 * v2 - g * (g * R * R + 2 * dz * v2)
    if (disc < 0) return null
    const s = Math.sqrt(disc)
    return Math.atan((v2 + (high ? s : -s)) / (g * R))
  }

  function act(obs: Observation): BotAction {
    actT0 = performance.now()
    const me = obs.self
    const [x, y, z] = me.pos
    const t = obs.t
    const dt = Math.max(0.05, t - lastT)
    lastT = t
    const st = me.stats
    const muzzleH = st.muzzle_height ?? 7
    const walk = st.walk_speed ?? 11.7
    const act: BotAction = {}
    if (obs.offer) {
      let best = 0, bestScore = -1
      obs.offer.choices.forEach((c, i) => {
        const r = (ffa ? (P.upgradeOrderFfa ? P.upgradeOrderFfa.split(",") : UPGRADE_PRIO_FFA) : P.upgradeOrder ? P.upgradeOrder.split(",") : UPGRADE_PRIO).indexOf(c.id)
        const sc = r < 0 ? 0 : 100 - r
        if (sc > bestScore) { bestScore = sc; best = i }
      })
      act.pick = best
    }

    // --- events ---
    for (const e of obs.events) {
      if (e.type === "damaged") {
        lastDamageT = t
        if (e.bearing != null && e.by != null) {
          threatYaw = e.bearing
          threatT = t
          attackers.set(e.by, t)
          if (e.by < 100) { lastHitBy = e.by; lastHitBearing = e.bearing; lastHitT = t }
        }
      }
    }
    const hitNow = new Set<number>()
    for (const e of obs.events) {
      if (e.type === "kill") ourKills++
      else if (e.type === "hit") { hitNow.add(e.target); lastHitOn.set(e.target, t) }
    }
    if (!ffa) {
      const totalMechs = cfg.match.mechs ?? 16
      const othersDead = totalMechs - obs.alive - ourKills
      // beams that end on a mech other than us: mechs fighting each other
      for (const b of obs.beams) {
        const end = b.path[b.path.length - 1]
        if (!end) continue
        for (const m of obs.mechs) {
          if (m.kind !== "mech" || m.id === b.by) continue
          // ignore shots aimed at us that happen to end near someone standing next to us
          if (P.strictDetect && hyp2(end[0], end[1], x, y) < 15) break
          if (hyp2(end[0], end[1], m.pos[0], m.pos[1]) < 4) { infight += 1; if (process.env.FFA_DEBUG) console.error(`beam t=${t} by=${b.by} kind=${b.kind} on=${m.id} dUs=${hyp2(end[0], end[1], x, y).toFixed(1)}`); break }
        }
      }
      for (const m of obs.mechs) {
        if (m.kind !== "mech" || m.hp == null) continue
        const prev = lastHp.get(m.id)
        const recentHit = P.strictDetect && t - (lastHitOn.get(m.id) ?? -99) < 0.6
        if (prev != null && m.hp < prev - 40 && !hitNow.has(m.id) && !recentHit) { infight += 0.5; if (process.env.FFA_DEBUG) console.error(`hpdrop t=${t} id=${m.id} ${prev}->${m.hp}`) }
      }
      const d1 = P.strictDetect ? P.ffaDead1 : 2, d2 = P.strictDetect ? P.ffaDead2 : 3, d3 = P.strictDetect ? P.ffaDead3 : 6
      if (P.ffaMode && ((othersDead >= d1 && t < 120) || (othersDead >= d2 && t < 200) || othersDead >= d3 || infight >= (P.strictDetect ? P.ffaInfight : 3))) {
        ffa = true
        if (process.env.FFA_DEBUG) console.error(`ffa t=${t} dead=${othersDead} kills=${ourKills} alive=${obs.alive} infight=${infight}`)
      }
    }
    for (const m of obs.mechs) {
      if (m.kind !== "mech" || m.hp == null) continue
      const prev = lastHp.get(m.id)
      if (prev != null && m.hp < prev - 30 && !hitNow.has(m.id)) hurtByOther.set(m.id, t)
    }
    for (const m of obs.mechs) if (m.kind === "mech" && m.hp != null) lastHp.set(m.id, m.hp)
    for (const s of obs.sounds) {
      if ((s.kind === "gun" || s.kind === "laser" || s.kind === "laser_charge" || s.kind === "lightning" || s.kind === "mortar" || s.kind === "step" || s.kind === "boost" || s.kind === "jet") && s.dist !== "far") {
        if (t - threatT > 1.5) {
          threatYaw = s.bearing
          threatT = t - 0.5
        }
      }
    }

    for (const m of obs.mechs) if (m.kind === "npc" && (m.hp ?? 1) > 0) knownNpcs.set(m.id, { x: m.pos[0], y: m.pos[1], t })
    for (const e of obs.events) if (e.type === "kill" || (e.type === "hit" && e.target >= 100 && e.target < 1000)) { /* hits keep the record */ }
    for (const [id, r] of knownNpcs) if (t - r.t > 90 || (hyp2(x, y, r.x, r.y) < 40 && !obs.mechs.some((m) => m.id === id) && t - r.t > 2)) knownNpcs.delete(id)
    for (const m of obs.mechs) {
      if (m.kind !== "mech") continue
      const j = jinkiness.get(m.id)
      if (j && t - j.t < 0.35) {
        const a = Math.hypot(m.vel[0] - j.vx, m.vel[1] - j.vy) / Math.max(0.05, t - j.t)
        j.acc += (a - j.acc) * 0.15
        j.vx = m.vel[0]; j.vy = m.vel[1]; j.t = t
      } else jinkiness.set(m.id, { vx: m.vel[0], vy: m.vel[1], t, acc: j ? j.acc : 0 })
    }
    for (const m of obs.mechs) if (m.kind === "mech") recentMechs.set(m.id, { pos: [m.pos[0], m.pos[1], m.pos[2]], t })
    if (P.aimLearn) {
      const gsp = (me.weapons.find((w) => w?.kind === "gun") as WeaponObs | undefined)?.stats.speed ?? W.gun.speed
      for (const m of obs.mechs) {
        if (m.kind !== "mech") continue
        const d = hyp2(x, y, m.pos[0], m.pos[1])
        if (d > 260) continue
        let tk = tracks.get(m.id)
        if (!tk || t - tk.seen > 1.5) { tk = { h: [], pend: [], sc: LEAD_K.map((k) => (k === 1 ? 0.62 : k === 0.75 || k === -3 ? 0.6 : 0.58)), n: 0, seen: t }; tracks.set(m.id, tk) }
        tk.seen = t
        tk.h.push({ t, x: m.pos[0], y: m.pos[1], vx: m.vel[0], vy: m.vel[1] })
        while (tk.h.length > 24) tk.h.shift()
        // score predictions that have come due
        for (let i = tk.pend.length - 1; i >= 0; i--) {
          const q = tk.pend[i]
          if (q.due > t) continue
          const a = trackAt(tk, q.due)
          tk.pend.splice(i, 1)
          if (!a) continue
          for (let k = 0; k < LEAD_K.length; k++) {
            const lat = Math.abs((a[0] - q.px[k]) * q.ux + (a[1] - q.py[k]) * q.uy)
            tk.sc[k] += ((lat < q.r ? 1 : 0) - tk.sc[k]) * 0.08
          }
          tk.n++
        }
        // new predictions for a shot fired now
        if (d > 8) {
          const tau = 0.075 + Math.max(0, d - 3) / gsp
          const ux = -(m.pos[1] - y) / d, uy = (m.pos[0] - x) / d
          const px: number[] = [], py: number[] = []
          for (const k of LEAD_K) { const v = predVel(tk, k, m.vel[0], m.vel[1], tau); px.push(m.pos[0] + v[0] * tau); py.push(m.pos[1] + v[1] * tau) }
          tk.pend.push({ due: t + tau, ux, uy, r: targetRadius(m) + 0.2, px, py })
        }
      }
      for (const [id, tk] of tracks) if (t - tk.seen > 3) tracks.delete(id)
    }
    for (const [id, r] of recentMechs) if (t - r.t > 3) recentMechs.delete(id)

    // --- zone ---
    const zn = zoneNow(obs)
    const zone = obs.zone
    const dCur = hyp2(x, y, zn.cx, zn.cy)
    const dNext = hyp2(x, y, zone.next_center[0], zone.next_center[1])
    const nextMargin = Math.max(4, Math.min(zone.next_radius * 0.25, 40))
    const needNext = dNext - (zone.next_radius - nextMargin)
    const timeToShrink = zone.shrink_start - t
    const travel = Math.max(0, needNext) / (walk * 0.8)
    let zoneUrgent = false
    let zoneYaw = Math.atan2(zone.next_center[1] - y, zone.next_center[0] - x)
    if (dCur > zn.r - 3) {
      zoneUrgent = true
      zoneYaw = Math.atan2(zone.next_center[1] - y, zone.next_center[0] - x)
    } else if (needNext > 0 && (timeToShrink < travel + (ffa ? 30 : 12) || t > zone.shrink_start)) {
      zoneUrgent = true
    }
    const finalPhase = zone.next_radius <= 1

    // --- targets ---
    const weapons = me.weapons
    const gun = weapons.find((w) => w?.kind === "gun") as WeaponObs | undefined
    const gunSlot = weapons.findIndex((w) => w?.kind === "gun")
    const sec = weapons.findIndex((w) => w && w.kind !== "gun")
    const secW = sec >= 0 ? (weapons[sec] as WeaponObs) : null
    const eyeZ = z + (st.eye_height ?? 8)
    const mz = z + muzzleH

    let target: ActorObs | null = null
    let watch: ActorObs | null = null
    let watchD = Infinity
    let bestScore = Infinity
    for (const m of obs.mechs) {
      if (m.kind !== "mech") continue
      const d = hyp2(x, y, m.pos[0], m.pos[1])
      const vis = map.los(x, y, eyeZ, m.pos[0], m.pos[1], m.pos[2] + targetHeight(m))
      if (vis) lastVis.set(m.id, t)
      lastMechSeenT = t
      if (ffa || P.selectiveFights) {
        // free-for-all: only take fights that are forced on us or cheap
        const at0 = attackers.get(m.id)
        const hpF = (m.hp ?? 1400) / (m.max_hp ?? 1400)
        const aimedAtUs = Math.abs(wrap(m.aim[0] - Math.atan2(y - m.pos[1], x - m.pos[0]))) < P.hunterAim
        const nearRule = !ffa && P.hunterAim > 0 ? d < P.hunterClose || (aimedAtUs && d < P.hunterRange) : d < (ffa ? P.engageRange : P.practiceEngageRange)
        const engaged = (at0 != null && t - at0 < (ffa ? P.engageMemory : 6)) || nearRule || (ffa ? hpF < P.weakFrac && d < P.weakRange : hpF < 0.4 && d < 150) || m.id === lastTargetId ||
          (ffa && P.thirdPartyFrac > 0 && hpF < P.thirdPartyFrac && d < P.weakRange && t - (hurtByOther.get(m.id) ?? -99) < 4)
        if (!engaged) {
          if (d < watchD) { watchD = d; watch = m }
          continue
        }
      }
      const atk = attackers.get(m.id)
      const engageMax = weapons.some((w) => w?.kind === "laser") ? Math.max(P.maxEngage, P.laserEngage) : P.maxEngage
      if (d > engageMax && !(atk != null && t - atk < 6)) continue
      let sc = d + (m.hp ?? 1400) * (ffa ? P.hpWeightFfa : P.hpWeight) + (vis ? 0 : 120)
      if (m.id === lastTargetId) sc -= 25
      if (m.charging) sc -= 20
      const at = attackers.get(m.id)
      if (at != null && t - at < 4) sc -= P.attackerBonus
      if (sc < bestScore) { bestScore = sc; target = m }
    }
    let npcTarget: ActorObs | null = null
    if (!target && me.hp > me.max_hp * 0.4 && t < 300 && !(P.npcAvoid && t - lastMechSeenT < 10) && !(ffa && (watch || t - lastMechSeenT < 5))) {
      let bd = Infinity
      for (const m of obs.mechs) {
        if (m.kind !== "npc") continue
        const d = hyp2(x, y, m.pos[0], m.pos[1])
        if (d > 90) continue
        if (!map.los(x, y, eyeZ, m.pos[0], m.pos[1], m.pos[2] + 1.75)) continue
        if (d < bd) { bd = d; npcTarget = m }
      }
    }
    if (P.npcThreat && (!target || hyp2(x, y, target.pos[0], target.pos[1]) > P.npcOverride || (P.npcAlways && (target.hp ?? 1400) > (target.max_hp ?? 1400) * 0.4))) {
      for (const m of obs.mechs) {
        if (m.kind !== "npc") continue
        const at = attackers.get(m.id)
        if (at == null || t - at > 3 || hyp2(x, y, m.pos[0], m.pos[1]) > 70) continue
        target = null
        npcTarget = m
        break
      }
    }
    let threats = 0
    for (const m of obs.mechs) if (m.kind === "mech" && hyp2(x, y, m.pos[0], m.pos[1]) < 120 && t - (lastVis.get(m.id) ?? -99) < 1) threats++
    const fightTarget = target ?? npcTarget
    lastTargetId = target ? target.id : -1

    // --- incoming projectile dodge ---
    const myR = st.radius ?? 2.5
    for (const p of obs.projectiles) {
      const rx = p.pos[0] - x, ry = p.pos[1] - y, rz = p.pos[2] - (z + 4.5)
      const vx = p.vel[0] - me.vel[0], vy = p.vel[1] - me.vel[1], vz = p.vel[2] - me.vel[2]
      const vv = vx * vx + vy * vy + vz * vz
      if (vv < 1) continue
      const tc = -(rx * vx + ry * vy + rz * vz) / vv
      if (tc < 0 || tc > 0.9) continue
      if (p.kind === "mortar") {
        // shell: estimate landing spot
        const g = W.mortar.gravity ?? 22
        const a = -0.5 * g, b = p.vel[2], c = p.pos[2] - z
        const disc = b * b - 4 * a * c
        if (disc < 0) continue
        const tl = (-b - Math.sqrt(disc)) / (2 * a)
        if (tl < 0 || tl > 3) continue
        const lx = p.pos[0] + p.vel[0] * tl, ly = p.pos[1] + p.vel[1] * tl
        if (P.dodgeMortar && hyp2(x, y, lx, ly) < (W.mortar.splash_radius ?? 7) + 3) {
          dodgeUntil = t + 0.6
          dodgeDir = Math.atan2(y - ly, x - lx)
          dodgeBoost = me.energy > 20
        }
        continue
      }
      const cx = rx + vx * tc, cy = ry + vy * tc, cz = rz + vz * tc
      if (P.dodgeBullets && Math.hypot(cx, cy) < myR + 0.8 && Math.abs(cz) < 5.5) {
        const pyaw = Math.atan2(p.vel[1], p.vel[0])
        // sidestep perpendicular, away from the closest-approach side
        const side = Math.sign(-Math.sin(pyaw) * cx + Math.cos(pyaw) * cy) || (rng.next() < 0.5 ? 1 : -1)
        dodgeUntil = t + 0.35
        dodgeDir = pyaw + side * Math.PI / 2
        dodgeBoost = false
      }
    }
    // laser telegraph: duck behind cover if there is any within reach, else jink sideways
    for (const m of obs.mechs) {
      if (m.kind !== "mech" || P.laserDodge === 0) continue
      if (!m.charging) { chargeStart.delete(m.id); continue }
      if (!chargeStart.has(m.id)) chargeStart.set(m.id, t - 0.05)
      const d = hyp2(x, y, m.pos[0], m.pos[1])
      const toMe = Math.atan2(y - m.pos[1], x - m.pos[0])
      if (Math.abs(wrap(m.aim[0] - toMe)) > Math.atan2(myR * 3, d) + 0.05) continue
      if (t < dodgeUntil - 0.15) continue
      const full = W.laser.charge ?? 0.75
      const remain = Math.max(0.25, full - (t - (chargeStart.get(m.id) ?? t)) + 0.3)
      const reach = Math.min(14, remain * (me.energy > 15 ? 16 : 11))
      const ex = m.pos[0], ey = m.pos[1], ez = m.pos[2] + 8
      let bestP: [number, number] | null = null, bestD = Infinity
      for (const r of [3, 5, 7.5, 10, 13]) {
        if (r > reach + 0.5) break
        for (let k = 0; k < 16; k++) {
          const a = (k * Math.PI) / 8
          const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r
          const pz = map.topAt(px, py)
          if (pz > z + stepUp || pz < z - 6) continue
          if (!lineClear(x, y, z, px, py)) continue
          if (map.los(ex, ey, ez, px, py, pz + 4.5) || map.los(ex, ey, ez, px, py, pz + 8.5)) continue
          if (r < bestD) { bestD = r; bestP = [px, py] }
        }
        if (bestP) break
      }
      if (bestP) {
        dodgeUntil = t + Math.min(1.2, remain + 0.4)
        dodgeDir = Math.atan2(bestP[1] - y, bestP[0] - x)
        dodgeBoost = me.energy > 15
        dodgeCover = true
      } else if (t > dodgeUntil && P.laserDodge >= 2) {
        dodgeUntil = t + 0.5
        dodgeDir = toMe + (rng.next() < 0.5 ? 1 : -1) * Math.PI / 2
        dodgeBoost = false
        dodgeCover = false
      }
    }

    // --- aim & fire ---
    let aimYaw = me.aim[0]
    let aimPitch = 0
    let fire0 = false, fire1 = false
    let charging = false
    const tr = st.turn_rate ?? 4
    const aimErr = (yaw: number, pitch: number, dist: number) => {
      const ey = Math.abs(wrap(yaw - me.aim[0]))
      const ep = Math.abs(pitch - me.aim[1])
      return { ey, ep, lin: Math.hypot(ey, ep) * dist }
    }

    // mortar first if useful
    let usedMortar = false
    if (fightTarget && secW?.kind === "mortar" && secW.cooldown <= 0.05) {
      const p = fightTarget.pos
      const d = hyp2(x, y, p[0], p[1])
      if (d > 25 && d < 220) {
        const sp = secW.stats.speed ?? W.mortar.speed, g = secW.stats.gravity ?? W.mortar.gravity
        const tubeZ = z + (st.height ?? 9) + 0.5
        const visLine = map.los(x, y, tubeZ, p[0], p[1], p[2] + 2)
        let tp: V3 = [p[0], p[1], p[2]]
        let pitch: number | null = null
        for (let it = 0; it < 3; it++) {
          const R = hyp2(x, y, tp[0], tp[1])
          pitch = mortarPitch(R, tp[2] - tubeZ, !visLine, sp, g)
          if (pitch == null) break
          const tof = R / (sp * Math.cos(pitch))
          tp = [p[0] + fightTarget.vel[0] * (tof + 0.1), p[1] + fightTarget.vel[1] * (tof + 0.1), p[2]]
        }
        if (pitch != null && pitch < (st.max_pitch ?? 1.3)) {
          const yaw = Math.atan2(tp[1] - y, tp[0] - x)
          aimYaw = yaw
          aimPitch = pitch
          usedMortar = true
          const e = aimErr(yaw, pitch, d)
          if (e.ey < 0.03 && e.ep < 0.02) fire1 = true
        }
      }
    }

    if (fightTarget && !usedMortar) {
      const p = fightTarget.pos
      const h = targetHeight(fightTarget)
      const d = hyp2(x, y, p[0], p[1])
      const center: V3 = [p[0], p[1], p[2] + h]
      const vel: V3 = [fightTarget.vel[0], fightTarget.vel[1], Math.abs(fightTarget.vel[2]) > 1.5 ? fightTarget.vel[2] * 0.5 : 0]
      // velocity smoothing per target (jinking targets): exponential average of observed velocity
      if (P.velSmooth < 1) {
        const e = velEma.get(fightTarget.id)
        if (e && t - e.t < 0.5) { e.vx += (vel[0] - e.vx) * P.velSmooth; e.vy += (vel[1] - e.vy) * P.velSmooth; e.t = t; vel[0] = e.vx; vel[1] = e.vy }
        else velEma.set(fightTarget.id, { vx: vel[0], vy: vel[1], t })
      }
      // lead damping: strafing targets reverse often, so trust only part of their current velocity
      let ls = P.leadScale
      if (P.adaptiveLead > 0) {
        // how jinky is this target? EMA of horizontal acceleration magnitude
        const j = jinkiness.get(fightTarget.id)
        if (j) ls = Math.max(P.leadMin, Math.min(1, 1 - (j.acc - P.adaptiveLead) / (2 * P.adaptiveLead)))
      }
      let lv0 = vel[0] * ls, lv1 = vel[1] * ls
      const tk = P.aimLearn && fightTarget.kind === "mech" ? tracks.get(fightTarget.id) : undefined
      if (tk && tk.n >= 6) {
        let bk = 0
        for (let k = 1; k < LEAD_K.length; k++) if (tk.sc[k] > tk.sc[bk]) bk = k
        const v = predVel(tk, LEAD_K[bk], fightTarget.vel[0], fightTarget.vel[1], 0.075 + Math.max(0, d - 3) / (gun?.stats.speed ?? W.gun.speed))
        lv0 = v[0]; lv1 = v[1]
      }
      vel[0] = lv0; vel[1] = lv1
      const gspeed = gun?.stats.speed ?? W.gun.speed
      const ap = lead(x + Math.cos(me.aim[0]) * 3, y + Math.sin(me.aim[0]) * 3, mz, center, vel, gspeed, 0.06)
      aimYaw = Math.atan2(ap[1] - y, ap[0] - x)
      aimPitch = Math.atan2(ap[2] - mz, hyp2(x, y, ap[0], ap[1]))
      const vis = map.los(x, y, mz, center[0], center[1], center[2])
      const e = aimErr(aimYaw, aimPitch, d)
      const rad = targetRadius(fightTarget)
      const tol = (rad * 0.9 + 0.5) * (ffa ? P.fireTolFfa : P.fireTol)
      const gunRange = gun?.stats.range ?? W.gun.range
      const tSpeed = Math.hypot(fightTarget.vel[0], fightTarget.vel[1])
      const longShotOk = !ffa || d < 170 || tSpeed < 4
      if (process.env.FIRESTAT && fightTarget.kind === "mech" && gun) {
        const k = !vis ? "novis" : (gun.reload ?? 0) > 0 || (gun.ammo ?? 1) <= 0 ? "reload" : (gun.cooldown ?? 0) > 0.1 ? "cool" : !longShotOk ? "long" : e.lin >= tol + d * 0.004 ? "aim" : "fire"
        const g = globalThis as any; g.fs = g.fs ?? {}; g.fs[k] = (g.fs[k] ?? 0) + 1
      }
      const aimOk = e.lin < tol + d * 0.004 || (P.fireSlew && e.ey < tr * 0.05 * 0.9 && e.ep < (st.pitch_rate ?? 3) * 0.05 * 0.9)
      if (gun && gunSlot >= 0 && vis && longShotOk && d < gunRange * 0.97 && aimOk && (gun.ammo ?? 1) > 0 && (gun.reload ?? 0) <= 0) {
        if (gunSlot === 0) fire0 = true
        else fire1 = true
      }
      if (secW && sec >= 0) {
        if (secW.kind === "lightning") {
          const rng_ = secW.stats.range ?? W.lightning.range
          const cone = ((secW.stats.cone_deg ?? W.lightning.cone_deg) * Math.PI) / 180
          const toT = Math.atan2(p[1] - y, p[0] - x)
          if (vis && d < rng_ * 0.97 && Math.abs(wrap(toT - me.aim[0])) < cone * 0.45 && me.energy > 8) {
            if (sec === 1) fire1 = true
            else fire0 = true
          }
        } else if (secW.kind === "laser") {
          const range = secW.stats.range ?? W.laser.range
          const full = secW.stats.charge ?? W.laser.charge
          const charge = secW.charge ?? 0
          // aim directly (hitscan)
          const yawD = Math.atan2(center[1] + vel[1] * 0.1 - y, center[0] + vel[0] * 0.1 - x)
          const pitchD = Math.atan2(center[2] - mz, d)
          if (!(gun && vis && fire0)) {
            aimYaw = yawD
            aimPitch = pitchD
          }
          const e2 = aimErr(yawD, pitchD, d)
          if (secW.cooldown <= 0.05 && d < range * 0.97) {
            if (charge < full - 0.02) {
              if (vis || charge > 0) { charging = true }
            } else {
              // full: release when on target and visible, else keep holding a while
              if (vis && e2.lin < rad * 0.8) charging = false
              else charging = true
            }
          } else if (charge > 0) {
            charging = !(vis && e2.lin < rad * 0.8)
          }
          if (charging) {
            // when charging, aim the laser line rather than the gun lead; only keep gun fire if both line up
            const leadYaw = aimYaw, leadPitch = aimPitch
            if (Math.hypot(wrap(leadYaw - yawD), leadPitch - pitchD) * d > rad * 0.8) {
              if (gunSlot === 0) fire0 = false
              else if (gunSlot === 1) fire1 = false
            }
            if (sec === 1) fire1 = true
            else fire0 = true
            aimYaw = yawD
            aimPitch = pitchD
          }
        }
      }
    }
    // a mech is hitting us from out of view: swing round to find it (unless we are mid-charge)
    const attackerSeen = obs.mechs.some((m) => m.id === lastHitBy && t - (lastVis.get(m.id) ?? -99) < 0.3)
    const unseenAttacker = P.faceAttacker && t - lastHitT < 1.5 && !attackerSeen && (!target || target.id !== lastHitBy)
    if (unseenAttacker && !usedMortar && !(secW?.kind === "laser" && (secW.charge ?? 0) > 0)) {
      aimYaw = lastHitBearing
      aimPitch = 0
      fire0 = false
      fire1 = false
    }
    if (!fightTarget) {
      // release a held laser charge if nothing to shoot at
      if (secW?.kind === "laser" && (secW.charge ?? 0) > 0) {
        // keep holding (auto-fires after hold_s); nothing to do
        if (sec === 1) fire1 = true
        else fire0 = true
      }
    }

    // --- loot goals ---
    let goal: [number, number] | null = null
    let goalSpeed = 1
    let goalReason = ""
    for (const [id, until] of blacklist) if (until < t) blacklist.delete(id)
    const wantWeapon = (kind: string) => {
      if (kind === "gun") return false
      if (weapons.some((w) => w?.kind === kind)) return false
      if (!secW) return true
      return (wprio[kind] ?? 0) > (wprio[secW.kind] ?? 0)
    }
    // remember pickups; forget ones whose spot we can see empty
    const visPick = new Set<number>()
    for (const p of obs.pickups) {
      visPick.add(p.id)
      knownPickups.set(p.id, { kind: p.kind, pos: [p.pos[0], p.pos[1], p.pos[2]], t })
    }
    for (const e of obs.events) if (e.type === "took") knownPickups.delete(e.id)
    for (const [id, kp] of knownPickups) {
      if (visPick.has(id)) continue
      const d = hyp2(x, y, kp.pos[0], kp.pos[1])
      if (d < 40 && map.los(x, y, eyeZ, kp.pos[0], kp.pos[1], kp.pos[2] + 0.5)) knownPickups.delete(id)
    }
    // take any pickup in range now
    for (const p of obs.pickups) {
      if (!wantWeapon(p.kind)) continue
      if (hyp2(x, y, p.pos[0], p.pos[1]) < (cfg.loot.pickup_radius ?? 4) - 0.3 && Math.abs(p.pos[2] - z) < 3.8) {
        if (secW && secW.kind === "laser" && (secW.charge ?? 0) > 0) continue
        act.take = p.id
        if (secW) act.drop = sec
        break
      }
    }
    if (!zoneUrgent) {
      // candidate loot list
      let bestD = Infinity
      const consider = (id: number, px: number, py: number, pz: number, maxD: number, bias: number, reason: string) => {
        if (blacklist.has(id)) return
        const d = hyp2(x, y, px, py)
        if (d > maxD) return
        if (pz - z > 40) return
        const dz = hyp2(px, py, zone.next_center[0], zone.next_center[1])
        if (zone.next_radius > 0 && dz > zone.next_radius + 60 && t > 40) return
        const sc = d - bias
        if (sc < bestD) {
          bestD = sc
          goal = [px, py]
          goalReason = reason
          if (goalId !== id) { goalId = id; goalSince = t; goalBudget = 8 + d / 7 }
        }
      }
      for (const c of obs.cubes) consider(c.id, c.pos[0], c.pos[1], c.pos[2], target ? P.cubeFightRange : 90, 30, "cube")
      const kindBias: Record<string, number> = {}
      for (const k of ["lightning", "laser", "mortar"]) kindBias[k] = wprio[k] === 3 ? 40 : wprio[k] === 2 ? 15 : 0
      for (const [id, kp] of knownPickups) {
        if (!wantWeapon(kp.kind)) continue
        const maxD = target ? 20 : !secW ? (t < 200 ? 200 : 110) : kp.kind === "lightning" ? 120 : 60
        consider(id, kp.pos[0], kp.pos[1], kp.pos[2], maxD, (secW ? 0 : 40) + (kindBias[kp.kind] ?? 0), "weapon")
      }
      if (goal && t - goalSince > goalBudget) {
        blacklist.set(goalId, t + 30)
        goal = null
      }
      // drone farming: walk to the nearest remembered drone to kill it for cubes
      if (!goal && !target && P.farmUntil > t && me.hp > me.max_hp * 0.6 && !ffa) {
        let bd = 260
        for (const [id, r] of knownNpcs) {
          const d = hyp2(x, y, r.x, r.y)
          if (d < bd && d > 35) { bd = d; goal = [r.x, r.y]; goalReason = "farm"; if (goalId !== id) { goalId = id; goalSince = t; goalBudget = 8 + d / 7 } }
        }
      }
      // supply drop
      if (!goal && !target) {
        for (const dr of obs.drops) {
          const d = hyp2(x, y, dr.pos[0], dr.pos[1])
          const dropRange = ffa ? (t - lastMechSeenT > 8 ? 120 : 0) : 250
          if (d < dropRange && dr.lands_in < d / walk + 3 && (dr.holder == null || dr.holder === me.id)) {
            goal = [dr.pos[0], dr.pos[1]]
            goalReason = "drop"
            break
          }
        }
      }
    }

    // crates as shoot targets when idle
    let bcActive = false
    // late game: dealing damage to crates/drones would reset our HP regen
    if (!fightTarget && !usedMortar && !(ffa && watch) && !(t > 300 && me.hp < me.max_hp)) {
      let bc: (typeof obs.crates)[number] | null = null, bd = 70
      for (const c of obs.crates) {
        const d = hyp2(x, y, c.pos[0], c.pos[1])
        if (d < bd && map.los(x, y, mz, c.pos[0], c.pos[1], c.pos[2] + 1.2)) { bd = d; bc = c }
      }
      if (bc) {
        bcActive = true
        const cz = bc.pos[2] + 1.2
        aimYaw = Math.atan2(bc.pos[1] - y, bc.pos[0] - x)
        aimPitch = Math.atan2(cz - mz, bd)
        const e = aimErr(aimYaw, aimPitch, bd)
        const ok = e.lin < 1.2
        if (secW?.kind === "lightning" && bd < (secW.stats.range ?? 45) * 0.95 && Math.abs(wrap(aimYaw - me.aim[0])) < 0.2 && me.energy > 40) {
          if (sec === 1) fire1 = true
          else fire0 = true
        } else if (gun && ok && (gun.ammo ?? 0) > 0 && (gun.reload ?? 0) <= 0) {
          if (gunSlot === 0) fire0 = true
          else fire1 = true
        }
        if (!goal && bd > 25) { goal = [bc.pos[0], bc.pos[1]]; goalReason = "crate"; goalSpeed = 0.8 }
      } else {
        // scan / face threats
        if (threatYaw != null && t - threatT < (ffa ? P.watchThreat : 4)) {
          aimYaw = threatYaw
        } else {
          const base = goal ? Math.atan2(goal[1] - y, goal[0] - x) : zoneYaw
          aimYaw = base + Math.sin(t * 0.9) * 1.0
        }
        aimPitch = 0
      }
      // reload during quiet time
      if (gun && (gun.ammo ?? 12) < (gun.stats.mag ?? 12) * 0.6 && (gun.reload ?? 0) <= 0 && !bc) act.reload = true
    }

    // --- movement ---
    let moveYaw = zoneYaw
    let speed = 1
    let boost = false
    let jump = false
    let navGoal: [number, number] | null = null
    let mode = ""
    const hpFrac = me.hp / me.max_hp
    const ncx = zone.next_center[0], ncy = zone.next_center[1]
    if (zoneUrgent) {
      mode = "zone"
      const r = zone.next_radius - nextMargin
      if (finalPhase || zone.next_radius < 20 || dNext < 1) navGoal = [ncx, ncy]
      else navGoal = [ncx + ((x - ncx) / dNext) * r * 0.8, ncy + ((y - ncy) / dNext) * r * 0.8]
      if (dCur > zn.r - 3) navGoal = [ncx, ncy]
      navGoal = clampToZone(navGoal, zn)
      speed = 1
      if (dCur > zn.r - 3 || (timeToShrink < travel && needNext > 20)) boost = me.energy > 25
    } else if (fightTarget) {
      mode = "fight"
      const p = fightTarget.pos
      const d = hyp2(x, y, p[0], p[1])
      const toT = Math.atan2(p[1] - y, p[0] - x)
      if (t > strafeFlipT) {
        strafeSign = P.flipAlt ? -strafeSign : rng.next() < 0.5 ? 1 : -1
        strafeFlipT = t + P.flipMin + rng.next() * P.flipRand
      }
      const tw = fightTarget.weapons ?? []
      let want: number
      if (secW?.kind === "lightning" && me.energy > 20) want = P.lightningRange
      else if (fightTarget.kind === "npc") want = 40
      else if (tw.includes("lightning")) want = 80
      else if (secW?.kind === "laser") want = !ffa && P.practiceLaserRange > 0 ? P.practiceLaserRange : P.laserRange
      else if (secW?.kind === "mortar") want = 80
      else want = !ffa && P.practiceGunRange > 0 ? P.practiceGunRange : P.gunRange
      if (P.kite && threats >= 2 && !(secW?.kind === "lightning" && me.energy > 20)) want = Math.max(want, 100)
      let radial = clamp((d - want) / 25, -1, 1)
      const tHp = fightTarget.hp ?? 1400
      if (target && hpFrac < 0.3 && tHp > me.hp) radial = -1 // retreat while facing
      const sx = Math.cos(toT) * radial + Math.cos(toT + Math.PI / 2) * strafeSign * P.strafe
      const sy = Math.sin(toT) * radial + Math.sin(toT + Math.PI / 2) * strafeSign * P.strafe
      moveYaw = Math.atan2(sy, sx)
      speed = Math.min(1, Math.hypot(sx, sy) + 0.2)
      if (P.jink > 0 && target) {
        // irregular jinks: new heading and speed every jinkMin..jinkMin+jinkRand seconds, roughly across the line of fire
        if (t > jinkUntil) {
          const side = rng.next() < 0.5 ? 1 : -1
          const off = (Math.PI / 2) * side + (rng.next() - 0.5) * P.jinkSpread
          jinkYaw = off
          jinkSpeed = 0.55 + rng.next() * 0.45
          jinkUntil = t + P.jinkMin + rng.next() * P.jinkRand
        }
        const jy = toT + jinkYaw
        const rx2 = Math.cos(jy) + Math.cos(toT) * radial * P.jink, ry2 = Math.sin(jy) + Math.sin(toT) * radial * P.jink
        moveYaw = Math.atan2(ry2, rx2)
        speed = jinkSpeed
      }
      if (goal && hyp2(x, y, goal[0], goal[1]) < 25) {
        moveYaw = Math.atan2(goal[1] - y, goal[0] - x)
        speed = 1
      }
      const lv = lastVis.get(fightTarget.id) ?? -99
      const visNow = t - lv < 0.15
      // exposure control: keep the target in sight while hiding from the other mechs around us
      let nAtk = 0
      for (const [id, at] of attackers) if (id < 100 && t - at < 3) nAtk++
      if ((P.fightPos || ((ffa || P.multiPractice) && P.multiCover && nAtk >= 2)) && target && recentMechs.size >= 2) {
        if (!fightSpot || fightSpot.id !== target.id || t - fightSpot.t > 0.5) {
          const others = [...recentMechs].filter(([id]) => id !== target!.id).map(([, r]) => r.pos)
          const tp = target.pos
          const tc: [number, number, number] = [tp[0], tp[1], tp[2] + targetHeight(target)]
          const exposure = (px: number, py: number, pz: number) => {
            let n = 0
            for (const o of others) if (map.los(o[0], o[1], o[2] + 8, px, py, pz + 4.5)) n++
            return n
          }
          let best: [number, number] | null = null
          let bestSc = -exposure(x, y, z) * 1.0 + (map.los(x, y, z + 8, tc[0], tc[1], tc[2]) ? 0 : -1.5)
          for (const r of [4, 8, 12]) {
            for (let k = 0; k < 12; k++) {
              const a = (k * Math.PI) / 6
              const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r
              const pz = map.topAt(px, py)
              if (pz > z + stepUp || pz < z - 5 || !lineClear(x, y, z, px, py)) continue
              const sees = map.los(px, py, pz + 8, tc[0], tc[1], tc[2])
              const sc = -exposure(px, py, pz) * 1.0 + (sees ? 0 : -1.5) - r / 40
              if (sc > bestSc + 0.2) { bestSc = sc; best = [px, py] }
            }
          }
          fightSpot = { t, p: best, id: target.id }
        }
        if (fightSpot.p && hyp2(x, y, fightSpot.p[0], fightSpot.p[1]) > 1.5) {
          moveYaw = Math.atan2(fightSpot.p[1] - y, fightSpot.p[0] - x)
          speed = 1
          mode = "reposition"
        }
      }
      // cover while the gun reloads (and nothing else can shoot) or while losing the HP race
      if (P.coverFight && target && visNow && d < 200) {
        const secReady = secW != null && ((secW.kind === "lightning" && d < (secW.stats.range ?? 45) && me.energy > 10) || (secW.kind !== "lightning" && secW.cooldown < 0.3))
        const reloading = gun != null && ((gun.reload ?? 0) > 0.4 || (gun.ammo ?? 1) === 0)
        const losing = hpFrac < 0.45 && tHp > me.hp * 1.2
        if ((reloading && !secReady) || losing) {
          if (!coverCache || coverCache.id !== fightTarget.id || t - coverCache.t > 0.5) {
            coverCache = { id: fightTarget.id, t, p: findCover(x, y, z, p[0], p[1], p[2] + 8, 16) }
          }
          const cp = coverCache.p
          if (cp) {
            mode = losing ? "fallback" : "reload-cover"
            moveYaw = Math.atan2(cp[1] - y, cp[0] - x)
            speed = hyp2(x, y, cp[0], cp[1]) < 1.5 ? 0 : 1
          }
        }
      }
      // two or more mechs on us and hurt: break off to cover from the nearest other attacker, keep shooting if we can
      if ((ffa || P.multiPractice) && P.multiRetreat > 0 && nAtk >= 2 && hpFrac < P.multiRetreat) {
        let oth: [number, number, number] | null = null, od = Infinity
        for (const [id, at] of attackers) {
          if (id >= 100 || t - at >= 3) continue
          const r = recentMechs.get(id)
          if (!r) continue
          const dd = hyp2(x, y, r.pos[0], r.pos[1])
          if (dd < od && (!target || id !== target.id || attackers.size === 1)) { od = dd; oth = r.pos }
        }
        if (oth) {
          if (!coverCache || coverCache.id !== -3 || t - coverCache.t > 0.5) coverCache = { id: -3, t, p: findCover(x, y, z, oth[0], oth[1], oth[2] + 8, 20) }
          const cp = coverCache.p
          if (cp) {
            mode = "escape"
            moveYaw = Math.atan2(cp[1] - y, cp[0] - x)
            speed = hyp2(x, y, cp[0], cp[1]) < 1.5 ? 0 : 1
            if (me.energy > 30 && me.grounded && speed > 0) boost = true
          }
        }
      }
      // lost line of sight on a mech: re-acquire it only when it is nearly dead (or always, in the v1 variant)
      if (target && t - lv > 1.0 && hpFrac > 0.5 && (P.chaseAlways || tHp < (fightTarget.max_hp ?? 1400) * 0.35)) {
        navGoal = [p[0], p[1]]
        mode = "chase"
      }
      // keep inside the next circle when strafing
      if (!navGoal && zone.next_radius > 0 && dNext > zone.next_radius - nextMargin * 0.5 && t > zone.shrink_start - 15) {
        const inYaw = Math.atan2(ncy - y, ncx - x)
        if (Math.cos(moveYaw - inYaw) < 0) moveYaw = inYaw + strafeSign * 0.6
      }
    } else if (ffa && watch && watchD < 200) {
      // free-for-all: someone we do not want to fight is in view; face it, stay quiet, get out of its sight
      mode = "hide"
      aimYaw = Math.atan2(watch.pos[1] - y, watch.pos[0] - x)
      aimPitch = 0
      if (!coverCache || coverCache.id !== watch.id || t - coverCache.t > 1.0) {
        coverCache = { id: watch.id, t, p: findCover(x, y, z, watch.pos[0], watch.pos[1], watch.pos[2] + 8, 20) }
      }
      const cp = coverCache.p
      if (cp && hyp2(x, y, cp[0], cp[1]) > 1.5) {
        moveYaw = Math.atan2(cp[1] - y, cp[0] - x)
        speed = 0.42
      } else if (!cp && P.hideJink > 0) {
        // no cover from it: sidestep quietly across its line of fire instead of standing still
        if (t > strafeFlipT) { strafeSign = -strafeSign; strafeFlipT = t + P.flipMin + rng.next() * P.flipRand }
        moveYaw = aimYaw + strafeSign * Math.PI / 2
        speed = P.hideJink
      } else speed = 0
    } else if (P.healStill && hpFrac < 0.6 && t - lastDamageT > 0.5 && !(goal && hyp2(x, y, goal[0], goal[1]) < 15)) {
      // v1 healing: hold still (silent), facing where the danger came from
      mode = "heal"
      speed = 0
      if (!bcActive) {
        const base = threatYaw != null && t - threatT < 30 ? threatYaw : zoneYaw
        aimYaw = base + Math.sin(t * 0.7) * 0.7
        aimPitch = 0
      }
    } else if (P.healCover && !P.healStill && hpFrac < 0.6 && t - lastDamageT > P.healCalm && threatYaw != null && t - threatT < 20 && !(goal && hyp2(x, y, goal[0], goal[1]) < 15) &&
      (coverCache?.id === -2 && t - coverCache.t < 3 ? coverCache.p : (coverCache = { id: -2, t, p: findCover(x, y, z, x + Math.cos(threatYaw) * 70, y + Math.sin(threatYaw) * 70, z + 8, 16) }).p)) {
      // heal out of sight of where the last threat came from
      mode = "heal"
      const cp = coverCache!.p as [number, number]
      const dc = hyp2(x, y, cp[0], cp[1])
      moveYaw = Math.atan2(cp[1] - y, cp[0] - x)
      speed = dc < 1.5 ? 0 : 0.42
      if (!bcActive) {
        aimYaw = threatYaw + Math.sin(t * 0.7) * 0.6
        aimPitch = 0
      }
    } else if (P.healTo > 0 && hpFrac < P.healTo && !(goal && hyp2(x, y, goal[0], goal[1]) < 15) && t - lastDamageT > 1) {
      // rest in a sheltered spot nearby until healed; standing still is silent
      mode = "rest"
      if (!healSpot || hyp2(healSpot[0], healSpot[1], ncx, ncy) > Math.max(10, zone.next_radius * 0.8)) {
        const rIn = zone.next_radius > 0 ? Math.max(5, zone.next_radius * 0.75) : 5
        healSpot = pickHold(x, y, 25, ncx, ncy, Math.max(rIn, dNext), z)
      }
      const dh = hyp2(x, y, healSpot[0], healSpot[1])
      if (dh > 2) { navGoal = healSpot; speed = 0.42 } else speed = 0
      if (!bcActive) {
        const base = threatYaw != null && t - threatT < 30 ? threatYaw : zoneYaw
        aimYaw = base + Math.sin(t * 0.6) * 1.0
        aimPitch = 0
      }
    } else if (goal) {
      healSpot = null
      mode = goalReason
      navGoal = goal
      speed = goalSpeed
      if (goalReason === "drop" && hyp2(x, y, goal[0], goal[1]) < 3) { speed = 0; navGoal = null }
    } else {
      // wander inside the next circle
      mode = "roam"
      const nr = zone.next_radius
      const repick = ffa
        ? !wanderGoal || !wanderFfa || hyp2(wanderGoal[0], wanderGoal[1], ncx, ncy) > nr * 0.6 + 1 || hyp2(wanderNc[0], wanderNc[1], ncx, ncy) > 1
        : !wanderGoal || wanderFfa || t - wanderT > 25 || hyp2(x, y, wanderGoal[0], wanderGoal[1]) < 6
      if (repick) {
        wanderFfa = ffa
        wanderNc = [ncx, ncy]
        if (ffa) {
          // a sheltered spot near the nearest comfortable point inside the next circle: minimal exposure
          const rIn = Math.max(0, nr * 0.6)
          const near: [number, number] = dNext <= rIn ? [x, y] : [ncx + ((x - ncx) / dNext) * rIn, ncy + ((y - ncy) / dNext) * rIn]
          wanderGoal = pickHold(near[0], near[1], Math.min(35, Math.max(8, nr * 0.25)), ncx, ncy, rIn, z)
          if (P.ffaRoof && nr > 40) wanderGoal = pickRoof(near[0], near[1], Math.min(120, nr * 0.5), ncx, ncy, rIn, true) ?? wanderGoal
        } else {
          const a = rng.next() * TAU
          const rr = Math.sqrt(rng.next()) * Math.max(0, nr * 0.55)
          wanderGoal = [ncx + Math.cos(a) * rr, ncy + Math.sin(a) * rr]
        }
        wanderT = t
      }
      if (!ffa && P.roofAfter > 0 && t > P.roofAfter && !finalPhase && zone.next_radius > 30) {
        if (hyp2(roofNc[0], roofNc[1], ncx, ncy) > 1) {
          roofNc = [ncx, ncy]
          roofSpot = pickRoof(x, y, 150, ncx, ncy, zone.next_radius * 0.8)
        }
        if (roofSpot) { wanderGoal = roofSpot; mode = "roof" }
      }
      if (finalPhase) wanderGoal = clampToZone([ncx, ncy], zn)
      const dw = hyp2(x, y, wanderGoal[0], wanderGoal[1])
      navGoal = dw < 3 ? null : wanderGoal
      const fast = !ffa && t < P.roamFastUntil
      speed = needNext > 0 || fast ? 1 : dw < 3 ? 0 : 0.42
      if (ffa) mode = "hold"
    }

    // endgame: once the last circle is set, stand on the final centre (kept inside the moving circle)
    if (finalPhase && t > zone.shrink_start - 12) {
      const c = clampToZone([ncx, ncy], zn)
      const dc = hyp2(x, y, c[0], c[1])
      const tol = t > zone.shrink_start ? 0.8 : 4
      if (dc > tol) { navGoal = c; speed = dc < 4 ? 0.4 : 1; mode = "final" }
      else if (!fightTarget) { navGoal = null; speed = 0; mode = "final" }
      else { navGoal = null; speed = Math.min(speed, 0.5) }
    }

    if (t < dodgeUntil) {
      moveYaw = dodgeDir
      speed = 1
      navGoal = null
      if (dodgeBoost && me.grounded) boost = true
      mode += dodgeCover ? " cover" : " dodge"
    }

    // stuck detection
    const wantsMove = speed > 0.3 && !(navLabel.startsWith("climb") && me.grounded && me.energy < 40)
    if (!wantsMove) posHist.length = 0
    else posHist.push({ t, x, y, z })
    while (posHist.length && posHist[0].t < t - 1.6) posHist.shift()
    if (wantsMove && posHist.length > 10 && t > stuckUntil + 1) {
      const p0 = posHist[0]
      if (hyp2(p0.x, p0.y, x, y) < 1.5 && Math.abs(z - p0.z) < 2 && t - p0.t > 1.3 && Math.hypot(me.vel[0], me.vel[1]) < 2.5) {
        stuckUntil = t + 1.1
        stuckDir = moveYaw + (rng.next() < 0.5 ? 1 : -1) * (Math.PI / 2 + rng.next() * 0.8)
        detourSign = -detourSign
        forceReplan = true
        stuckCount++
      }
    }
    let mx: number, my: number
    navLabel = ""
    if (t < stuckUntil) {
      const firstHalf = stuckUntil - t > 0.55
      const yaw = firstHalf ? (navGoal ? Math.atan2(navGoal[1] - y, navGoal[0] - x) : moveYaw) : stuckDir
      mx = Math.cos(yaw)
      my = Math.sin(yaw)
      if (me.grounded) jump = true
      else if (me.energy > 10) boost = true
      navLabel = "stuck"
    } else if (speed > 0) {
      const s = navGoal ? navMove(obs, navGoal[0], navGoal[1], speed) : steer(obs, moveYaw, speed)
      mx = s.mx
      my = s.my
      jump = jump || s.jump
      boost = boost || s.boost
    } else {
      mx = 0
      my = 0
    }
    // laser charge halves speed anyway; don't boost on the ground while charging
    if (charging && me.grounded && !jump) boost = false
    // keep energy for lightning in a fight
    if (fightTarget && secW?.kind === "lightning" && me.energy < 30 && me.grounded && !zoneUrgent) boost = false

    // steer clear of drones we are not fighting
    if (P.npcAvoid && (mx !== 0 || my !== 0) && (t - lastMechSeenT < 10 || hpFrac < 0.7) && t >= stuckUntil) {
      let rx = 0, ry = 0
      for (const [id, r] of knownNpcs) {
        if (fightTarget && fightTarget.id === id) continue
        const d = hyp2(x, y, r.x, r.y)
        if (d > 55 || d < 0.1) continue
        const w = ((55 - d) / 55) * 1.5
        rx += ((x - r.x) / d) * w
        ry += ((y - r.y) / d) * w
      }
      if (rx !== 0 || ry !== 0) {
        const sp = Math.hypot(mx, my)
        const nx2 = mx / sp + rx, ny2 = my / sp + ry
        const l = Math.hypot(nx2, ny2) || 1
        mx = (nx2 / l) * sp
        my = (ny2 / l) * sp
      }
    }
    act.move = [mx, my]
    act.boost = boost
    act.jump = jump
    act.aim = [wrap(aimYaw), clamp(aimPitch, st.min_pitch ?? -0.7, st.max_pitch ?? 1.3)]
    act.fire = [fire0, fire1]
    void dt
    void tr

    draw.label(`${ffa ? "F " : ""}${mode}${fightTarget ? ` ${fightTarget.id}` : ""} ${navLabel} hp ${Math.round(me.hp)} st ${stuckCount}`)
    return act
  }

  return { name: "teti-mech", act }
}

