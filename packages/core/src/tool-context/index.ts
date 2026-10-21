export * as ToolContext from "./index"

import { compressDiff } from "./diff"
import { compressJson } from "./json"
import { compressLog } from "./logs"
import { compressSearch } from "./search"
import type { Compressed, Hint, Omission, Processor } from "./types"

export { ViewCache, cacheKey } from "./cache"
export type { Compressed, Hint, Omission, Processor } from "./types"

export const MIN_ANALYZE_BYTES = 8 * 1024
export const TARGET_VIEW_BYTES = 12 * 1024
export const MIN_GAIN_RATIO = 0.15

export type ContextView = {
  readonly processor: Processor
  readonly version: 1
  readonly original: { readonly ref: string; readonly sha256: string; readonly bytes: number; readonly complete: boolean }
  readonly omissions: ReadonlyArray<Omission>
  readonly estimates: { readonly originalBytes: number; readonly viewBytes: number }
}

export type SummarizeInput = {
  readonly tool: string
  readonly text: string
  readonly hint?: Hint
}

export type SummarizeResult = {
  readonly text: string
  readonly view: Omit<ContextView, "original"> | undefined
}

/** Trusted builtin tool provenance; everything else must pass conservative generic detection or stay exact. */
export const HINTS: Record<string, Hint> = { bash: "log", grep: "search", glob: "search" }

/** Tools whose model output must reach the model exactly: control surfaces, source evidence, media and protocol outputs. */
export const EXCLUDED_TOOLS = new Set([  "surface",
  "question",
  "skill",
  "switch_agent",
  "attach",
  "task",
  "spawn_agent",
  "multi_agent_fanout",
  "daily_review_implementation",
  "scheduled_job_result",
  "read",
  "edit",
  "write",
  "apply_patch",
  "webfetch",
  "websearch",
  "todowrite",
  "image_generate",
])

/** Structured result types that already are exact raw-retrieval views; they must never be compressed again. */
export const EXCLUDED_STRUCTURED_TYPES = new Set(["artifact-search-page"])

const bytes = (text: string) => Buffer.byteLength(text, "utf8")

type Detector = (sample: ReadonlyArray<string>) => boolean

const detectors: ReadonlyArray<readonly [Processor, Detector]> = [
  [
    "diff",
    (sample) =>
      sample.filter((line) => /^(diff --git |@@ -\d|--- a\/|\+\+\+ b\/)/.test(line)).length >= 3 &&
      sample.some((line) => line.startsWith("+") || line.startsWith("-")),
  ],
  [
    "search",
    (sample) => {
      const matching = sample.filter((line) => /^(?:[A-Za-z]:[^:]+|[^:]+):\d+[:-]/.test(line)).length
      return sample.length > 0 && matching / sample.length > 0.5
    },
  ],
  [
    "logs",
    (sample) => {
      const scored = sample.filter(
        (line) =>
          /\b(error|fatal|failed|fail|warn(?:ing)?)\b/i.test(line) ||
          /^\[?\d{4}-\d{2}-\d{2}/.test(line) ||
          /^\d{1,2}:\d{2}:\d{2}/.test(line),
      ).length
      return sample.length > 0 && scored / sample.length > 0.15
    },
  ],
]

const detect = (text: string): Compressed | undefined => {
  const sample = text.split(/\r?\n/).slice(0, 200)
  for (const [processor, matches] of detectors) {
    if (!matches(sample)) continue
    if (processor === "diff") return compressDiff(text)
    if (processor === "search") return compressSearch(text)
    return compressLog(text)
  }
  return compressJson(text)
}

const transform = (hint: Hint | undefined, text: string): Compressed | undefined => {
  if (hint === "log") return compressLog(text)
  if (hint === "search") return compressSearch(text)
  if (hint === "diff") return compressDiff(text)
  if (hint === "json") return compressJson(text)
  return detect(text)
}

/** Pure deterministic entry point: no-gain candidates fall back to the exact original with zero claimed savings. */
export const summarize = (input: SummarizeInput): SummarizeResult => {
  const originalBytes = bytes(input.text)
  if (EXCLUDED_TOOLS.has(input.tool) || originalBytes < MIN_ANALYZE_BYTES)
    return { text: input.text, view: undefined }
  const candidate = transform(input.hint ?? HINTS[input.tool], input.text)
  if (!candidate) return { text: input.text, view: undefined }
  const viewBytes = bytes(candidate.text)
  if (originalBytes - viewBytes < originalBytes * MIN_GAIN_RATIO) return { text: input.text, view: undefined }
  void TARGET_VIEW_BYTES
  return {
    text: candidate.text,
    view: {
      processor: candidate.processor,
      version: 1,
      omissions: candidate.omissions,
      estimates: { originalBytes, viewBytes },
    },
  }
}
