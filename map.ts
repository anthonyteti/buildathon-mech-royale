/** Static map: 1 m column grid built from v2/world.json and v2/terrain.i16. */
import { readFileSync } from "node:fs"

type Prism = { kind: string; base: number; top: number; ring: number[]; holes?: number[][] | number[] }

function pip(r: number[], x: number, y: number): boolean {
  let inside = false
  const n = r.length >> 1
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export class GameMap {
  minX = 0
  minY = 0
  nx = 0
  ny = 0
  /** ground height per cell (cell i,j is centred on terrain vertex i,j) */
  ground: Float32Array = new Float32Array(0)
  /** highest solid top that stands on the ground (>= ground) */
  top: Float32Array = new Float32Array(0)
  /** overhang (bridge) interval, NaN when none */
  ohBase: Float32Array = new Float32Array(0)
  ohTop: Float32Array = new Float32Array(0)
  ok = false

  constructor(dir: string, files: string[]) {
    try {
      const wf = files.find((f) => f.endsWith("world.json")) ?? "v2/world.json"
      const tf = files.find((f) => f.endsWith(".i16")) ?? "v2/terrain.i16"
      const world = JSON.parse(readFileSync(`${dir}/${wf}`, "utf8"))
      const t = world.terrain
      this.minX = t.minX
      this.minY = t.minY
      this.nx = t.nx
      this.ny = t.ny
      const scale = t.scale ?? 0.01
      const buf = readFileSync(`${dir}/${tf}`)
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      const raw = new Int16Array(ab)
      const N = this.nx * this.ny
      this.ground = new Float32Array(N)
      this.top = new Float32Array(N)
      this.ohBase = new Float32Array(N).fill(NaN)
      this.ohTop = new Float32Array(N).fill(NaN)
      for (let k = 0; k < N; k++) {
        const g = (raw[k] ?? 0) * scale
        this.ground[k] = g
        this.top[k] = g
      }
      const prisms: Prism[] = world.prisms ?? []
      for (const p of prisms) this.raster(p)
      this.ok = true
    } catch (e) {
      console.error("map load failed", e)
      this.ok = false
    }
  }

  private raster(p: Prism) {
    const r = p.ring
    if (!r || r.length < 6) return
    let holes: number[][] = []
    if (p.holes && p.holes.length) holes = typeof p.holes[0] === "number" ? [p.holes as number[]] : (p.holes as number[][])
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (let i = 0; i < r.length; i += 2) {
      x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i])
      y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1])
    }
    const i0 = Math.max(0, Math.floor(x0 - this.minX)), i1 = Math.min(this.nx - 1, Math.ceil(x1 - this.minX))
    const j0 = Math.max(0, Math.floor(y0 - this.minY)), j1 = Math.min(this.ny - 1, Math.ceil(y1 - this.minY))
    for (let j = j0; j <= j1; j++) {
      const y = this.minY + j
      for (let i = i0; i <= i1; i++) {
        const x = this.minX + i
        if (!pip(r, x, y)) continue
        let inHole = false
        for (const h of holes) if (h.length >= 6 && pip(h, x, y)) { inHole = true; break }
        if (inHole) continue
        const k = j * this.nx + i
        const g = this.ground[k]
        if (p.base <= g + 1.5) {
          if (p.top > this.top[k]) this.top[k] = p.top
        } else {
          const b = this.ohBase[k]
          if (Number.isNaN(b) || p.base < b) this.ohBase[k] = p.base
          const tt = this.ohTop[k]
          if (Number.isNaN(tt) || p.top > tt) this.ohTop[k] = p.top
        }
      }
    }
  }

  idx(x: number, y: number): number {
    let i = Math.round(x - this.minX), j = Math.round(y - this.minY)
    if (i < 0) i = 0; else if (i >= this.nx) i = this.nx - 1
    if (j < 0) j = 0; else if (j >= this.ny) j = this.ny - 1
    return j * this.nx + i
  }

  inBounds(x: number, y: number): boolean {
    const i = Math.round(x - this.minX), j = Math.round(y - this.minY)
    return i >= 1 && j >= 1 && i < this.nx - 1 && j < this.ny - 1
  }

  /** Height of the highest walkable surface at (x,y) that is not above `below` (roof or ground). */
  topAt(x: number, y: number): number {
    if (!this.ok) return -1e9
    return this.top[this.idx(x, y)]
  }

  groundAt(x: number, y: number): number {
    if (!this.ok) return 0
    return this.ground[this.idx(x, y)]
  }

  /** Is the point solid? */
  solid(x: number, y: number, z: number): boolean {
    const k = this.idx(x, y)
    if (z < this.top[k]) return true
    const b = this.ohBase[k]
    if (!Number.isNaN(b) && z >= b && z <= this.ohTop[k]) return true
    return false
  }

  /** Line of sight between two 3D points (sampled every ~1 m). */
  los(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    if (!this.ok) return true
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const d = Math.hypot(dx, dy)
    const n = Math.max(1, Math.ceil(d))
    for (let s = 1; s < n; s++) {
      const f = s / n
      if (this.solid(ax + dx * f, ay + dy * f, az + dz * f)) return false
    }
    return true
  }
}
