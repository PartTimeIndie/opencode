const expectedInterruptReasons = new Set(["user-stop", "owner-interrupted", "owner-shutdown", "stale-lease", "rollback"])

export function sessionNotificationEvent(event: {
  type: string
  properties?: unknown
}): "idle" | "error" | undefined {
  const normalized = event.type.replace(/\.\d+$/, "")
  if (normalized === "session.idle" || normalized === "session.next.activity.completed") return "idle"
  if (normalized === "session.error" || normalized === "session.next.activity.failed") return "error"
  if (normalized !== "session.next.activity.interrupted") return
  if (!event.properties || typeof event.properties !== "object" || !("reason" in event.properties)) return "error"
  if (typeof event.properties.reason !== "string") return "error"
  if (!expectedInterruptReasons.has(event.properties.reason)) return "error"
}
