// Electron's utility-process error event is (type, location, report), not Error.
// Never persist the raw Node report: it includes environment credentials and
// command-line arguments. Only bounded stack frames belong in desktop logs.
export function formatSidecarFatalError(type: string, location: string, report: string) {
  const summary = `utility process error: ${type.slice(0, 80)} location=${location.slice(0, 512)}`
  if (report.length > 2_000_000) return `${summary} (report omitted: too large)`
  const parsed = parseReport(report)
  if (!parsed) return `${summary} (report omitted: invalid)`
  const javascript = isRecord(parsed.javascriptStack) ? parsed.javascriptStack.stack : undefined
  const native = Array.isArray(parsed.nativeStack) ? parsed.nativeStack : []
  return `${summary} ${JSON.stringify({
    javascriptStack: frames(javascript),
    nativeStack: frames(native.slice(0, 24).map((frame: unknown) => isRecord(frame) ? frame.symbol : undefined)),
  })}`
}

function frames(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 24).filter((frame): frame is string => typeof frame === "string")
    .map((frame) => frame.slice(0, 512))
}

function parseReport(report: string) {
  try {
    const value: unknown = JSON.parse(report)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
