/** 2 m navigation grid with walk, climb and drop edges, and a resumable A* planner. */
import type { GameMap } from "./map.ts"

const SQ2 = Math.SQRT2

export class NavGrid {
  cs = 2
  nx = 0
  ny = 0
  minX = 0
  minY = 0
  /** standing height of the cell (max solid top over the 2x2 one-metre cells) */
  h: Float32Array
  /** extra cost multiplier near walls */
  pen: Float32Array
  map: GameMap
  constructor(map: GameMap) {
    this.map = map
    const cs = this.cs
    this.nx = Math.ceil(map.nx / cs)
    this.ny = Math.ceil(map.ny / cs)
    this.minX = map.minX
    this.minY = map.minY
    const N = this.nx * this.ny
    this.h = new Float32Array(N)
    this.pen = new Float32Array(N)
    for (let J = 0; J < this.ny; J++) {
      for (let I = 0; I < this.nx; I++) {
        let hm = -1e9
        for (let dj = 0; dj < cs; dj++) {
          const j = Math.min(map.ny - 1, J * cs + dj)
          for (let di = 0; di < cs; di++) {
            const i = Math.min(map.nx - 1, I * cs + di)
            const k = j * map.nx + i
            let t = map.top[k]
            const ob = map.ohBase[k]
            // a low overhang (bridge deck under head height) is a wall unless you are on top of it
            if (!Number.isNaN(ob) && ob - map.ground[k] < 9.5) t = Math.max(t, map.ohTop[k])
            if (t > hm) hm = t
          }
        }
        this.h[J * this.nx + I] = hm
      }
    }
    // wall-proximity penalty: cells right next to something taller than a step are awkward for a 2.5 m radius body
    for (let J = 0; J < this.ny; J++) {
      for (let I = 0; I < this.nx; I++) {
        const c = J * this.nx + I
        const hc = this.h[c]
        let near = 0
        for (let dj = -2; dj <= 2 && near < 2; dj++) {
          for (let di = -2; di <= 2; di++) {
            const ii = I + di, jj = J + dj
            if (ii < 0 || jj < 0 || ii >= this.nx || jj >= this.ny) { near = Math.max(near, Math.abs(di) <= 1 && Math.abs(dj) <= 1 ? 2 : 1); continue }
            if (this.h[jj * this.nx + ii] > hc + 1.2) {
              const lvl = Math.abs(di) <= 1 && Math.abs(dj) <= 1 ? 2 : 1
              if (lvl > near) near = lvl
            }
          }
        }
        this.pen[c] = near === 2 ? 2.5 : near === 1 ? 0.6 : 0
      }
    }
  }

  cellOf(x: number, y: number): number {
    let I = Math.floor((x - this.minX + 0.5) / this.cs), J = Math.floor((y - this.minY + 0.5) / this.cs)
    if (I < 0) I = 0; else if (I >= this.nx) I = this.nx - 1
    if (J < 0) J = 0; else if (J >= this.ny) J = this.ny - 1
    return J * this.nx + I
  }
  cx(c: number) { return this.minX + (c % this.nx) * this.cs + 0.5 * (this.cs - 1) }
  cy(c: number) { return this.minY + Math.floor(c / this.nx) * this.cs + 0.5 * (this.cs - 1) }

  /** The cell around (x,y) whose surface best matches a body standing at height z. */
  startCell(x: number, y: number, z: number): number {
    const c0 = this.cellOf(x, y)
    const I0 = c0 % this.nx, J0 = Math.floor(c0 / this.nx)
    let best = c0, bs = Infinity
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const I = I0 + di, J = J0 + dj
      if (I < 0 || J < 0 || I >= this.nx || J >= this.ny) continue
      const c = J * this.nx + I
      const dh = this.h[c] - z
      const s = (dh > 1.2 ? 100 + dh : Math.abs(dh)) + (Math.abs(di) + Math.abs(dj)) * 0.3
      if (s < bs) { bs = s; best = c }
    }
    return best
  }
}

