import { expect, test } from "bun:test"
import { createServerSupervisor, type ServerChild, type ServerState } from "./server-supervisor"

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function fixture() {
  const timers = new Map<() => void, number>()
  const children: Array<{ exit: (code: number) => void; healthy: () => void; stops: number }> = []
  const states: ServerState[] = []
  const errors: unknown[] = []
  const supervisor = createServerSupervisor({
    timer: (fn, ms) => { timers.set(fn, ms); return () => { timers.delete(fn) } },
    changed: (state) => states.push(state),
    error: (error) => errors.push(error),
    spawn: (): ServerChild => {
      let exit!: (code: number) => void
      let healthy!: () => void
      const exited = new Promise<number>((resolve) => { exit = resolve })
      const ready = new Promise<void>((resolve) => { healthy = resolve })
      const record = { exit, healthy, stops: 0 }
      children.push(record)
      return {
        exited,
        ready: (signal) => new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason)
          signal.addEventListener("abort", abort, { once: true })
          ready.then(() => { signal.removeEventListener("abort", abort); resolve() })
        }),
        stop: async () => { record.stops++; exit(0); await exited },
      }
    },
  })
  const tick = async (ms: number) => {
    const entry = [...timers].find(([, delay]) => delay === ms)
    expect(entry).toBeDefined()
    if (!entry) return
    timers.delete(entry[0]); entry[0](); await flush()
  }
  return { supervisor, timers, children, states, errors, tick }
}

test("restarts pre-ready crashes and bounds five replacements without rapid-success reset", async () => {
  const f = fixture()
  void f.supervisor.start()
  for (let i = 0; i < 6; i++) {
    const child = f.children[i]
    if (i % 2) { child.healthy(); await flush() }
    child.exit(0); await flush()
    if (i < 5) await f.tick(1000 * 2 ** i)
  }
  expect(f.children.length).toBe(6)
  expect(f.supervisor.snapshot()).toEqual({ phase: "exhausted", attempt: 5 })
  expect(f.timers.size).toBe(0)
  f.supervisor.retry(); await flush()
  expect(f.children.length).toBe(7)
  await f.supervisor.stop()
  expect(f.timers.size).toBe(0)
})

test("unconfirmed exit blocks every automatic and manual replacement", async () => {
  const timers = new Map<() => void, number>()
  let starts = 0
  const supervisor = createServerSupervisor({
    changed: () => {}, error: () => {},
    timer: (fn, ms) => { timers.set(fn, ms); return () => { timers.delete(fn) } },
    spawn: () => {
      starts++
      return {
        exited: new Promise<number>(() => {}),
        ready: async () => { throw new Error("startup failed") },
        stop: async () => { throw new Error("exit unconfirmed") },
      }
    },
  })
  await supervisor.start()
  expect(supervisor.snapshot().phase).toBe("blocked")
  supervisor.retry()
  await supervisor.start()
  expect(starts).toBe(1)
  expect(timers.size).toBe(0)
})

test("a failed deliberate stop blocks replacement but permits another deliberate exit check", async () => {
  let starts = 0
  let stops = 0
  let exit!: (code: number) => void
  const exited = new Promise<number>((resolve) => { exit = resolve })
  const supervisor = createServerSupervisor({
    changed: () => {}, error: () => {},
    spawn: () => {
      starts++
      return { exited, ready: async () => {}, stop: async () => {
        if (++stops === 1) throw new Error("exit unconfirmed")
        exit(0)
        await exited
      } }
    },
  })
  await supervisor.start()
  await expect(supervisor.stop()).rejects.toThrow("exit unconfirmed")
  expect(supervisor.snapshot().phase).toBe("blocked")
  supervisor.retry()
  await supervisor.start()
  expect(starts).toBe(1)
  await supervisor.stop()
  expect(stops).toBe(2)
  expect(starts).toBe(1)
})

test("stop during backoff never starts a replacement", async () => {
  const f = fixture()
  void f.supervisor.start()
  f.children[0].exit(1); await flush()
  await f.supervisor.stop()
  f.supervisor.retry()
  expect(f.timers.size).toBe(0)
  expect(f.children.length).toBe(1)
})

test("explicit force after a blocked stop waits for exit and never starts a replacement", async () => {
  let exit!: (code: number) => void
  const exited = new Promise<number>((resolve) => { exit = resolve })
  let starts = 0
  let kills = 0
  const supervisor = createServerSupervisor({
    changed: () => {}, error: () => {},
    spawn: () => {
      starts++
      return { exited, ready: async () => {}, stop: async () => { throw new Error("blocked") },
        forceStop: async () => { kills++; await exited } }
    },
  })
  await supervisor.start()
  await expect(supervisor.forceStop()).rejects.toThrow("not stopping")
  await expect(supervisor.stop()).rejects.toThrow("blocked")
  let finished = false
  const forced = supervisor.forceStop().then(() => { finished = true })
  await flush()
  expect(kills).toBe(1)
  expect(finished).toBe(false)
  exit(1)
  await forced
  supervisor.retry()
  await supervisor.start()
  expect(starts).toBe(1)
  expect(supervisor.snapshot().phase).toBe("stopped")
})

test("start deadline stops the old generation before replacement; stable health resets budget", async () => {
  const f = fixture()
  void f.supervisor.start()
  await f.tick(120_000)
  expect(f.children[0].stops).toBe(1)
  await f.tick(1000)
  f.children[1].healthy(); await flush()
  expect(f.supervisor.snapshot().attempt).toBe(1)
  await f.tick(300_000)
  expect(f.supervisor.snapshot()).toEqual({ phase: "healthy", attempt: 0 })
  f.children[1].exit(1); await flush()
  await f.tick(1000)
  const stopping = f.supervisor.stop()
  await stopping
  expect(f.supervisor.snapshot().phase).toBe("stopped")
  expect(f.timers.size).toBe(0)
})
