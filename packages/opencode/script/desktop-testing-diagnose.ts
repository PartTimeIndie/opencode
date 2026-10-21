const UNCAUGHT_ERROR_RECENCY_MS = 15 * 60_000

// The renderer console capture records window "error" events as "Uncaught ..."
// one-liners without a stack. A recent uncaught error means the reactive update
// queue may have been aborted mid-render: transport probes and DOM capture then
// still succeed while the visible dock/session content stays stale. Diagnose
// must surface that class instead of classifying the capture as healthy.
export function rendererUncaughtConsoleProblem(input: { console?: unknown; now?: number }): string | undefined {
  if (!Array.isArray(input.console)) return
  const errors = input.console.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return []
    const record = entry as Record<string, unknown>
    if (record.level !== "error" || typeof record.message !== "string") return []
    if (!/^Uncaught/.test(record.message)) return []
    if (typeof record.time !== "number" || !Number.isFinite(record.time)) return []
    return [record as { level: "error"; message: string; time: number }]
  })
  if (errors.length === 0) return

  const stamps = input.console.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return []
    const time = (entry as Record<string, unknown>).time
    return typeof time === "number" && Number.isFinite(time) ? [time] : []
  })
  const now = input.now ?? (stamps.length > 0 ? Math.max(...stamps) : undefined)
  if (now === undefined) return
  const recent = errors.filter((error) => now - error.time <= UNCAUGHT_ERROR_RECENCY_MS)
  if (recent.length === 0) return

  const latest = recent.reduce((a, b) => (b.time > a.time ? b : a))
  const at = new Date(latest.time).toISOString()
  const message = latest.message.length > 300 ? `${latest.message.slice(0, 300)}...` : latest.message
  return `Uncaught renderer error at ${at}: ${message}`
}
