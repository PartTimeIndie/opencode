export * as PermissionSafetyReview from "./safety-review"

import { LLM } from "@opencode-ai/llm"
import { LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { Cause, Context, Effect, Exit, Layer, Option, Schema } from "effect"
import { produce } from "immer"
import { AIChain } from "../ai-chain"
import { Catalog } from "../catalog"
import { ConfigAccessControl } from "../config/access-control"
import { Integration } from "../integration"
import { ModelV2 } from "../model"
import { ModelRequest } from "../model-request"
import { PluginBoot } from "../plugin/boot"
import { PluginV2 } from "../plugin"
import { SessionRunnerModel } from "../session/runner/model"
import { PermissionSafetyReviewIntent } from "./safety-review-intent"
import { ShellCommandAccess } from "./shell-command-access"

const Decision = Schema.Struct({
  decision: Schema.Literals(["safe", "unsafe"]),
  reason: Schema.String,
})
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const decodeDecision = Schema.decodeUnknownOption(Decision)

export type ReviewInput = {
  readonly safety: ConfigAccessControl.SafetyReview | undefined
  readonly sessionID: string
  readonly workspace: { readonly directory: string; readonly workspaceID?: string }
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly metadata?: Record<string, unknown>
  readonly source?: unknown
  readonly intent: PermissionSafetyReviewIntent.Envelope
  readonly tool?: { readonly name: string; readonly callID: string; readonly input: unknown }
}

export type Attempt = {
  readonly role: "primary" | "fallback"
  readonly model?: string
  readonly status: "safe" | "unsafe" | "unavailable" | "transport_error" | "malformed"
  readonly reason?: string
  readonly transient?: boolean
}

export type Result = {
  readonly approved: boolean
  readonly cause: "primary_safe" | "fallback_safe" | "unsafe_consensus" | "risk_conflict" | "reviewers_unavailable"
  readonly risk: "low" | "high"
  readonly attempts: ReadonlyArray<Attempt>
  readonly context?: { readonly goal?: string; readonly action?: string }
  readonly scopeKey?: string
}

export function redirectFeedback(result: Result) {
  if (result.cause !== "unsafe_consensus") return
  const reason = result.attempts.findLast((attempt) => attempt.status === "unsafe" && attempt.reason?.trim())?.reason?.trim()
  if (!reason) return
  return `Safety reviewer did not approve this tool call: ${reason.slice(0, 1000)}. Do not retry the same action or evade this restriction by changing tools or wording. Check the user's goal and try a genuinely narrower authorized approach if possible. If not possible, explain the blocker to the user.`
}

export interface Interface {
  readonly review: (input: ReviewInput) => Effect.Effect<Result>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/PermissionSafetyReview") {}

export const conservativeLayer = Layer.succeed(
  Service,
  Service.of({
    review: () => Effect.succeed({ approved: false, cause: "reviewers_unavailable", risk: "high", attempts: [] }),
  }),
)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    const boot = yield* PluginBoot.Service
    const plugins = Option.getOrUndefined(yield* Effect.serviceOption(PluginV2.Service))
    const llm = yield* LLMClient.Service

    const resolveModel = Effect.fn("PermissionSafetyReview.resolveModel")(function* (
      reviewer: ConfigAccessControl.SafetyReviewer,
    ) {
      if (!reviewer.model) return
      yield* boot.wait()
      const parsed = ModelV2.parse(reviewer.model)
      const selected = yield* catalog.model.get(parsed.providerID, parsed.modelID).pipe(Effect.option)
      if (selected._tag === "None") return
      const variantID = reviewer.variant
      if (variantID && !selected.value.variants.some((item) => item.id === ModelV2.VariantID.make(variantID))) return
      const model = produce(selected.value, (draft) => {
        if (variantID) {
          const variant = draft.variants.find((item) => item.id === ModelV2.VariantID.make(variantID))
          if (variant) ModelRequest.assign(draft.request, variant)
        }
        if (reviewer.generation) ModelRequest.assign(draft.request, { generation: reviewer.generation })
        if (reviewer.options) ModelRequest.assign(draft.request, { options: reviewer.options })
      })
      const connection = yield* integrations.connection.forIntegration(Integration.ID.make(model.providerID))
      return yield* Effect.gen(function* () {
        return yield* SessionRunnerModel.fromCatalogModel(
          model,
          connection,
          connection?.type === "credential" ? yield* integrations.connection.credential(connection.id) : undefined,
          undefined,
          plugins?.nativeModels(),
        )
      }).pipe(Effect.option)
    })

    const attempt = Effect.fn("PermissionSafetyReview.attempt")(function* (
      input: ReviewInput,
      reviewer: ConfigAccessControl.SafetyReviewer,
      role: Attempt["role"],
    ) {
      const model = yield* resolveModel(reviewer)
      if (!model || model._tag === "None") {
        yield* Effect.logWarning("permission safety review model unavailable", reviewLog(input, reviewer.model, role))
        return { role, model: reviewer.model, status: "unavailable" as const, reason: "Model unavailable" }
      }
      const result = yield* LLM.generate(
        LLM.request({
          model: model.value,
          system:
            (input.safety?.prompt ?? ConfigAccessControl.DEFAULT_SAFETY_REVIEW_PROMPT) +
            '\n\nReturn ONLY a raw JSON object with exactly {"decision":"safe"|"unsafe","reason":"..."}. No markdown, no code fences.',
          prompt: JSON.stringify({
            sessionID: input.sessionID,
            workspace: input.workspace,
            permission: { action: input.action, resources: [...input.resources] },
            metadata: input.metadata,
            source: input.source,
            intent: input.intent,
            tool: input.tool,
          }, null, 2),
          generation: ModelRequest.helperGeneration(reviewer.generation),
        }),
      ).pipe(Effect.provideService(LLMClient.Service, llm), Effect.exit)
      if (Exit.isFailure(result)) {
        const error = Cause.squash(result.cause)
        yield* Effect.logWarning("permission safety review failed", {
          ...reviewLog(input, reviewer.model, role),
          error: String(error),
        })
        return {
          role,
          model: reviewer.model,
          status: "transport_error" as const,
          reason: "Provider request failed",
          transient: AIChain.chainStepFailureEligible(error),
        }
      }
      const decoded = decodeDecisionFromText(result.value.text)
      if (!decoded) {
        const empty = result.value.text.trim().length === 0
        yield* Effect.logWarning("permission safety review produced unparseable output", {
          ...reviewLog(input, reviewer.model, role),
          outputLength: result.value.text.length,
        })
        return {
          role,
          model: reviewer.model,
          status: empty ? "transport_error" as const : "malformed" as const,
          reason: empty ? "Reviewer produced no output" : "Invalid reviewer output",
          transient: empty ? true : undefined,
        }
      }
      yield* Effect.logInfo("permission safety review decision", {
        ...reviewLog(input, reviewer.model, role),
        decision: decoded.decision,
        reason: decoded.reason,
      })
      return { role, model: reviewer.model, status: decoded.decision, reason: decoded.reason }
    })

    const attemptPrimary = Effect.fn("PermissionSafetyReview.attemptPrimary")(function* (input: ReviewInput) {
      const safety = input.safety
      if (!safety) return []
      const reviewers: ConfigAccessControl.SafetyReviewer[] = safety.chain?.length
        ? safety.chain.map((step) => ({
            model: `${step.providerID}/${step.modelID}`,
            variant: step.variant,
            generation: safety.generation,
            options: safety.options,
          }))
        : safety.model
          ? [safety]
          : []
      return yield* runReviewerChain(reviewers, (reviewer) => attempt(input, reviewer, "primary"))
    })

    return Service.of({
      review: Effect.fn("PermissionSafetyReview.review")(function* (input) {
        if (!input.safety?.chain?.length && !input.safety?.model)
          return { approved: false, cause: "reviewers_unavailable", risk: "high", attempts: [] }
        const primaryAttempts = yield* attemptPrimary(input)
        const primary = primaryAttempts.at(-1)
        if (!primary) return { approved: false, cause: "reviewers_unavailable", risk: "high", attempts: [] }
        if (primary.status === "safe")
          return { approved: true, cause: "primary_safe", risk: "low", attempts: primaryAttempts }
        const fallback = input.safety.fallback?.model
          ? yield* attempt(input, input.safety.fallback, "fallback")
          : undefined
        const attempts = fallback ? [...primaryAttempts, fallback] : primaryAttempts
        if (fallback?.status === "safe") {
          const risk = primary.status === "unsafe" && !lowRisk(input) ? "high" : "low"
          return { approved: risk === "low", cause: risk === "low" ? "fallback_safe" : "risk_conflict", risk, attempts }
        }
        if (primary.status === "unsafe" || fallback?.status === "unsafe")
          return { approved: false, cause: "unsafe_consensus", risk: "high", attempts }
        return { approved: false, cause: "reviewers_unavailable", risk: "high", attempts }
      }),
    })
  }),
)

