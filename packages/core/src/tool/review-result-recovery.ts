import { FanoutWorkflow } from "../fanout-workflow"
import { SessionMessage } from "../session/message"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

export type RecoveredReview = {
  status: "complete" | "partial" | "error"
  findings: unknown[]
  original: string
  issues: string[]
  result?: unknown
}

/** The complete registered schema remains authoritative; a valid item never makes an invalid report complete. */
export function recoverReviewResult(schema: Record<string, unknown>, original: string): RecoveredReview {
  const value = parse(original)
  const complete = FanoutWorkflow.resultDecoder(schema)(value === undefined ? original : JSON.stringify(value))
  if (complete !== undefined) return {
    status: "complete", findings: findings(complete), original, issues: [], result: complete,
  }
  const items = value && typeof value === "object" && !Array.isArray(value) && "findings" in value
    ? (value as { findings?: unknown }).findings : undefined
  if (!Array.isArray(items)) return { status: "error", findings: [], original, issues: ["Missing or unreadable findings"] }
  const shape = schema.properties && typeof schema.properties === "object"
    ? (schema.properties as Record<string, unknown>).findings : undefined
  const item = shape && typeof shape === "object" && !Array.isArray(shape)
    ? (shape as Record<string, unknown>).items : undefined
  if (!item || typeof item !== "object" || Array.isArray(item))
    return { status: "error", findings: [], original, issues: ["Finding schema cannot be checked separately"] }
  // Preserve definitions and the schema dialect while validating one item at a time.
  const itemSchema = { ...item, $defs: schema.$defs, definitions: schema.definitions } as Record<string, unknown>
  // Custom or nonseparable item constraints must fail closed rather than crashing the collector.
  const validate = (() => {
    try { return FanoutWorkflow.resultDecoder(itemSchema) } catch { return undefined }
  })()
  if (!validate) return { status: "error", findings: [], original, issues: ["Finding schema cannot be checked separately"] }
  const checks = items.map((entry) => validate(JSON.stringify(entry)) !== undefined)
  const valid = items.filter((_, index) => checks[index])
  return {
    status: valid.length ? "partial" : "error",
    findings: valid,
    original,
    issues: [
      ...checks.flatMap((ok, index) => ok ? [] : [`findings[${index}]: invalid against registered item schema`]),
      "The complete review does not match the registered result schema",
    ],
  }
}

export function originalReviewResponse(messages: ReadonlyArray<SessionMessage.Message>, promptID: SessionMessage.ID) {
  return reviewEvidence(messages, promptID)?.reports.at(-1)?.text
}

export type ReviewEvidenceReference = {
  messageID: SessionMessage.ID
  partIDs: string[]
  digest: string
  phase: "initial" | "correction" | "legacy"
  findingIndexes: number[]
}

/** Inspect both attempts locally; a collector never owns another provider turn. */
export function collectReviewResult(input: {
  schema: Record<string, unknown>
  messages: ReadonlyArray<SessionMessage.Message>
  promptID: SessionMessage.ID
  completed: boolean
  text: string
  recoveryEnabled: boolean
}) {
  const evidence = reviewEvidence(input.messages, input.promptID)
  if (!evidence || (!input.recoveryEnabled && !evidence.runnerOwned))
    return { partial: false, result: undefined, recovery: undefined }
  const findings: unknown[] = []
  const sources: ReviewEvidenceReference[] = []
  const issues: string[] = []
  for (const report of evidence.reports) {
    const salvaged = recoverReviewResult(input.schema, report.text)
    const findingIndexes = salvaged.findings.map((finding) => {
      const index = findings.findIndex((item) => isDeepStrictEqual(item, finding))
      if (index >= 0) return index
      findings.push(finding)
      return findings.length - 1
    })
    sources.push({ ...report.reference, findingIndexes })
    issues.push(...salvaged.issues)
  }
  const candidate = input.completed ? FanoutWorkflow.resultDecoder(input.schema)(input.text) : undefined
  const candidateFindings = candidate && typeof candidate === "object" && "findings" in candidate && Array.isArray(candidate.findings)
    ? candidate.findings : []
  const partial = candidate !== undefined && findings.some((finding) =>
    !candidateFindings.some((item) => isDeepStrictEqual(item, finding)))
  return {
    partial,
    result: partial ? undefined : candidate,
    recovery: {
      source: candidate !== undefined && !partial ? "repaired" as const : "original" as const,
      findings,
      original: evidence.reports.at(-1)?.text ?? "",
      ...(candidate === undefined ? {} : { repaired: input.text }),
      evidence: sources,
      issues: partial ? [...issues, "Correction did not retain every validated original finding"] : issues,
    },
  }
}

