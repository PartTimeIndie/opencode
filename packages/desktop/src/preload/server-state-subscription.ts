import type { ServerState } from "./server-state"

export async function subscribeServerState(input: {
  listen: (callback: (state: ServerState) => void) => () => void
  snapshot: () => Promise<ServerState>
}, callback: (state: ServerState) => void) {
  let observed = false
  const stop = input.listen((state) => { observed = true; callback(state) })
  try {
    const state = await input.snapshot()
    // A slow initial snapshot must not overwrite a newer restart/healthy event.
    if (!observed) callback(state)
    return stop
  } catch (error) {
    stop()
    throw error
  }
}