// A technical review failure must never end the permission review early:
// transient stages get one bounded retry, every other technical outcome
// (malformed output, non-transient transport errors, unresolvable models)
// advances to the next configured chain stage. Only an explicit reviewer
// decision terminates the chain, so an "unsafe" verdict can never disappear
// behind a transport or parsing problem, and a technical problem can never
// be mistaken for a verdict.
export const MAX_STAGE_ATTEMPTS = 2

export function nextChainAction(attempt: Attempt, stageAttempts: number): "stop" | "retry" | "advance" {
  if (attempt.status === "safe" || attempt.status === "unsafe") return "stop"
  if (stageAttempts >= MAX_STAGE_ATTEMPTS) return "advance"
  return attempt.transient ? "retry" : "advance"
}

export function runReviewerChain(
  reviewers: ReadonlyArray<ConfigAccessControl.SafetyReviewer>,
  run: (reviewer: ConfigAccessControl.SafetyReviewer) => Effect.Effect<Attempt>,
) {
  return Effect.gen(function* () {
    const attempts: Attempt[] = []
    for (const reviewer of reviewers) {
      let stageAttempts = 0
      while (true) {
        const attempt = yield* run(reviewer)
        attempts.push(attempt)
        stageAttempts++
        const action = nextChainAction(attempt, stageAttempts)
        if (action === "stop") return attempts
        if (action === "advance") break
      }
    }
    return attempts
  })
}

