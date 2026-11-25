export * as ConfigMultiAgent from "./multi-agent"

import { Schema } from "effect"

export class Reviewer extends Schema.Class<Reviewer>("ConfigV2.MultiAgent.Reviewer")({
  model: Schema.String.annotate({ description: "Model to run for this reviewer in provider/model format." }),
  variant: Schema.String.pipe(Schema.optional).annotate({
    description: "Optional model variant or thinking amount for this reviewer.",
  }),
}) {}

export class Skill extends Schema.Class<Skill>("ConfigV2.MultiAgent.Skill")({
  reviewers: Schema.Array(Reviewer).pipe(Schema.optional).annotate({
    description: "Ordered reviewer models for this multi-agent skill.",
  }),
  result_recovery: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Allow review-only salvage and one format repair (default true). Set false to retain strict results.",
  }),
}) {}

export const Info = Schema.StructWithRest(Schema.Struct({
  unlimited: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Disable host-imposed multi-agent concurrency and nesting limits for all registered workflows.",
  }),
  max_threads: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))
    .pipe(Schema.optional)
    .annotate({ description: "Optional maximum concurrently running background subagent tasks per root Session." }),
  max_depth: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))
    .pipe(Schema.optional)
    .annotate({ description: "Optional maximum recursive subagent depth below a root Session." }),
}), [Schema.Record(Schema.String, Schema.Union([Skill, Schema.Number, Schema.Boolean, Schema.Undefined]))]).check(
  Schema.makeFilter((value) => Object.entries(value).every(([key, entry]) =>
    key === "unlimited" || key === "max_threads" || key === "max_depth" || (typeof entry === "object" && entry !== null),
  ) || "Workflow configuration must be an object"),
)
export type Info = typeof Info.Type

export type ReviewerInfo = typeof Reviewer.Type

export type SkillKey = string

export type ResolvedReviewerSource = "user override" | "active config" | "injected snapshot"

export type ResolveReviewerInput = {
  skillKey: SkillKey
  active?: Info | undefined
  requestedReviewers?: readonly ReviewerInfo[] | undefined
  injectedReviewers?: readonly ReviewerInfo[] | undefined
}

export type ResolveReviewerResult =
  | {
      ok: true
      reviewers: readonly ReviewerInfo[]
      /**
       * Reviewers proven persisted in Settings for this skill. Only these
       * entries may extend subagent model policy; requested and injected
       * reviewers are model input and never appear here.
       */
      configuredReviewers: readonly ReviewerInfo[]
      source: ResolvedReviewerSource
      configuredPath: `multi_agent.${string}.reviewers`
      changedFromInjected: boolean
    }
  | {
      ok: false
      reason: string
      configuredPath: `multi_agent.${string}.reviewers`
    }

export function resolveReviewers(input: ResolveReviewerInput): ResolveReviewerResult {
  const configuredPath = `multi_agent.${input.skillKey}.reviewers` as const
  const active = input.active?.[input.skillKey]
  const activeReviewers = typeof active === "object" ? active.reviewers : undefined
  const configuredReviewers = validReviewers(activeReviewers) ?? []

  // Tool providers may materialize omitted optional arrays as []. An empty
  // override has no reviewer choice; malformed nonempty entries still fail.
  if (input.requestedReviewers?.length)
    return resolveSource(
      input.requestedReviewers,
      "user override",
      configuredPath,
      input.injectedReviewers,
      configuredReviewers,
    )
  if (activeReviewers !== undefined)
    return resolveSource(activeReviewers, "active config", configuredPath, input.injectedReviewers, configuredReviewers)
  if (input.injectedReviewers?.length)
    return resolveSource(
      input.injectedReviewers,
      "injected snapshot",
      configuredPath,
      input.injectedReviewers,
      configuredReviewers,
    )

  return { ok: false, reason: `No reviewers found for ${configuredPath}`, configuredPath }
}

function resolveSource(
  reviewers: readonly ReviewerInfo[],
  source: ResolvedReviewerSource,
  configuredPath: `multi_agent.${string}.reviewers`,
  injectedReviewers: readonly ReviewerInfo[] | undefined,
  configuredReviewers: readonly ReviewerInfo[],
): ResolveReviewerResult {
  const valid = validReviewers(reviewers)
  if (!valid) return { ok: false, reason: `No valid ${source} reviewers found for ${configuredPath}`, configuredPath }

  return {
    ok: true,
    reviewers: valid,
    configuredReviewers,
    source,
    configuredPath,
    changedFromInjected: !!injectedReviewers?.length && !sameReviewers(valid, injectedReviewers),
  }
}

function validReviewers(reviewers: readonly ReviewerInfo[] | undefined) {
  if (!reviewers?.length) return
  if (!reviewers.every((reviewer) => typeof reviewer.model === "string" && reviewer.model.trim().length > 0)) return
  return reviewers
}

function sameReviewers(left: readonly ReviewerInfo[], right: readonly ReviewerInfo[] | undefined) {
  if (!right || left.length !== right.length) return false
  return left.every((reviewer, index) => reviewer.model === right[index]?.model && reviewer.variant === right[index]?.variant)
}
