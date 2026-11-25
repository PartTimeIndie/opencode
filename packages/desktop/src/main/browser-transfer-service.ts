import { createBrowserTransferGuard } from "./browser-transfer-guard"

type Guard = ReturnType<typeof createBrowserTransferGuard>

// The Electron boundary supplies host/guest validation; keeping ownership here
// prevents one renderer from completing another renderer's reservation.
export function createBrowserTransferService(guard: Guard, owns: (host: number, guest: number) => boolean, reservationTimeoutMs = 30_000) {
  const entries = new Map<number, { host: number; ticket: string; committed: boolean; timer: ReturnType<typeof setTimeout> }>()
  const verify = (host: number, guest: number) => {
    if (!Number.isSafeInteger(host) || !Number.isSafeInteger(guest) || !owns(host, guest)) {
      throw new Error("Browser guest owner does not match the requesting window")
    }
  }
  const matches = (host: number, guest: number, ticket: string) => {
    const entry = entries.get(guest)
    return entry?.host === host && entry.ticket === ticket ? entry : undefined
  }
  const cleanup = (guest: number) => {
    const entry = entries.get(guest)
    if (!entry) return
    clearTimeout(entry.timer)
    if (entry.committed) guard.returnToBrowser(guest, entry.ticket)
    else guard.cancel(guest, entry.ticket)
    entries.delete(guest)
  }
  return {
    reserve(host: number, guest: number) {
      verify(host, guest)
      const ticket = guard.reserve(guest)
      if (!ticket) throw new Error("Browser is already being used or transferred")
      // An abandoned reserve must not block every normal browser action forever.
      // Only pending ownership expires; committed docks remain fail-closed.
      const timer = setTimeout(() => {
        const entry = matches(host, guest, ticket)
        if (entry && !entry.committed) cleanup(guest)
      }, reservationTimeoutMs)
      timer.unref()
      entries.set(guest, { host, ticket, committed: false, timer })
      return ticket
    },
    commit(host: number, guest: number, ticket: string) {
      verify(host, guest)
      const entry = matches(host, guest, ticket)
      if (!entry || entry.committed || !guard.commit(guest, ticket)) return false
      entry.committed = true
      clearTimeout(entry.timer)
      return true
    },
    release(host: number, guest: number, ticket: string) {
      verify(host, guest)
      if (!matches(host, guest, ticket)) return false
      cleanup(guest)
      return true
    },
    closeGuest(guest: number) {
      cleanup(guest)
    },
    closeHost(host: number) {
      for (const [guest, entry] of entries) if (entry.host === host) cleanup(guest)
    },
  }
}