/** Resumable A*: call begin(), then step(ms) each tick until it returns "done" or "fail". */
export class Planner {
  g: Float32Array
  parent: Int32Array
  stamp: Int32Array
  closed: Int32Array
  heapN: Int32Array
  heapF: Float32Array
  heapLen = 0
  gen = 0
  start = -1
  goal = -1
  gx = 0
  gy = 0
  state: "idle" | "running" | "done" | "fail" = "idle"
  path: number[] = []
  expansions = 0
  best = -1
  bestH = Infinity
  maxClimb = 45
  nav: NavGrid
  constructor(nav: NavGrid) {
    this.nav = nav
    const N = nav.nx * nav.ny
    this.g = new Float32Array(N)
    this.parent = new Int32Array(N)
    this.stamp = new Int32Array(N)
    this.closed = new Int32Array(N)
    this.heapN = new Int32Array(N * 4)
    this.heapF = new Float32Array(N * 4)
  }
  private push(n: number, f: number) {
    if (this.heapLen >= this.heapN.length) return
    let i = this.heapLen++
    const hn = this.heapN, hf = this.heapF
    while (i > 0) {
      const p = (i - 1) >> 1
      if (hf[p] <= f) break
      hn[i] = hn[p]; hf[i] = hf[p]; i = p
    }
    hn[i] = n; hf[i] = f
  }
  private pop(): number {
    const hn = this.heapN, hf = this.heapF
    const top = hn[0]
    const n = hn[--this.heapLen], f = hf[this.heapLen]
    let i = 0
    const len = this.heapLen
    while (true) {
      let c = 2 * i + 1
      if (c >= len) break
      if (c + 1 < len && hf[c + 1] < hf[c]) c++
      if (hf[c] >= f) break
      hn[i] = hn[c]; hf[i] = hf[c]; i = c
    }
    hn[i] = n; hf[i] = f
    return top
  }
  private hcost(c: number) {
    const nav = this.nav
    return Math.hypot(nav.cx(c) - this.gx, nav.cy(c) - this.gy)
  }
  begin(sx: number, sy: number, sz: number, gx: number, gy: number) {
    const nav = this.nav
    this.gen++
    this.start = nav.startCell(sx, sy, sz)
    this.goal = nav.cellOf(gx, gy)
    this.gx = nav.cx(this.goal)
    this.gy = nav.cy(this.goal)
    this.heapLen = 0
    this.g[this.start] = 0
    this.stamp[this.start] = this.gen
    this.parent[this.start] = -1
    this.push(this.start, this.hcost(this.start))
    this.state = "running"
    this.expansions = 0
    this.best = this.start
    this.bestH = this.hcost(this.start)
  }
  step(budgetMs: number, energyCap = 100): "running" | "done" | "fail" {
    if (this.state !== "running") return this.state === "done" ? "done" : "fail"
    const nav = this.nav, nx = nav.nx, ny = nav.ny, H = nav.h, P = nav.pen
    const g = this.g, st = this.stamp, cl = this.closed, par = this.parent, gen = this.gen
    const t0 = performance.now()
    const maxClimb = Math.min(this.maxClimb, energyCap * 0.55)
    let iter = 0
    while (this.heapLen > 0) {
      if ((++iter & 127) === 0 && performance.now() - t0 > budgetMs) return "running"
      const c = this.pop()
      if (cl[c] === gen) continue
      cl[c] = gen
      this.expansions++
      if (c === this.goal) {
        this.finish(c)
        return "done"
      }
      const hc = this.hcost(c)
      if (hc < this.bestH) { this.bestH = hc; this.best = c }
      const I = c % nx, J = (c - I) / nx
      const gc = g[c]
      const hh = H[c]
      for (let k = 0; k < 8; k++) {
        const di = k < 3 ? k - 1 : k === 3 ? -1 : k === 4 ? 1 : k - 6
        const dj = k < 3 ? -1 : k < 5 ? 0 : 1
        const ii = I + di, jj = J + dj
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue
        const n = jj * nx + ii
        if (cl[n] === gen) continue
        const d = (di !== 0 && dj !== 0 ? SQ2 : 1) * nav.cs
        const dh = H[n] - hh
        let cost: number
        if (dh <= 1.2) cost = d * (1 + P[n]) + (dh < -1.2 ? 1 : 0)
        else {
          if (dh > maxClimb) continue
          cost = d + 10 + 2.5 * dh
        }
        const ng = gc + cost
        if (st[n] !== gen || ng < g[n]) {
          st[n] = gen
          g[n] = ng
          par[n] = c
          this.push(n, ng + this.hcost(n))
        }
      }
    }
    // goal unreachable: go to the closest reached cell
    if (this.best >= 0 && this.best !== this.start) {
      this.finish(this.best)
      return "done"
    }
    this.state = "fail"
    return "fail"
  }
  private finish(c: number) {
    const out: number[] = []
    let n = c
    let guard = 0
    while (n >= 0 && guard++ < 200000) {
      out.push(n)
      if (n === this.start) break
      n = this.parent[n]
    }
    out.reverse()
    this.path = out
    this.state = "done"
  }
}
