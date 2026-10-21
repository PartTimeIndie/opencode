const defaultRendererTimeout = 10_000
const pluginAutomationTimeout = 120_000

export function desktopTestingRendererTimeout(type: "action" | "screen-state" | "prepare-recovery", payload?: unknown) {
  if (type !== "action" || !payload || typeof payload !== "object" || Array.isArray(payload))
    return defaultRendererTimeout
  const action = payload as Record<string, unknown>
  // A cold session can warm up before recording the prompt or durable reply.
  // Expiring the IPC waiter does not cancel that mutation in the renderer.
  if (action.type === "session.open" || action.type === "session.prompt" || action.type === "question.reply")
    return 60_000
  if (action.type !== "plugin.automation.run") return defaultRendererTimeout
  if (typeof action.timeout !== "number" || !Number.isFinite(action.timeout)) return pluginAutomationTimeout
  return Math.min(Math.max(action.timeout, 1_000), 600_000)
}
