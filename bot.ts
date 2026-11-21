/** Mech Royale bot: zone-safe movement, lead-aimed shooting, loot, dodging. */
import { type ActorObs, type BotAction, draw, type Hello, type Observation, run, type WeaponObs } from "./mechfight.ts"
import { GameMap } from "./map.ts"

type V3 = [number, number, number]

const TAU = Math.PI * 2
const wrap = (a: number) => {
  a = (a + Math.PI) % TAU
  if (a < 0) a += TAU
  return a - Math.PI
}
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const hyp2 = (ax: number, ay: number, bx: number, by: number) => Math.hypot(bx - ax, by - ay)

const UPGRADE_PRIO = [
  "armor", "plating", "gun_rate", "lightning_efficiency", "laser_damage", "gun_damage", "nanites",
  "laser_charge", "lightning_range", "gun_mag", "gun_velocity", "mortar_reload", "lightning_chain",
  "servos", "reactor", "capacitor", "jets", "gyros", "mortar_splash", "mortar_velocity", "sensors", "laser_pierce",
]
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

function makeBot(hello: Hello) {
  const cfg = hello.config
  const map = new GameMap(hello.map.dir, hello.map.files)
  const rng = new Rng(hello.seed)
  const W = cfg.weapons
  const stepUp = cfg.mech.step_up ?? 1.2

  // --- memory ---
  let lastT = 0
  let threatYaw: number | null = null
  let threatT = -99
  const posHist: { t: number; x: number; y: number }[] = []
  let stuckUntil = -1
  let stuckDir = 0
  let detourSign = 1
  let strafeSign = 1
  let strafeFlipT = 0
  let wanderGoal: [number, number] | null = null
  let wanderT = -99
  let goalId = -1
  let goalSince = 0
  const blacklist = new Map<number, number>() // id -> until t
  let climbing = false
  let lastTargetId = -1
  let lastDamageT = -99
  let dodgeUntil = -1
  let dodgeDir = 0

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
        const r = UPGRADE_PRIO.indexOf(c.id)
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
        }
      }
    }
    for (const s of obs.sounds) {
      if ((s.kind === "gun" || s.kind === "laser" || s.kind === "laser_charge" || s.kind === "lightning" || s.kind === "mortar" || s.kind === "step" || s.kind === "boost" || s.kind === "jet") && s.dist !== "far") {
        if (t - threatT > 1.5) {
          threatYaw = s.bearing
          threatT = t - 0.5
        }
      }
    }

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
    } else if (needNext > 0 && (timeToShrink < travel + 12 || t > zone.shrink_start)) {
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
    let bestScore = Infinity
    for (const m of obs.mechs) {
      if (m.kind !== "mech") continue
      const d = hyp2(x, y, m.pos[0], m.pos[1])
      const vis = map.los(x, y, eyeZ, m.pos[0], m.pos[1], m.pos[2] + targetHeight(m))
      let sc = d + (m.hp ?? 1400) / 20 + (vis ? 0 : 120)
      if (m.id === lastTargetId) sc -= 25
      if (m.charging) sc -= 20
      if (sc < bestScore) { bestScore = sc; target = m }
    }
    let npcTarget: ActorObs | null = null
    if (!target) {
      let bd = Infinity
      for (const m of obs.mechs) {
        if (m.kind !== "npc") continue
        const d = hyp2(x, y, m.pos[0], m.pos[1])
        if (d > 90) continue
        if (!map.los(x, y, eyeZ, m.pos[0], m.pos[1], m.pos[2] + 1.75)) continue
        if (d < bd) { bd = d; npcTarget = m }
      }
    }
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
        if (hyp2(x, y, lx, ly) < (W.mortar.splash_radius ?? 7) + 3) {
          dodgeUntil = t + 0.6
          dodgeDir = Math.atan2(y - ly, x - lx)
        }
        continue
      }
      const cx = rx + vx * tc, cy = ry + vy * tc, cz = rz + vz * tc
      if (Math.hypot(cx, cy) < myR + 0.8 && Math.abs(cz) < 5.5) {
        const pyaw = Math.atan2(p.vel[1], p.vel[0])
        // sidestep perpendicular, away from the closest-approach side
        const side = Math.sign(-Math.sin(pyaw) * cx + Math.cos(pyaw) * cy) || (rng.next() < 0.5 ? 1 : -1)
        dodgeUntil = t + 0.35
        dodgeDir = pyaw + side * Math.PI / 2
      }
    }
    // laser telegraph dodge
    for (const m of obs.mechs) {
      if (m.kind !== "mech" || !m.charging) continue
      const d = hyp2(x, y, m.pos[0], m.pos[1])
      const toMe = Math.atan2(y - m.pos[1], x - m.pos[0])
      if (Math.abs(wrap(m.aim[0] - toMe)) < Math.atan2(myR * 2.2, d) + 0.03 && t > dodgeUntil) {
        dodgeUntil = t + 0.5
        dodgeDir = toMe + (rng.next() < 0.5 ? 1 : -1) * Math.PI / 2
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
      const gspeed = gun?.stats.speed ?? W.gun.speed
      const ap = lead(x + Math.cos(me.aim[0]) * 3, y + Math.sin(me.aim[0]) * 3, mz, center, vel, gspeed, 0.06)
      aimYaw = Math.atan2(ap[1] - y, ap[0] - x)
      aimPitch = Math.atan2(ap[2] - mz, hyp2(x, y, ap[0], ap[1]))
      const vis = map.los(x, y, mz, center[0], center[1], center[2])
      const e = aimErr(aimYaw, aimPitch, d)
      const rad = targetRadius(fightTarget)
      const tol = rad * 0.9 + 0.5
      const gunRange = gun?.stats.range ?? W.gun.range
      if (gun && gunSlot >= 0 && vis && d < gunRange * 0.97 && e.lin < tol + d * 0.004 && (gun.ammo ?? 1) > 0 && (gun.reload ?? 0) <= 0) {
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
    } else if (!fightTarget) {
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
      return (WEAPON_PRIO[kind] ?? 0) > (WEAPON_PRIO[secW.kind] ?? 0)
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
          if (goalId !== id) { goalId = id; goalSince = t }
        }
      }
      for (const c of obs.cubes) consider(c.id, c.pos[0], c.pos[1], c.pos[2], target ? 25 : 90, 30, "cube")
      for (const p of obs.pickups) if (wantWeapon(p.kind)) consider(p.id, p.pos[0], p.pos[1], p.pos[2], target ? 20 : secW ? 60 : 110, secW ? 0 : 40, "weapon")
      if (goal && t - goalSince > 10) {
        blacklist.set(goalId, t + 30)
        goal = null
      }
      // supply drop
      if (!goal && !target) {
        for (const dr of obs.drops) {
          const d = hyp2(x, y, dr.pos[0], dr.pos[1])
          if (d < 160 && dr.lands_in < d / walk + 3 && (dr.holder == null || dr.holder === me.id)) {
            goal = [dr.pos[0], dr.pos[1]]
            goalReason = "drop"
            break
          }
        }
      }
    }

    // crates as shoot targets when idle
    if (!fightTarget && !usedMortar) {
      let bc: (typeof obs.crates)[number] | null = null, bd = 70
      for (const c of obs.crates) {
        const d = hyp2(x, y, c.pos[0], c.pos[1])
        if (d < bd && map.los(x, y, mz, c.pos[0], c.pos[1], c.pos[2] + 1.2)) { bd = d; bc = c }
      }
      if (bc) {
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
        if (threatYaw != null && t - threatT < 4) {
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
    const hpFrac = me.hp / me.max_hp
    if (zoneUrgent) {
      moveYaw = zoneYaw
      speed = 1
      if (dCur > zn.r - 3 || (timeToShrink < travel && needNext > 20)) boost = me.energy > 25
      if (fightTarget && dCur < zn.r - 10) {
        // still strafe a little
        moveYaw = zoneYaw + 0.4 * strafeSign
      }
    } else if (fightTarget) {
      const p = fightTarget.pos
      const d = hyp2(x, y, p[0], p[1])
      const toT = Math.atan2(p[1] - y, p[0] - x)
      if (t > strafeFlipT) {
        strafeSign = rng.next() < 0.5 ? 1 : -1
        strafeFlipT = t + 0.8 + rng.next() * 1.4
      }
      let want: number
      if (secW?.kind === "lightning" && me.energy > 20) want = 28
      else if (fightTarget.kind === "npc") want = 40
      else want = 70
      let radial = clamp((d - want) / 25, -1, 1)
      const tHp = fightTarget.hp ?? 1400
      if (target && hpFrac < 0.3 && tHp > me.hp) radial = -1 // retreat while facing
      const sx = Math.cos(toT) * radial + Math.cos(toT + Math.PI / 2) * strafeSign * 0.9
      const sy = Math.sin(toT) * radial + Math.sin(toT + Math.PI / 2) * strafeSign * 0.9
      moveYaw = Math.atan2(sy, sx)
      speed = 1
      if (goal && hyp2(x, y, goal[0], goal[1]) < 25) {
        moveYaw = Math.atan2(goal[1] - y, goal[0] - x)
      }
      // keep inside the next circle when strafing
      if (zone.next_radius > 0 && dNext > zone.next_radius - nextMargin * 0.5 && t > zone.shrink_start - 15) {
        const inYaw = Math.atan2(zone.next_center[1] - y, zone.next_center[0] - x)
        if (Math.cos(moveYaw - inYaw) < 0) moveYaw = inYaw + strafeSign * 0.6
      }
    } else if (goal) {
      moveYaw = Math.atan2(goal[1] - y, goal[0] - x)
      speed = goalSpeed
      if (goalReason === "drop" && hyp2(x, y, goal[0], goal[1]) < 3) speed = 0
    } else {
      // wander inside the next circle
      const nr = zone.next_radius
      if (!wanderGoal || t - wanderT > 18 || hyp2(x, y, wanderGoal[0], wanderGoal[1]) < 6) {
        const a = rng.next() * TAU
        const rr = Math.sqrt(rng.next()) * Math.max(0, nr * 0.55)
        wanderGoal = [zone.next_center[0] + Math.cos(a) * rr, zone.next_center[1] + Math.sin(a) * rr]
        wanderT = t
      }
      if (finalPhase) wanderGoal = [zone.next_center[0], zone.next_center[1]]
      moveYaw = Math.atan2(wanderGoal[1] - y, wanderGoal[0] - x)
      const dw = hyp2(x, y, wanderGoal[0], wanderGoal[1])
      speed = needNext > 0 ? 1 : dw < 3 ? 0 : 0.42
    }

    if (t < dodgeUntil) {
      moveYaw = dodgeDir
      speed = 1
    }

    // stuck detection
    posHist.push({ t, x, y })
    while (posHist.length && posHist[0].t < t - 1.6) posHist.shift()
    if (speed > 0.3 && posHist.length > 10 && t > stuckUntil + 1) {
      const p0 = posHist[0]
      if (hyp2(p0.x, p0.y, x, y) < 1.5 && t - p0.t > 1.3) {
        stuckUntil = t + 1.1
        stuckDir = moveYaw + (rng.next() < 0.5 ? 1 : -1) * (Math.PI / 2 + rng.next() * 0.8)
        detourSign = -detourSign
      }
    }
    let mx: number, my: number
    if (t < stuckUntil) {
      const firstHalf = stuckUntil - t > 0.55
      const yaw = firstHalf ? moveYaw : stuckDir
      mx = Math.cos(yaw)
      my = Math.sin(yaw)
      if (me.grounded) jump = true
      else if (me.energy > 10) boost = true
    } else if (speed > 0) {
      const s = steer(obs, moveYaw, speed)
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

    act.move = [mx, my]
    act.boost = boost
    act.jump = jump
    act.aim = [wrap(aimYaw), clamp(aimPitch, st.min_pitch ?? -0.7, st.max_pitch ?? 1.3)]
    act.fire = [fire0, fire1]
    void dt
    void tr

    draw.label(`${zoneUrgent ? "ZONE " : ""}${fightTarget ? `tgt ${fightTarget.id}` : goalReason || "roam"} hp ${Math.round(me.hp)}`)
    return act
  }

  return { name: "teti-mech", act }
}

run((hello) => makeBot(hello))
