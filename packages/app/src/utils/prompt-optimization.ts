import type { OptimizationSettings } from "@/context/settings"

const LOG_KEYWORDS = /\b(error|fail|failed|exception|traceback|assertion|warning|fatal)\b/i
const PATH_WITH_LINE = /(?:[A-Za-z]:)?[^\s:]+\.(?:py|ts|tsx|js|jsx|go|rs|java|cs|cpp|c|h):\d+/
const TEST_LOG_HINT = /\b(pytest|unittest|vitest|jest|bun test|cargo test|go test|FAILED|FAIL:|AssertionError|Traceback)\b/i
const MIN_LOG_COMPRESSION_CHARS = 12_000
const LOG_PREFIX = /^\s*(?:\[[^\]]+\]|\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}:\d{2}|(?:INFO|DEBUG|TRACE|WARN|WARNING|ERROR|FATAL|PASS|FAIL|FAILED|ok|not ok)\b|[>#]\s|at\s+\S|File\s+"|\d+[.):]|[-=]{3,})/i

export type PromptOptimizationInput = {
  text: string
  settings: OptimizationSettings
  contextFileCount: number
  fileAttachmentCount: number
}

export type PromptOptimizationResult = {
  requestText?: string
  system?: string
  compactedVerifierContext: boolean
}

export function buildPromptOptimization(input: PromptOptimizationInput): PromptOptimizationResult {
  if (input.settings.optimizationProfile === "off") return { compactedVerifierContext: false }

  const compacted = input.settings.compactVerifierContext ? compactVerifierContext(input.text) : undefined
  const coreFeatures = [
    input.settings.toolContextCompression ? "tool_context_compression" : undefined,
    input.settings.coreSearchLimits ? "core_search_limits" : undefined,
    input.settings.toolMaterializationCache ? "tool_materialization_cache" : undefined,
    input.settings.runnerRequestMetrics ? "runner_request_metrics" : undefined,
  ].filter((feature): feature is string => feature !== undefined)
  const rules = [
    `Optimization profile: ${input.settings.optimizationProfile}. Keep correctness checks intact; speed optimizations must stay reversible through feature toggles.`,
    "Session continuity after context compaction: treat the retained conversation summary, system context, todo state, and current working tree as the authoritative continuation of the same task. Reconstruct missing details from that evidence and continue in-progress work instead of asking the user to repeat prior context; ask only when the remaining ambiguity makes the next action materially unsafe.",
    coreFeatures.length > 0
      ? `Core optimization feature preferences: ${coreFeatures.join(", ")}. Server-side behavior still requires matching OpenCode config or benchmark environment flags.`
      : undefined,
    input.settings.toolContextCompression
      ? "Tool-context compression: large log, search, diff, or JSON tool output may arrive as a compressed view with a stored original. Trust the view's stated omissions and use the referenced stored artifact via targeted reads instead of broad re-reads."
      : undefined,
    input.settings.externalContextReduction
      ? "External context reduction: stay in the current workspace and avoid loading external skills, docs, plugins, or broad repository context unless the user explicitly asks or the evidence requires it."
      : undefined,
    input.settings.sourceTestContextPack
      ? `Source/test context pack: prefer the attached prompt context (${input.contextFileCount} context files, ${input.fileAttachmentCount} inline file attachments) before broad file reads; read only missing files or ranges needed for the change.`
      : undefined,
    input.settings.compactVerifierContext
      ? "Compact verifier context: when test or verifier output is present, use the diagnostic lines to target the smallest safe fix instead of rediscovering the same failure through broad exploration."
      : undefined,
    input.settings.selfTestPolicy
      ? "Self-test policy: after editing, run the smallest relevant verifier or test once. Do not skip self-verification; if a check cannot run, state the blocker."
      : undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ].filter((rule): rule is string => rule !== undefined)

  return {
    ...(compacted?.text ? { requestText: compacted.text } : {}),
    ...(rules.length
      ? {
          system: [
            "OpenCode optimization profile enabled. Preserve correctness over speed and never use the rejected aggressive test-skipping behavior.",
            ...rules.map((rule) => `- ${rule}`),
          ].join("\n"),
        }
      : {}),
    compactedVerifierContext: compacted?.compacted ?? false,
  }
}

export function compactVerifierContext(text: string) {
  if (text.length < MIN_LOG_COMPRESSION_CHARS || !TEST_LOG_HINT.test(text) || !LOG_KEYWORDS.test(text)) {
    return { text: undefined, compacted: false }
  }

  const lines = text.split(/\r?\n/)
  const keep = new Set(Array.from({ length: Math.min(40, lines.length) }, (_, index) => index))
  for (let index = Math.max(0, lines.length - 80); index < lines.length; index++) keep.add(index)

  let traceback = false
  lines.forEach((line, index) => {
    const relevant = LOG_KEYWORDS.test(line) || PATH_WITH_LINE.test(line) || TEST_LOG_HINT.test(line)
    if (line.startsWith("Traceback (most recent call last):")) traceback = true
    if (relevant || traceback) {
      for (let keepIndex = Math.max(0, index - 3); keepIndex < Math.min(lines.length, index + 4); keepIndex++) {
        keep.add(keepIndex)
      }
    }
    if (isPromptInstructionLine(line)) {
      for (let keepIndex = Math.max(0, index - 1); keepIndex < Math.min(lines.length, index + 2); keepIndex++) {
        keep.add(keepIndex)
      }
    }
    if (traceback && /^[A-Za-z_][\w.]*Error:/.test(line.trim())) traceback = false
  })

  const collapsed: string[] = []
  let previous = -1
  let previousBlank = false
  for (const index of Array.from(keep).sort((a, b) => a - b)) {
    if (index !== previous + 1 && collapsed.at(-1) !== "...") collapsed.push("...")
    const line = lines[index] ?? ""
    const blank = line.trim() === ""
    if (!(blank && previousBlank)) collapsed.push(line)
    previousBlank = blank
    previous = index
  }

  const compressed = collapsed.join("\n")
  if (compressed.length >= text.length * 0.85) return { text: undefined, compacted: false }

  return {
    text: [
      "The original prompt included long test/verifier output. It was compacted to preserve diagnostic lines while reducing context.",
      "Non-log instruction lines detected outside the noisy output were preserved.",
      "",
      compressed,
      "",
      `[compressed ${lines.length} lines to ${collapsed.length} lines]`,
    ].join("\n"),
    compacted: true,
  }
}

function isPromptInstructionLine(line: string) {
  const text = line.trim()
  if (text.length < 12) return false
  if (LOG_PREFIX.test(text) || LOG_KEYWORDS.test(text) || PATH_WITH_LINE.test(text) || TEST_LOG_HINT.test(text)) return false
  if (/^(?:node:|npm |bun |pnpm |yarn |\{|\}|\[|\]|\(|\)|\.\.\.|[-+*]\s+at\s+)/i.test(text)) return false
  return /[A-Za-zÄÖÜäöüß]{3}/.test(text)
}
