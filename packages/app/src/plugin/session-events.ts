import type { AppHostSessionEvent, AppHostSessionMessage } from "@opencode-ai/plugin/app"

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function createSessionSubscription(input: {
  sessionID: string
  pending: () => Promise<unknown[]>
  session: (id: string) => Promise<{ parentID?: string } | undefined>
  relatedSession?: () => Promise<string | undefined>
  emit: (event: AppHostSessionEvent) => void
}) {
  const sessions = new Set([input.sessionID])
  const pending = new Set<string>()
  const permissionOwners = new Map<string, string>()
  const revisions = new Map<string, number>()
  const seen = new Set<string>()
  let disposed = false
  let recovery: Promise<void> | undefined

  async function belongs(id: string) {
    const visited = new Set<string>()
    let current: string | undefined = id
    while (current && !sessions.has(current)) {
      if (visited.has(current) || disposed) return false
      visited.add(current)
      current = (await input.session(current))?.parentID
    }
    if (!current) return false
    visited.forEach((id) => sessions.add(id))
    return true
  }

  function emit(event: AppHostSessionEvent) {
    if (disposed) return
    if (event.type === "permission.asked") {
      pending.add(event.requestID)
      permissionOwners.set(event.requestID, event.sessionID)
    }
    if (event.type === "permission.replied") {
      pending.delete(event.requestID)
      permissionOwners.delete(event.requestID)
    }
    input.emit(event)
  }

  async function permissionScope(properties: Record<string, unknown>, replied: boolean) {
    if (typeof properties.sessionID !== "string") return
    if (await belongs(properties.sessionID)) return sessions
    // Related requests are display scope only; the server retains permission authority.
    // Never cache their sessions as ancestry for subsequent unrelated work.
    const owned = typeof properties.requestID === "string" &&
      permissionOwners.get(properties.requestID) === properties.sessionID
    // A known reply may clear a displayed request even after the link ended.
    // Unknown replies only advance revisions in receive(), preventing stale replay.
    if (replied) return owned ? new Set([...sessions, properties.sessionID]) : undefined
    const singleUse = isRecord(properties.metadata) && properties.metadata["$opencode.permission.single_use"] === true
    if (!singleUse || !input.relatedSession || (await input.relatedSession()) !== properties.sessionID) return
    return new Set([...sessions, properties.sessionID])
  }

  async function receive(incoming: unknown) {
    const value = sessionEventEnvelope(incoming)
    if (disposed || !isRecord(value) || !isRecord(value.properties)) return
    if (typeof value.id === "string") {
      if (seen.has(value.id)) return
      seen.add(value.id)
      if (seen.size > 2048) seen.delete(seen.values().next().value!)
    }
    const properties = value.properties
    if (value.type === "session.created" && isRecord(properties.info)) {
      const info = properties.info
      if (typeof info.id === "string" && typeof info.parentID === "string" && sessions.has(info.parentID))
        sessions.add(info.id)
      return
    }
    if (value.type === "permission.v2.asked" || value.type === "permission.v2.replied") {
      const id = value.type === "permission.v2.asked" ? properties.id : properties.requestID
      if (typeof id !== "string" || typeof properties.sessionID !== "string") return
      const revision = (revisions.get(id) ?? 0) + 1
      revisions.set(id, revision)
      const scope = await permissionScope(properties, value.type === "permission.v2.replied")
      if (!scope || revisions.get(id) !== revision) return
      const event = sessionEvent(value, input.sessionID, scope)
      if (event) emit(event)
      return
    }
    const event = sessionEvent(value, input.sessionID, sessions)
    if (event) emit(event)
  }

  function recover() {
    if (disposed) return Promise.resolve()
    if (recovery) return recovery
    const before = new Map(revisions)
    recovery = input.pending().then(async (requests) => {
      const present = new Set<string>()
      for (const request of requests) {
        if (!isRecord(request) || typeof request.id !== "string" || typeof request.sessionID !== "string") continue
        const scope = await permissionScope(request, false)
        if (!scope) continue
        present.add(request.id)
        // Live replies win over a snapshot fetched before the reply arrived.
        if (before.get(request.id) !== revisions.get(request.id)) continue
        const event = sessionEvent({ type: "permission.v2.asked", properties: request }, input.sessionID, scope)
        if (event) emit(event)
      }
      pending.forEach((id) => {
        if (!present.has(id) && before.get(id) === revisions.get(id)) emit({ type: "permission.replied", requestID: id })
      })
    }).finally(() => { recovery = undefined })
    return recovery
  }

  return { receive, recover, dispose() { disposed = true; seen.clear() } }
}

