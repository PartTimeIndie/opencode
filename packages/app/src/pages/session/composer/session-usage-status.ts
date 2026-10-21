import type { SessionUsageResponse } from "@opencode-ai/sdk/v2/client"

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })

type RunMetrics = NonNullable<SessionUsageResponse["run"]> & {
  timeUpdated?: number
  measurement?: {
    own: RunMeasurementBlock
    descendants: RunMeasurementBlock
    total: RunMeasurementBlock
  }
  models?: {
    selected: { model: { id: string; providerID: string; variant?: string; chain?: ModelChain | null }; source: "prompt" | "model-switch"; sequence: number }[]
    observed: { model: { id: string; providerID: string; variant?: string; chain?: ModelChain | null }; sequence: number }[]
    complete: boolean
  }
}

type RunMeasurementBlock = {
  complete: boolean
  reportedSteps: number
  unreportedSteps: number
  categories: {
    total: { known?: number; complete: boolean }
  }
}

type ModelChain = {
  id: string
  name: string
  steps: { id: string; providerID: string; variant?: string }[]
  active?: number
}

export type UsageSummary = Omit<SessionUsageResponse, "run"> & { run?: RunMetrics | null }

/** Token total across the disjoint input/output/reasoning/cache categories. */
export const usageTotal = (summary: UsageSummary | undefined) => summary?.session?.total?.total ?? 0

export function formatTokens(value: number) {
  if (!Number.isFinite(value)) return "0"
  return compact.format(value)
}

function segment(parts: { label: string; title: string; own: number; descendants: number; complete: boolean; rate?: string }) {
  const mark = parts.complete ? "" : "~"
  const detail =
    parts.descendants > 0 ? ` (own ${formatTokens(parts.own)} + subagents ${formatTokens(parts.descendants)})` : ""
  const rate = parts.rate ? ` · ${parts.rate}` : ""
  return {
    text: `${parts.label} ${mark}${formatTokens(parts.own + parts.descendants)} tokens${rate}`,
    title: `${parts.title}${detail}${parts.rate ? ` — ${parts.rate} own output+reasoning ÷ own streaming time (tool waits excluded)` : ""}`,
  }
}

// Streaming-time samples below this size produce noisy averages; treat them as unknown.
const MIN_RATE_SAMPLE_MS = 500

/** Average tokens/second over measured provider streaming time, or undefined when unknown. */
export function generationRateText(tokens: number, generationMs: number | undefined) {
  if (generationMs === undefined || !Number.isFinite(generationMs) || generationMs < MIN_RATE_SAMPLE_MS) return undefined
  const rate = tokens / (generationMs / 1000)
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(rate)} tok/s`
}

function measuredRunTotal(run: RunMetrics) {
  const measured = run.measurement?.total.categories.total
  if (measured?.known !== undefined) return { known: measured.known, complete: measured.complete }
  if (measured?.complete) return { known: 0, complete: true }
  if (run.total.total > 0) return { known: run.total.total, complete: false }
}

/** Renders separate run and session token values without turning unknown run data into zero. */
export function usageStatusSegments(summary: UsageSummary | undefined) {
  if (!summary?.session?.total) return []
  const run = summary.run
    ? (() => {
        const measured = measuredRunTotal(summary.run)
        const rate = generationRateText(summary.run.own.output + summary.run.own.reasoning, summary.run.generationMs)
        return {
          text: `Run ${measured ? `${measured.complete ? "" : "~"}${formatTokens(measured.known)}` : "—"}${rate ? ` · ${rate}` : ""}`,
          title: `Run (${summary.run.kind})${rate ? ` — ${rate} own output+reasoning ÷ own provider streaming time (tool waits excluded)` : ""}`,
        }
      })()
    : undefined
  const hasSessionUsage = usageTotal(summary) > 0
  const session = hasSessionUsage
    ? segment({
        label: "Session",
        title: "Session",
        own: summary.session.own?.total ?? 0,
        descendants: summary.session.descendants?.total ?? 0,
        complete: true,
        rate: generationRateText(summary.session.own.output + summary.session.own.reasoning, summary.session.generationMs),
      })
    : undefined
  return [run, session].filter((item): item is { text: string; title: string } => item !== undefined)
}

export function usageStatusText(summary: UsageSummary | undefined) {
  const segments = usageStatusSegments(summary)
  if (segments.length === 0) return undefined
  return segments.map((item) => item.text).join(" · ")
}

export function runDurationMs(summary: UsageSummary | undefined, elapsedSinceSnapshot = 0) {
  const run = summary?.run
  if (!run || !Number.isFinite(run.timeStart)) return undefined
  const end = run.running ? summary.asOf + Math.max(0, elapsedSinceSnapshot) : (run.timeEnd ?? run.timeUpdated)
  if (end === undefined || !Number.isFinite(end)) return undefined
  return Math.max(0, end - run.timeStart)
}

export function isStaleRunningActivity(summary: UsageSummary, activityID: string | undefined, settled: boolean) {
  return settled && summary.run?.running === true && activityID === summary.run.activityID
}

export function formatRunDuration(duration: number | undefined) {
  if (duration === undefined || !Number.isFinite(duration)) return undefined
  const seconds = Math.floor(Math.max(0, duration) / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${remainder}s`
  return `${remainder}s`
}

export function usageStatusTitle(summary: UsageSummary | undefined, elapsedSinceSnapshot = 0, durationOverride?: number | null) {
  if (!summary) return undefined
  const parts = usageStatusSegments(summary).map((item) => `${item.title}: ${item.text}`)
  if (summary.run) {
    const duration = formatRunDuration(
      durationOverride === undefined ? runDurationMs(summary, elapsedSinceSnapshot) : durationOverride ?? undefined,
    )
    if (duration) parts.push(`Run duration: ${duration}`)
    if (!summary.run.complete) parts.push("Subagent attribution for this run is incomplete")
    const selected = summary.run.models?.selected ?? []
    const observed = summary.run.models?.observed ?? []
    const models = [
      ...selected.map(({ model }) => `selected ${formatModel(model)}`),
      ...observed.map(({ model }) => `used ${formatModel(model)}`),
    ]
    if (models.length > 0) parts.push(`Models: ${[...new Set(models)].join(", ")}`)
    const chains = [...new Map(
      [...selected, ...observed]
        .flatMap(({ model }) =>
          model.chain
            ? [[JSON.stringify({
                id: model.chain.id,
                name: model.chain.name,
                steps: model.chain.steps,
                active: model.chain.active,
              }), model.chain] as const]
            : [],
        ),
    ).values()]
    if (chains.length > 0) {
      parts.push(`Chains: ${chains.map((chain) => `${chain.name}: ${chain.steps.map(formatModel).join(" → ")}`).join("; ")}`)
    }
  }
  return parts.join(" · ")
}

function formatModel(model: { id: string; providerID: string; variant?: string }) {
  return `${model.providerID}/${model.id}${model.variant ? ` (${model.variant})` : ""}`
}

/** Footer polling: refresh on change, every 15s while running, and once after settling. */
export const USAGE_POLL_INTERVAL_MS = 15_000

export function shouldPollUsage(summary: UsageSummary | undefined, running: boolean) {
  return running || summary?.run?.running === true
}
