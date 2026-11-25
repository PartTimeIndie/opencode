export type ReviewerDetail = {
  model: string
  variant?: string
  state: "queued" | "starting" | "running" | "completed" | "repaired" | "partial" | "error" | "unknown"
  sessionID?: string
  text?: string
  recovery?: { source: "original" | "repaired"; findings: unknown[]; original: string; repaired?: string; issues: string[]; repairStatus?: string }
}

export function reviewerText(fallback: string, value: unknown) {
  const result = record(value)
  if (!result) return fallback
  const findings = Array.isArray(result.findings)
    ? result.findings.flatMap((value) => {
        const finding = record(value)
        if (!finding || typeof finding.title !== "string") return []
        return [`${finding.title}${typeof finding.body === "string" ? `\n${finding.body}` : ""}`]
      })
    : []
  const notes = Array.isArray(result.notes)
    ? result.notes.filter((note): note is string => typeof note === "string")
    : []
  const summary = typeof result.summary === "string" ? [result.summary] : []
  return [...summary, ...findings, ...notes].join("\n\n") || fallback
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Only display fields cross this boundary; never expose arbitrary runtime metadata. */
export function toolDetailsMetadata(
  tool: string,
  structured?: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
) {
  if (!structured) return metadata
  structured = record(structured.toolDetails) ?? structured
  if (tool === "bash") {
    const fields = Object.fromEntries(
      Object.entries(structured).filter(
        ([key, value]) =>
          (["command", "cwd", "output"].includes(key) && typeof value === "string") ||
          (["truncated", "timedOut"].includes(key) && typeof value === "boolean") ||
          (key === "exitCode" && typeof value === "number" && Number.isFinite(value)),
      ),
    )
    const capture = record(structured.capture)
    return {
      ...metadata,
      ...fields,
      ...(Array.isArray(structured.warnings)
        ? { warnings: structured.warnings.filter((warning): warning is string => typeof warning === "string") }
        : {}),
      ...(capture && typeof capture.uri === "string" && capture.uri.startsWith("attachment://")
        ? { capture: { uri: capture.uri, complete: capture.complete === true } }
        : {}),
    }
  }
  if (tool !== "multi_agent_fanout") return metadata
  return {
    ...metadata,
    ...(typeof structured.workflow === "string" ? { workflow: structured.workflow } : {}),
    reviewers: reviewerDetails(structured),
  }
}

/** Small replayable display snapshot retained when a large result becomes a content reference. */
export function boundedToolDetails(tool: string, structured: unknown) {
  if ((tool !== "bash" && tool !== "multi_agent_fanout") || !record(structured)) return undefined
  const details = toolDetailsMetadata(tool, record(structured))
  if (tool === "bash") {
    const output = typeof details.output === "string" ? details.output : ""
    return {
      ...details,
      output: output.slice(0, 16000).replace(/[\uD800-\uDBFF]$/, ""),
      truncated: details.truncated === true || output.length > 16000,
    }
  }
  const rows = reviewerDetails(details)
  return {
    ...details,
    reviewers: rows.map((row) => {
      const limit = Math.max(1, Math.floor(12000 / rows.length))
      const clip = (value: string) => {
        const bytes = Buffer.from(value)
        return bytes.length > limit ? `${bytes.subarray(0, Math.max(0, limit - 120)).toString("utf8")}\n[Preview shortened; open the agent session for the full result]` : value
      }
      const preview = row.text === undefined ? undefined : clip(row.text)
      const original = row.recovery?.original
      const repaired = row.recovery?.repaired
      return {
        ...row,
        ...(preview === undefined ? {} : { text: preview }),
        ...(row.recovery ? { recovery: {
          ...row.recovery,
          findings: [],
          original: clip(original ?? ""),
          ...(repaired === undefined ? {} : { repaired: clip(repaired) }),
          issues: row.recovery.issues.slice(0, 10).map((issue) => clip(issue.slice(0, 200))),
        } } : {}),
      }
    }),
  }
}

export function reviewerDetails(value: Record<string, unknown>): ReviewerDetail[] {
  const source = Array.isArray(value.results) ? value.results : Array.isArray(value.reviewers) ? value.reviewers : []
  return source.flatMap((item): ReviewerDetail[] => {
    const row = record(item)
    const reviewer = record(row?.reviewer) ?? row
    if (!row || typeof reviewer?.model !== "string") return []
    const task = record(row.task)
    const raw = task ? (row.status === "partial" ? "partial" : row.status === "success" ? (record(row.recovery)?.source === "repaired" ? "repaired" : "completed") : "error")
      : row.state === "completed" && record(row.recovery)?.source === "repaired" ? "repaired" : row.state
    const state =
      raw === "queued" || raw === "starting" || raw === "running" || raw === "completed" || raw === "repaired" || raw === "partial" || raw === "error"
        ? raw
        : // Missing or foreign state values stay visible as unknown instead of hiding the reviewer row.
          "unknown"
    const sessionID = row.sessionID ?? (task?.state === "completed" ? task.sessionID : undefined)
    const text = task?.text ?? row.text
    const recovery = record(row.recovery)
    const source = recovery?.source
    const original = recovery?.original
    const repaired = recovery?.repaired
    const issues = recovery?.issues
    const safeRecovery = (source === "original" || source === "repaired") && typeof original === "string" && Array.isArray(issues)
      ? { source: source as "original" | "repaired", original, findings: Array.isArray(recovery?.findings) ? recovery.findings : [],
          ...(typeof repaired === "string" ? { repaired } : {}),
          issues: issues.filter((issue): issue is string => typeof issue === "string"),
          ...(typeof recovery?.repairStatus === "string" ? { repairStatus: recovery.repairStatus } : {}),
        } : undefined
    return [
      {
        model: reviewer.model,
        ...(typeof reviewer.variant === "string" ? { variant: reviewer.variant } : {}),
        state,
        ...(typeof sessionID === "string" && /^ses_[a-zA-Z0-9_-]+$/.test(sessionID) ? { sessionID } : {}),
        ...(typeof text === "string" ? { text: reviewerText(text, row.result ?? (safeRecovery?.findings.length ? { findings: safeRecovery.findings } : undefined)) } : {}),
        ...(safeRecovery ? { recovery: safeRecovery } : {}),
      },
    ]
  })
}
