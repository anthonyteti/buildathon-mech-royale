/**
 * Runs a protocol-speaking bot as a child process (black box: JSON lines on stdin/stdout).
 * Registry (local only, never committed): JSON file at $OPP_REGISTRY mapping a name to
 * { "cwd": "/path/to/clone", "cmd": ["python3", "-u", "bot.py"] }.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { readFileSync } from "node:fs"

export type ExtSpec = { cwd: string; cmd: string[]; env?: Record<string, string> }

let registry: Record<string, ExtSpec> | null = null
export function extSpec(name: string): ExtSpec {
  if (!registry) registry = JSON.parse(readFileSync(process.env.OPP_REGISTRY ?? "opponents.json", "utf8"))
  const s = registry![name]
  if (!s) throw new Error(`unknown opponent ${name}`)
  return s
}

export class ExtBot {
  proc: ChildProcessWithoutNullStreams
  buf = ""
  lines: string[] = []
  waiter: ((l: string | null) => void) | null = null
  dead = false
  late = 0
  answered = 0
  constructor(spec: ExtSpec) {
    this.proc = spawn(spec.cmd[0], spec.cmd.slice(1), { cwd: spec.cwd, env: { ...process.env, ...(spec.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"] })
    this.proc.stdout.setEncoding("utf8")
    this.proc.stdout.on("data", (d: string) => {
      this.buf += d
      let i: number
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const l = this.buf.slice(0, i).trim()
        this.buf = this.buf.slice(i + 1)
        if (!l) continue
        if (this.waiter) { const w = this.waiter; this.waiter = null; w(l) } else this.lines.push(l)
      }
    })
    this.proc.stderr.on("data", () => {})
    this.proc.on("exit", () => { this.dead = true; if (this.waiter) { const w = this.waiter; this.waiter = null; w(null) } })
    this.proc.stdin.on("error", () => { this.dead = true })
  }
  send(o: unknown) {
    if (this.dead) return
    try { this.proc.stdin.write(JSON.stringify(o) + "\n") } catch { this.dead = true }
  }
  /** next line within timeout, or null */
  recv(timeoutMs: number): Promise<string | null> {
    if (this.lines.length) return Promise.resolve(this.lines.shift()!)
    if (this.dead) return Promise.resolve(null)
    return new Promise((res) => {
      const timer = setTimeout(() => { if (this.waiter === wrapped) this.waiter = null; res(null) }, timeoutMs)
      const wrapped = (l: string | null) => { clearTimeout(timer); res(l) }
      this.waiter = wrapped
    })
  }
  /** action for `tick`, skipping stale answers; null if none in time */
  async act(obs: any, timeoutMs: number): Promise<any | null> {
    this.send(obs)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const l = await this.recv(deadline - Date.now())
      if (l == null) break
      try {
        const m = JSON.parse(l)
        if (m.tick === obs.tick) { this.answered++; return m }
      } catch {}
    }
    this.late++
    return null
  }
  async hello(h: any, timeoutMs = 20000): Promise<boolean> {
    this.send(h)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const l = await this.recv(deadline - Date.now())
      if (l == null) return false
      try { if (JSON.parse(l).type === "ready") return true } catch {}
    }
    return false
  }
  end(place: number, kills: number) {
    this.send({ type: "end", place, kills })
    setTimeout(() => { try { this.proc.kill("SIGKILL") } catch {} }, 300)
  }
}