/** Durable V2 events arrive on the sync channel with versioned types. Live
 * deltas retain their unversioned event envelope. Both share event IDs. */
function sessionEventEnvelope(value: unknown): unknown {
  if (!isRecord(value) || value.type !== "sync") return value
  const event = value.syncEvent
  if (!isRecord(event) || typeof event.type !== "string" || typeof event.id !== "string" || !isRecord(event.data)) return
  if (typeof event.aggregateID !== "string" || event.data.sessionID !== event.aggregateID) return
  return { id: event.id, type: event.type.replace(/\.\d+$/, ""), properties: event.data }
}

export function sessionEvent(
  event: unknown,
  sessionID: string,
  permissionSessionIDs: ReadonlySet<string> = new Set([sessionID]),
): AppHostSessionEvent | undefined {
  const value = sessionEventEnvelope(event)
  if (!isRecord(value) || typeof value.type !== "string" || !isRecord(value.properties)) return
  const properties = value.properties
  if (
    value.type === "permission.v2.asked" &&
    typeof properties.sessionID === "string" &&
    permissionSessionIDs.has(properties.sessionID) &&
    typeof properties.id === "string" &&
    typeof properties.action === "string" &&
    Array.isArray(properties.resources)
  )
    return {
      type: "permission.asked",
      sessionID: properties.sessionID,
      requestID: properties.id,
      action: properties.action,
      resources: properties.resources.filter((item): item is string => typeof item === "string"),
    }
  if (
    value.type === "permission.v2.replied" &&
    typeof properties.sessionID === "string" &&
    permissionSessionIDs.has(properties.sessionID) &&
    typeof properties.requestID === "string"
  )
    return { type: "permission.replied", requestID: properties.requestID }
  if (properties.sessionID !== sessionID) return
  if (
    value.type === "session.next.text.delta" &&
    typeof properties.assistantMessageID === "string" &&
    typeof properties.textID === "string" &&
    typeof properties.delta === "string"
  )
    return {
      type: "text.delta",
      messageID: properties.assistantMessageID,
      textID: properties.textID,
      delta: properties.delta,
    }
  if (
    value.type === "session.next.text.ended" &&
    typeof properties.assistantMessageID === "string" &&
    typeof properties.textID === "string" &&
    typeof properties.text === "string"
  )
    return {
      type: "text.ended",
      messageID: properties.assistantMessageID,
      textID: properties.textID,
      text: properties.text,
    }
  if (value.type === "session.next.activity.started" || value.type === "session.next.activity.recovered")
    return { type: "activity.started" }
  if (value.type === "session.next.activity.completed") return { type: "activity.completed" }
  if (value.type === "session.next.activity.interrupted") return { type: "activity.interrupted" }
  if (value.type === "session.next.activity.failed")
    return {
      type: "activity.failed",
      error:
        typeof properties.error === "string"
          ? properties.error
          : isRecord(properties.error) && typeof properties.error.message === "string"
            ? properties.error.message
            : "Voice session failed",
    }
}

export function sessionMessages(value: unknown): AppHostSessionMessage[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): AppHostSessionMessage[] => {
    if (!isRecord(item) || typeof item.id !== "string" || !isRecord(item.time) || typeof item.time.created !== "number")
      return []
    if (item.type === "user" && typeof item.text === "string")
      return [{ id: item.id, role: "user" as const, text: item.text, createdAt: item.time.created }]
    if (item.type !== "assistant" || !Array.isArray(item.content)) return []
    const text = item.content
      .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text")
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim()
    return text ? [{ id: item.id, role: "assistant" as const, text, createdAt: item.time.created }] : []
  })
}
