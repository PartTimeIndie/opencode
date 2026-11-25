import type { ServerState } from "../preload/server-state"
export type { ServerState } from "../preload/server-state"

export interface ServerChild {
  ready(signal: AbortSignal): Promise<void>
  exited: Promise<number>
  // Must resolve only after exit is confirmed. Failure prevents overlapping children.
  stop(): Promise<void>
  forceStop?(): Promise<void>
}

export function createServerSupervisor(input: {
  spawn: () => ServerChild
  changed: (state: ServerState) => void
  error: (error: unknown) => void
  timer?: (callback: () => void, ms: number) => () => void
}) {
  const timer = input.timer ?? ((callback, ms) => {
    const handle = setTimeout(callback, ms)
    handle.unref?.()
    return () => clearTimeout(handle)
  })
  let state: ServerState = { phase: "stopped", attempt: 0 }
  let stopped = false
  let unsafe = false
  let child: ServerChild | undefined
  let running: Promise<void> | undefined
  let abort: AbortController | undefined
  let cancelRetry: (() => void) | undefined
  let cancelStable: (() => void) | undefined
  let stopping: Promise<void> | undefined
  const publish = (phase: ServerState["phase"], attempt = state.attempt) => {
    state = { phase, attempt }
    input.changed(state)
  }
  const schedule = () => {
    if (stopped || unsafe || running || child || cancelRetry) return
    if (state.attempt >= 5) return publish("exhausted")
    const attempt = state.attempt + 1
    publish("restarting", attempt)
    cancelRetry = timer(() => {
      cancelRetry = undefined
      void start()
    }, 1_000 * 2 ** (attempt - 1))
  }
  const run = async () => {
    publish(state.attempt ? "restarting" : "starting")
    const controller = new AbortController()
    abort = controller
    const cancelDeadline = timer(() => controller.abort(new Error("Server start exceeded 120000ms")), 120_000)
    let current: ServerChild | undefined
    try {
      current = input.spawn()
      child = current
      const generation = current
      void current.exited.then(() => {
        if (child !== generation) return
        child = undefined
        cancelStable?.()
        cancelStable = undefined
        controller.abort(new Error("Server process exited"))
        schedule()
      })
      await current.ready(controller.signal)
      if (stopped || controller.signal.aborted || child !== current) return
      publish("healthy")
      cancelStable = timer(() => {
        cancelStable = undefined
        if (child === generation && !stopped) publish("healthy", 0)
      }, 300_000)
    } catch (error) {
      if (!stopped) input.error(error)
      if (current && child === current) {
        try {
          await current.stop()
          if (child === current) child = undefined
        } catch (error) {
          unsafe = true
          input.error(error)
          if (!stopped) publish("blocked")
        }
      }
    } finally {
      cancelDeadline()
      if (abort === controller) abort = undefined
    }
  }
  function start(): Promise<void> {
    if (stopped || unsafe) return Promise.resolve()
    if (running) return running
    if (child) return Promise.resolve()
    running = run().finally(() => {
      running = undefined
      schedule()
    })
    return running
  }
  return {
    start,
    snapshot: () => state,
    retry: () => {
      if (stopped || unsafe || state.phase !== "exhausted") return
      publish("starting", 0)
      void start()
    },
    stop: () => {
      if (stopping) return stopping
      stopped = true
      cancelRetry?.()
      cancelStable?.()
      abort?.abort(new Error("Server stopped"))
      publish("stopped")
      stopping = (async () => {
        await child?.stop()
        await running
      })().catch((error) => {
        stopping = undefined
        publish("blocked")
        throw error
      })
      return stopping
    },
    forceStop: async () => {
      if (!stopped) throw new Error("Cannot force a server that is not stopping")
      const current = child
      if (!current) return
      if (!current.forceStop) throw new Error("Forced server stop unavailable")
      await current.forceStop()
      await current.exited
      if (child === current) child = undefined
      await running
      publish("stopped")
    },
  }
}