function reviewEvidence(messages: ReadonlyArray<SessionMessage.Message>, promptID: SessionMessage.ID) {
  const start = messages.findIndex((message) => message.id === promptID && message.type === "user")
  if (start < 0) return
  const window = messages.slice(start + 1)
  const next = window.findIndex((message) => message.type === "user")
  const assistants = (next < 0 ? window : window.slice(0, next))
    .filter((message): message is SessionMessage.Assistant => message.type === "assistant")
  const bound = assistants.filter((message) => message.structuredOutputAttempt?.inputID === promptID)
  const runnerOwned = bound.length > 0
  const failure = assistants.at(-1)?.failure
  if (!runnerOwned && (failure?.code !== "provider.invalid-response" || failure.cause?.detail !== "structured output")) return
  const originals = bound.filter((message) => message.structuredOutputAttempt?.phase === "initial")
  // Incomplete imported history may contribute partial evidence, never a new request.
  const selected = runnerOwned ? originals.length ? originals : bound : assistants
  const reports = selected.flatMap((message) => {
    const phase: ReviewEvidenceReference["phase"] = message.structuredOutputAttempt?.phase ?? "legacy"
    const tools = message.content.flatMap((part) => part.type === "tool" && part.name === "StructuredOutput" &&
      (part.state.status === "error" || part.state.status === "completed") &&
      part.state.input && typeof part.state.input === "object" && Object.keys(part.state.input).length
      ? [{ text: JSON.stringify(part.state.input), partIDs: [part.id] }] : [])
    const texts = message.content.filter((part): part is SessionMessage.AssistantText => part.type === "text" && part.text.trim().length > 0)
    const values = tools.length ? tools : texts.length ? [{ text: texts.map((part) => part.text.trim()).join("\n"), partIDs: texts.map((part) => part.id) }] : []
    return values.map((value) => ({
      text: value.text,
      reference: { messageID: message.id, partIDs: value.partIDs, phase,
        digest: createHash("sha256").update(value.text).digest("hex") },
    }))
  })
  return reports.length ? { runnerOwned, reports } : undefined
}

export function repairableReview(original: string) {
  const parsed = parse(original)
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    if (Array.isArray((parsed as { findings?: unknown }).findings))
      return (parsed as { findings: unknown[] }).findings.some((entry) =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry) &&
        Object.values(entry).some((value) => typeof value === "string" && value.trim().length > 8 &&
          !/^(?:i(?:'ll| will)|ich werde|sorry)/i.test(value.trim())))
    return false
  }
  if (!original.trim() || /^(?:i(?:'ll| will| can| am going to)|ich (?:werde|kann)|sorry|error:|fehler:)/i.test(original.trim())) return false
  return /(?:finding|issue|bug|befund|fehler)\s*[:#-]\s*\S.{7,}/i.test(original)
}

function findings(value: unknown): unknown[] {
  if (value && typeof value === "object" && "findings" in value && Array.isArray(value.findings)) return value.findings
  return []
}

function parse(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed)
  try { return JSON.parse(fenced ? fenced[1]! : trimmed) } catch { return undefined }
}
