import { createStore } from "solid-js/store"
import type { SessionDelegationPreferencesResponses, SessionPatchDelegationPreferencesData } from "@opencode-ai/sdk/v2"

export type DelegationSnapshot = SessionDelegationPreferencesResponses[200]
export type DelegationPatch = NonNullable<SessionPatchDelegationPreferencesData["body"]>["patch"]
export type DelegationScope = DelegationSnapshot["scope"]
export type DelegationTarget = {
  server: object
  sessionID: string
  directory?: string
  scope: DelegationScope
  taskID?: string
}

const sameTarget = (a: DelegationTarget | undefined, b: DelegationTarget | undefined) =>
  a !== undefined && b !== undefined && a.server === b.server && a.sessionID === b.sessionID &&
  a.directory === b.directory && a.scope === b.scope && a.taskID === b.taskID

const assertReceipt = (target: DelegationTarget, snapshot: DelegationSnapshot) => {
  if (snapshot.scope !== target.scope || snapshot.taskID !== target.taskID)
    throw new Error("The server returned a different scope. Read the intended scope again.")
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message
  : typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message : "The request failed. Read the scope again before saving; an uncertain save must not be retried."

/** A read receipt belongs to one server, Session-at-click and explicit scope.
 * Never reload/retry a failed write automatically or apply a late reply to a new target. */
export function createDelegationSettingsModel(input: {
  target: () => DelegationTarget | undefined
  read: (target: DelegationTarget) => Promise<DelegationSnapshot>
  patch: (target: DelegationTarget, patch: DelegationPatch,
    expected: { expectedRevision?: number; expectedVersion?: string }) => Promise<DelegationSnapshot>
}) {
  const [state, setState] = createStore<{
    snapshot?: DelegationSnapshot
    busy: boolean
    error?: string
  }>({ busy: false })
  let epoch = 0
  let bound: DelegationTarget | undefined
  let disposed = false
  const current = (run: number, target: DelegationTarget) =>
    !disposed && run === epoch && sameTarget(target, input.target())
  const reset = () => {
    epoch++
    bound = undefined
    setState({ snapshot: undefined, busy: false, error: undefined })
  }
  const begin = () => {
    if (state.busy || disposed) return
    const target = input.target()
    if (!target || (target.scope === "task" && !target.taskID?.trim())) {
      setState("error", "Open a Session and select an explicit owned task when using task scope.")
      return
    }
    setState({ busy: true, error: undefined })
    return { target: { ...target }, run: ++epoch }
  }
  return {
    state,
    reset,
    dispose() { disposed = true; reset() },
    async read() {
      const request = begin()
      if (!request) return
      bound = undefined
      setState("snapshot", undefined)
      try {
        const snapshot = await input.read(request.target)
        if (!current(request.run, request.target)) return
        assertReceipt(request.target, snapshot)
        bound = request.target
        setState("snapshot", structuredClone(snapshot))
        return snapshot
      } catch (error) {
        if (current(request.run, request.target)) setState("error", errorMessage(error))
      } finally {
        if (current(request.run, request.target)) setState("busy", false)
      }
    },
    async save(patch: DelegationPatch) {
      const snapshot = state.snapshot
      if (!snapshot || !sameTarget(bound, input.target())) {
        reset()
        setState("error", "The target changed. Read the current scope before saving.")
        return
      }
      const expected = snapshot.scope === "session" || snapshot.scope === "task"
        ? { expectedRevision: snapshot.revision } : { expectedVersion: snapshot.version }
      if (expected.expectedRevision === undefined && expected.expectedVersion === undefined) {
        setState("error", "The server did not return a revision or file version. Saving is blocked.")
        return
      }
      const request = begin()
      if (!request) return
      try {
        const saved = await input.patch(request.target, structuredClone(patch), expected)
        if (!current(request.run, request.target)) return
        assertReceipt(request.target, saved)
        setState("snapshot", structuredClone(saved))
      } catch (error) {
        if (!current(request.run, request.target)) return
        bound = undefined
        setState({ snapshot: undefined, error: errorMessage(error) })
      } finally {
        if (current(request.run, request.target)) setState("busy", false)
      }
    },
  }
}