// Tolerates only syntax-level wrapping that real providers add around an
// otherwise strict JSON decision: markdown fences, surrounding prose,
// multiple objects, and trailing commas. The decision vocabulary itself stays
// exact - anything that does not decode to {"decision":"safe"|"unsafe",
// "reason":string} stays malformed and the chain advances to the next stage.
export function decodeDecisionFromText(text: string) {
  for (const candidate of decisionCandidates(text)) {
    for (const value of [candidate, stripTrailingCommas(candidate)]) {
      const json = Option.getOrUndefined(decodeJson(value))
      if (json === undefined) continue
      const decoded = Option.getOrUndefined(decodeDecision(json))
      if (decoded !== undefined) return decoded
    }
  }
}

function decisionCandidates(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return []
  const candidates = new Array<string>()
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    const body = match[1]?.trim()
    if (body) candidates.push(body)
  }
  candidates.push(trimmed)
  candidates.push(...balancedObjects(trimmed))
  return candidates
}

// String-aware scan for top-level {...} objects in document order. Providers
// sometimes emit an analysis object before the final decision object; a plain
// first-{ to-last-} slice merges both into invalid JSON. A desynchronized scan
// only ever produces candidates that fail the strict decode above.
function balancedObjects(text: string) {
  const objects = new Array<string>()
  let depth = 0
  let start = -1
  let quoted = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (depth > 0 && char === '"') {
      quoted = true
      continue
    }
    if (char === "{") {
      if (depth === 0) start = index
      depth++
      continue
    }
    if (char === "}" && depth > 0) {
      depth--
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, index + 1))
        start = -1
      }
    }
  }
  return objects
}

// One mechanical normalization: drop commas directly before } or ], outside
// strings. Commas inside string values are never touched.
function stripTrailingCommas(text: string) {
  let out = ""
  let quoted = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      out += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') {
      quoted = true
      out += char
      continue
    }
    if (char === ",") {
      let look = index + 1
      while (look < text.length && /\s/.test(text[look]!)) look++
      if (text[look] === "}" || text[look] === "]") continue
    }
    out += char
  }
  return out
}

function reviewLog(input: ReviewInput, model: string | undefined, role: Attempt["role"]) {
  return {
    model,
    role,
    sessionID: input.sessionID,
    action: input.action,
    resources: [...input.resources],
    tool: input.tool?.name,
    callID: input.tool?.callID,
  }
}

function lowRisk(input: ReviewInput) {
  if (["read", "grep", "glob", "list"].includes(input.action)) return true
  if (input.action !== "bash" || input.resources.length !== 1) return false
  return ShellCommandAccess.isLowRisk(input.resources[0] ?? "")
}

export const defaultLayer = layer.pipe(Layer.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.defaultLayer))))
