export * as DesktopRecovery from "./desktop-recovery"

// This capsule is configured only by the Electron utility-process entrypoint before
// loading the server. It is deliberately not an environment variable or HTTP API.
export type Handoff = { ownerID: string; previousOwners: readonly string[] }
let handoff: Handoff | undefined
let announce: ((ownerID: string) => void) | undefined

export function configure(input: Handoff, onOwner: (ownerID: string) => void) {
  if (handoff) throw new Error("Desktop recovery already configured")
  if (!/^desktop_[a-f0-9-]{36}$/.test(input.ownerID) || input.previousOwners.length > 32 ||
    input.previousOwners.some((id) => !/^desktop_[a-f0-9-]{36}$/.test(id) || id === input.ownerID)) {
    throw new Error("Invalid private desktop recovery handoff")
  }
  handoff = { ownerID: input.ownerID, previousOwners: [...new Set(input.previousOwners)] }
  announce = onOwner
}

export function claimOwner(fallback: string) {
  if (!handoff) return fallback
  announce?.(handoff.ownerID)
  return handoff.ownerID
}

export function predecessors(): readonly string[] {
  return handoff?.previousOwners ?? []
}
