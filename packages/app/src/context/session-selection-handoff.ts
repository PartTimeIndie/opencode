import { createStore } from "solid-js/store"

// Shared, per-session record of a confirmed agent handoff so every mounted
// LocalProvider of that session (main composer, dock, handoff popup) applies the
// exact confirmed agent/model/chain selection without issuing a second switch
// mutation. Keyed by server scope + directory + session like every other local
// selection state.
export type SessionSelectionHandoffSnapshot = {
  agent: string
  model?: { providerID: string; modelID: string }
  variant?: string | null
  chainID?: string
}

export type SessionSelectionHandoffPhase = "pending" | "committed" | "failed" | "uncertain"

type SessionSelectionHandoffEntry = {
  phase: SessionSelectionHandoffPhase
  generation: number
  snapshot: SessionSelectionHandoffSnapshot
  baselineUpdatedAt?: number
}

const [entries, setEntries] = createStore<Record<string, SessionSelectionHandoffEntry | undefined>>({})

const entryKey = (scope: string, directory: string, sessionID: string) =>
  `${scope}\u0000${directory}\u0000${sessionID}`

// Finished entries stay until the next begin for the same key overwrites them;
// consumers remember the generation they applied, so a committed snapshot never
// reverts a later manual pick and the map stays bounded by touched sessions.
export const sessionSelectionHandoff = {
  entry(scope: string, directory: string, sessionID: string) {
    return entries[entryKey(scope, directory, sessionID)]
  },
  busy(scope: string, directory: string, sessionID: string) {
    return entries[entryKey(scope, directory, sessionID)]?.phase === "pending"
  },
  // baselineUpdatedAt records the canonical session time.updated at begin so a
  // committed selection is not clobbered by the still-stale canonical agent, while a
  // canonically newer external switch from another window always wins.
  begin(
    scope: string,
    directory: string,
    sessionID: string,
    snapshot: SessionSelectionHandoffSnapshot,
    baselineUpdatedAt?: number,
  ): boolean {
    const key = entryKey(scope, directory, sessionID)
    const current = entries[key]
    if (current?.phase === "pending") return false
    setEntries(key, {
      phase: "pending",
      generation: (current?.generation ?? 0) + 1,
      snapshot: { ...snapshot },
      baselineUpdatedAt,
    })
    return true
  },
  commit(scope: string, directory: string, sessionID: string, snapshot: SessionSelectionHandoffSnapshot) {
    settle(scope, directory, sessionID, "committed", snapshot)
  },
  fail(scope: string, directory: string, sessionID: string) {
    settle(scope, directory, sessionID, "failed")
  },
  uncertain(scope: string, directory: string, sessionID: string) {
    settle(scope, directory, sessionID, "uncertain")
  },
}

function settle(
  scope: string,
  directory: string,
  sessionID: string,
  phase: Exclude<SessionSelectionHandoffPhase, "pending">,
  snapshot?: SessionSelectionHandoffSnapshot,
) {
  const key = entryKey(scope, directory, sessionID)
  const current = entries[key]
  if (current?.phase !== "pending") return
  setEntries(key, { phase, generation: current.generation, snapshot: snapshot ? { ...snapshot } : current.snapshot })
}
