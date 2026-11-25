import { randomUUID } from "node:crypto"

// Actions reserve before asking the renderer for its current target. This closes
// the gap in which a transfer could otherwise finish during target resolution.
export function createBrowserTransferGuard() {
  let actions = 0
  const pending = new Map<number, string>()
  const docked = new Map<number, string>()
  const listeners = new Set<(id: number) => void>()

  return {
    beginAction() {
      if (pending.size) throw new Error("Browser transfer is in progress")
      actions += 1
      let released = false
      return () => {
        if (released) return
        released = true
        actions -= 1
      }
    },
    assertAccessible(id: number) {
      if (docked.has(id) || pending.has(id)) throw new Error("Browser guest belongs to a dock")
    },
    reserve(id: number) {
      if (!Number.isSafeInteger(id) || id <= 0 || actions || pending.has(id) || docked.has(id)) return
      const ticket = randomUUID()
      pending.set(id, ticket)
      try {
        for (const listener of listeners) listener(id)
      } catch (error) {
        pending.delete(id)
        throw error
      }
      return ticket
    },
    commit(id: number, ticket: string) {
      if (pending.get(id) !== ticket) return false
      pending.delete(id)
      docked.set(id, ticket)
      return true
    },
    cancel(id: number, ticket: string) {
      if (pending.get(id) !== ticket) return false
      pending.delete(id)
      return true
    },
    returnToBrowser(id: number, ticket: string) {
      if (docked.get(id) !== ticket) return false
      return docked.delete(id)
    },
    onReserve(listener: (id: number) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export const browserTransferGuard = createBrowserTransferGuard()
