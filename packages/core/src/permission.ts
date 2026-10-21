export * as PermissionV2 from "./permission"

import {
  Context,
  Deferred,
  Effect as EffectRuntime,
  Layer,
  Schema,
} from "effect"
import { createHash } from "node:crypto"
import { EventV2 } from "./event"
import { Location } from "./location"
import { AgentV2 } from "./agent"
import { Config } from "./config"
import { ConfigAccessControl } from "./config/access-control"
import { SessionV2 } from "./session"
import { SessionMessage } from "./session/message"
import { SessionStore } from "./session/store"
import { withStatics } from "./schema"
import { Identifier } from "./util/identifier"
import { Wildcard } from "./util/wildcard"
import { PermissionSchema } from "./permission/schema"
import { PermissionSaved } from "./permission/saved"
import { PermissionSafetyReview } from "./permission/safety-review"
import { PermissionSafetyReviewIntent } from "./permission/safety-review-intent"
import { Database } from "./database/database"
import { SessionDispatchOrigin } from "./session/dispatch-origin"
import { SessionHistory } from "./session/history"

export { Effect, Rule, Ruleset } from "./permission/schema"
type Effect = PermissionSchema.Effect
type Rule = PermissionSchema.Rule
type Ruleset = PermissionSchema.Ruleset
const missingAgentPermissions: Ruleset = [{ action: "*", resource: "*", effect: "deny" }]
const ACCESS_CONTROL_METADATA_KEY = "access_control"
export const SINGLE_USE_METADATA_KEY = "$opencode.permission.single_use"

export const ID = Schema.String.check(Schema.isStartsWith("per")).pipe(
  Schema.brand("PermissionV2.ID"),
  withStatics((schema) => ({ create: (id?: string) => schema.make(id ?? "per_" + Identifier.ascending()) })),
)
export type ID = typeof ID.Type

export const Source = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("tool"),
    messageID: Schema.String,
    callID: Schema.String,
  }),
]).annotate({ identifier: "PermissionV2.Source" })
export type Source = typeof Source.Type

const RequestFields = {
  sessionID: SessionV2.ID,
  action: Schema.String,
  resources: Schema.Array(Schema.String),
  save: Schema.Array(Schema.String).pipe(Schema.optional),
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
  source: Source.pipe(Schema.optional),
}

export const Request = Schema.Struct({
  id: ID,
  ...RequestFields,
}).annotate({ identifier: "PermissionV2.Request" })
export type Request = typeof Request.Type

export const Reply = Schema.Literals(["once", "always", "reject"]).annotate({ identifier: "PermissionV2.Reply" })
export type Reply = typeof Reply.Type

export const AssertInput = Schema.Struct({
  id: ID.pipe(Schema.optional),
  ...RequestFields,
  agent: AgentV2.ID.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.AssertInput" })
export type AssertInput = typeof AssertInput.Type

export function singleUse(input: AssertInput): AssertInput {
  return {
    ...input,
    save: undefined,
    metadata: { ...input.metadata, [SINGLE_USE_METADATA_KEY]: true },
  }
}

export const ReplyInput = Schema.Struct({
  requestID: ID,
  reply: Reply,
  message: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.ReplyInput" })
export type ReplyInput = typeof ReplyInput.Type

export const AskResult = Schema.Struct({
  id: ID,
  effect: PermissionSchema.Effect,
}).annotate({ identifier: "PermissionV2.AskResult" })
export type AskResult = typeof AskResult.Type

export const Event = {
  Asked: EventV2.define({ type: "permission.v2.asked", schema: Request.fields }),
  Replied: EventV2.define({
    type: "permission.v2.replied",
    schema: {
      sessionID: SessionV2.ID,
      requestID: ID,
      reply: Reply,
    },
  }),
}

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionV2.RejectedError", {}) {}

export class DeclinedError extends Schema.TaggedErrorClass<DeclinedError>()("PermissionV2.DeclinedError", {}) {}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionV2.CorrectedError", {
  feedback: Schema.String,
}) {}

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionV2.DeniedError", {
  rules: PermissionSchema.Ruleset,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("PermissionV2.NotFoundError", {
  requestID: ID,
}) {}

export type Error = DeniedError | RejectedError | DeclinedError | CorrectedError

export function evaluate(action: string, resource: string, ...rulesets: Ruleset[]): Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

export function merge(...rulesets: Ruleset[]): Ruleset {
  return rulesets.flat()
}

export interface Interface {
  readonly ask: (input: AssertInput) => EffectRuntime.Effect<AskResult, SessionV2.NotFoundError>
  readonly assert: (input: AssertInput) => EffectRuntime.Effect<void, Error | SessionV2.NotFoundError>
  readonly reply: (input: ReplyInput) => EffectRuntime.Effect<void, NotFoundError | RejectedError>
  readonly materializationRules: (input: {
    sessionID: SessionV2.ID
    agent?: AgentV2.ID
  }) => EffectRuntime.Effect<Ruleset, SessionV2.NotFoundError>
  readonly get: (id: ID) => EffectRuntime.Effect<Request | undefined>
  readonly forSession: (sessionID: SessionV2.ID) => EffectRuntime.Effect<ReadonlyArray<Request>>
  readonly list: () => EffectRuntime.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Permission") {}

interface Pending {
  readonly request: Request
  readonly agent?: AgentV2.ID
  readonly deferred: Deferred.Deferred<void, DeclinedError | CorrectedError>
}

export const layer = Layer.effect(
  Service,
  EffectRuntime.gen(function* () {
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const agents = yield* AgentV2.Service
    const config = yield* EffectRuntime.serviceOption(Config.Service)
    const sessions = yield* SessionStore.Service
    const { db } = yield* Database.Service
    const saved = yield* PermissionSaved.Service
    const safety = yield* EffectRuntime.serviceOption(PermissionSafetyReview.Service)
    const pending = new Map<ID, Pending>()
    const pendingReviews = new Map<string, Deferred.Deferred<PermissionSafetyReview.Result | undefined>>()
    // Keep approval and rejection decisions scoped to the concrete tool input,
    // so a narrow edit to the same file can be reviewed after a broad edit was rejected.
    const reviewCache = new Map<string, boolean>()
    const rejectedSafetyRequests = new Map<string, string>()
    const serviceScope = yield* EffectRuntime.scope

    const isRestrictedConversation = (
      sessionID: SessionV2.ID,
      seen: ReadonlySet<SessionV2.ID> = new Set(),
    ): EffectRuntime.Effect<boolean> =>
      EffectRuntime.gen(function* () {
        // Walk the full ancestry. Cycle detection is the only guard needed;
        // nested review/proposal workflows must not stop at a host depth cap.
        if (seen.has(sessionID)) return false
        const session = yield* sessions.get(sessionID)
        if (!session) return false
        if (yield* SessionDispatchOrigin.sourceRestricted(db, sessionID)) return true
        if (!session.parentID) return false
        return yield* isRestrictedConversation(session.parentID, new Set(seen).add(sessionID))
      })

    const scopeInput = EffectRuntime.fnUntraced(function* (input: AssertInput) {
      if (yield* isRestrictedConversation(input.sessionID)) return singleUse(input)
      if (input.source && (yield* SessionDispatchOrigin.contains(db, input.sessionID, input.source.messageID)))
        return singleUse(input)
      return input
    })

    yield* EffectRuntime.addFinalizer(() =>
      EffectRuntime.forEach(pending.values(), (item) => Deferred.fail(item.deferred, new DeclinedError()), {
        discard: true,
      }).pipe(
        EffectRuntime.andThen(
          EffectRuntime.forEach(pendingReviews.values(), (deferred) => Deferred.succeed(deferred, undefined), {
            discard: true,
          }),
        ),
        EffectRuntime.ensuring(
          EffectRuntime.sync(() => {
            pending.clear()
            reviewCache.clear()
            pendingReviews.clear()
          }),
        ),
      ),
    )

    const savedRules = EffectRuntime.fnUntraced(function* () {
      return (yield* saved.list({ projectID: location.project.id })).map((item): Rule => ({
        action: item.action,
        resource: item.resource,
        effect: "allow",
      }))
    })

    const configured = EffectRuntime.fn("PermissionV2.configured")(function* (
      sessionID: SessionV2.ID,
      agentID?: AgentV2.ID,
    ) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionV2.NotFoundError({ sessionID })
      const agent = yield* agents.resolve(agentID ?? session.agent)
      return agent?.permissions ?? missingAgentPermissions
    })

    const inherited = EffectRuntime.fn("PermissionV2.inherited")(function* (sessionID: SessionV2.ID) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionV2.NotFoundError({ sessionID })
      return session.agentPolicy?.permissionLayers ?? []
    })

    const accessControl = EffectRuntime.fn("PermissionV2.accessControl")(function* (sessionID: SessionV2.ID) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionV2.NotFoundError({ sessionID })
      const entries = config._tag === "Some" ? yield* config.value.entries() : undefined
      const configured = entries
        ?.filter((entry): entry is Config.Document => entry.type === "document")
        .map((entry) => ConfigAccessControl.fromUnknown(entry.info.access_control))
        .findLast((entry) => entry !== undefined)
      const scoped =
        ConfigAccessControl.fromUnknown(session.metadata?.[ACCESS_CONTROL_METADATA_KEY]) ??
        configured ??
        ConfigAccessControl.DEFAULT_INFO
      const safetyReview = entries
        ? (Config.globalLatest(entries, "access_control")?.safety_review ??
          ConfigAccessControl.DEFAULT_INFO.safety_review)
        : ConfigAccessControl.DEFAULT_INFO.safety_review
      return { mode: scoped.mode, safety_review: safetyReview }
    })

    function denied(input: AssertInput, rules: Ruleset) {
      return input.resources.some((resource) => evaluate(input.action, resource, rules).effect === "deny")
    }

    function relevant(input: AssertInput, rules: Ruleset) {
      return rules.filter((rule) => Wildcard.match(input.action, rule.action))
    }

    const toolCall = EffectRuntime.fnUntraced(function* (input: AssertInput) {
      if (input.source?.type !== "tool") return
      const item = yield* sessions.message(SessionMessage.ID.make(input.source.messageID)).pipe(EffectRuntime.option)
      if (item._tag === "None") return
      const value = item.value
      if (!value || value.message.type !== "assistant") return
      const part = value.message.content.find((part) => part.type === "tool" && part.id === input.source?.callID)
      if (!part || part.type !== "tool") return
      return {
        name: part.name,
        callID: input.source.callID,
        input: part.state.input,
      }
    })

    const intent = EffectRuntime.fnUntraced(function* (input: AssertInput) {
      const history = yield* SessionHistory.loadForPermission(
        db,
        input.sessionID,
        input.source ? SessionMessage.ID.make(input.source.messageID) : undefined,
        PermissionSafetyReviewIntent.MAX_RECENT_MESSAGES,
      )
      if (!history) return
      const session = yield* sessions.get(input.sessionID)
      return PermissionSafetyReviewIntent.build({
        messages: history.flatMap(intentMessage),
        anchorBeforeMessageID: input.source?.messageID,
        plan: PermissionSafetyReviewIntent.planFromMetadata(session?.metadata),
      })
    })

    const review = EffectRuntime.fnUntraced(function* (input: AssertInput, profile: ConfigAccessControl.Info) {
      if (safety._tag === "None") return
      const currentIntent = yield* intent(input).pipe(EffectRuntime.catch(() => EffectRuntime.succeed(undefined)))
      if (!currentIntent) {
        yield* EffectRuntime.logWarning("permission safety review intent unavailable", {
          sessionID: input.sessionID,
          action: input.action,
          source: input.source,
        })
        return
      }
      const tool = yield* toolCall(input)
      const result = yield* safety.value.review({
        safety: profile.safety_review,
        sessionID: input.sessionID,
        workspace: {
          directory: location.directory,
          workspaceID: location.workspaceID,
        },
        action: input.action,
        resources: input.resources,
        metadata: input.metadata,
        source: input.source,
        intent: currentIntent,
        tool,
      })
      return result.approved ? result : {
        ...result,
        context: PermissionSafetyReviewIntent.explain(currentIntent, tool),
        scopeKey: reviewCacheKey(input.sessionID, input.action, input.resources, tool?.input),
      }
    })

    const reviewInFlight = (input: AssertInput, profile: ConfigAccessControl.Info, cacheKey: string) =>
      EffectRuntime.uninterruptibleMask((restore) =>
        EffectRuntime.gen(function* () {
          const existing = pendingReviews.get(cacheKey)
          if (existing) return yield* restore(Deferred.await(existing))
          const deferred = Deferred.makeUnsafe<PermissionSafetyReview.Result | undefined>()
          pendingReviews.set(cacheKey, deferred)
          const complete = (result: PermissionSafetyReview.Result | undefined) =>
            EffectRuntime.gen(function* () {
              yield* EffectRuntime.sync(() => {
                if (pendingReviews.get(cacheKey) !== deferred) return
                if (result?.approved) reviewCache.set(cacheKey, true)
                pendingReviews.delete(cacheKey)
              })
              yield* Deferred.succeed(deferred, result)
            })
          const run = restore(
            review(input, profile).pipe(EffectRuntime.catchCause(() => EffectRuntime.succeed(undefined))),
          ).pipe(
            EffectRuntime.flatMap(complete),
            EffectRuntime.ensuring(complete(undefined)),
          )
          // Keep the shared review independent of a caller's interruption while
          // still tying it to the permission service lifetime. A global detached
          // fiber could outlive the services captured by the review.
          yield* run.pipe(EffectRuntime.forkIn(serviceScope), EffectRuntime.asVoid)
          return yield* restore(Deferred.await(deferred))
        }),
      )

    const evaluateInput = EffectRuntime.fnUntraced(function* (input: AssertInput) {
      const profile = yield* accessControl(input.sessionID)
      const rules = yield* configured(input.sessionID, input.agent)
      const layers = [rules, ...(yield* inherited(input.sessionID))]
      const allRules = layers.flat()
      if (layers.some((layer) => denied(input, layer))) return { effect: "deny" as const, rules: allRules }
      const cacheKey = (profile.mode === "approve_for_me" && safety._tag === "Some") || rejectedSafetyRequests.size
        ? reviewCacheKey(input.sessionID, input.action, input.resources, (yield* toolCall(input))?.input)
        : undefined
      if (cacheKey && rejectedSafetyRequests.has(cacheKey)) return { effect: "deny" as const, rules: allRules }
      // Voice delegation requires an actual host click, never remembered or model-reviewed consent.
      if (input.metadata?.[SINGLE_USE_METADATA_KEY] === true) return { effect: "ask" as const, rules: allRules }
      // Full access removes confirmation prompts; it must never widen an
      // agent's own or inherited deny policy or make hidden tools executable.
      if (profile.mode === "full_access") return { effect: "allow" as const, rules: allRules }
      const remembered = yield* savedRules()
      const all = layers.flatMap((layer) => [...layer, ...remembered])
      const effects = layers.flatMap((layer) =>
        input.resources.map((resource) => evaluate(input.action, resource, layer, remembered).effect),
      )
      const effect: Effect = effects.includes("deny") ? "deny" : effects.includes("ask") ? "ask" : "allow"
      if (effect === "ask" && profile.mode === "approve_for_me" && safety._tag === "Some") {
        const key = cacheKey ?? reviewCacheKey(input.sessionID, input.action, input.resources, (yield* toolCall(input))?.input)
        const cached = reviewCache.get(key)
        if (cached === true) {
          yield* EffectRuntime.logInfo("permission auto-approved by cached safety review", {
            path: "core_v2",
            sessionID: input.sessionID,
            requestID: input.id,
            action: input.action,
            resources: [...input.resources],
            source: input.source,
          })
          return { effect: "allow" as const, rules: all }
        }
        // Cache only stores positive results. Transient model failures and
        // genuine "unsafe" verdicts are never cached so the next identical
        // call retries the model instead of prompting permanently.
        const reviewed = yield* reviewInFlight(input, profile, key)
        if (reviewed) {
          yield* EffectRuntime.logInfo("permission safety review completed", {
            sessionID: input.sessionID,
            requestID: input.id,
            action: input.action,
            resources: [...input.resources],
            cause: reviewed.cause,
            risk: reviewed.risk,
            attempts: reviewed.attempts,
          })
        }
        if (reviewed?.approved) {
          yield* EffectRuntime.logInfo("permission auto-approved by safety review", {
            path: "core_v2",
            sessionID: input.sessionID,
            requestID: input.id,
            action: input.action,
            resources: [...input.resources],
            source: input.source,
          })
          // Persist the approval as an always-allow rule so the same
          // action+resource is not re-reviewed in later sessions.
          if ((profile.safety_review?.auto_save ?? true) && reviewed.cause !== "fallback_safe" && input.save?.length) {
            yield* saved.add({
              projectID: location.project.id,
              action: input.action,
              resources: input.save,
            })
          }
          return { effect: "allow" as const, rules: all }
        }
        if (reviewed) {
          const feedback = PermissionSafetyReview.redirectFeedback(reviewed)
          if (feedback) {
            rejectedSafetyRequests.set(key, feedback)
            return { effect: "deny" as const, rules: all }
          }
          return { effect, rules: all, review: reviewed }
        }
      }
      return { effect, rules: all }
    })

    const materializationRules = EffectRuntime.fn("PermissionV2.materializationRules")(function* (input: {
      sessionID: SessionV2.ID
      agent?: AgentV2.ID
    }) {
      return yield* configured(input.sessionID, input.agent)
    })

    function request(input: AssertInput, review?: PermissionSafetyReview.Result): Request {
      return {
        id: input.id ?? ID.create(),
        sessionID: input.sessionID,
        action: input.action,
        resources: input.resources,
        save: input.save,
        metadata: review ? { ...input.metadata, "$opencode.permission.safety_review": review } : input.metadata,
        source: input.source,
      }
    }

    const matching = (request: Pick<Request, "sessionID" | "action" | "resources">) =>
      Array.from(pending.values()).find(
        (item) =>
          item.request.sessionID === request.sessionID &&
          item.request.action === request.action &&
          JSON.stringify(item.request.resources) === JSON.stringify(request.resources),
      )

    const create = (request: Request, agent?: AgentV2.ID) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          const duplicate = matching(request)
          if (duplicate) return duplicate
          const deferred = yield* Deferred.make<void, DeclinedError | CorrectedError>()
          const item = { request, agent, deferred }
          if (pending.has(request.id)) return yield* EffectRuntime.die(`Duplicate pending permission ID: ${request.id}`)
          pending.set(request.id, item)
          yield* EffectRuntime.logWarning("permission prompt created", {
            sessionID: request.sessionID,
            requestID: request.id,
            action: request.action,
            resources: [...request.resources],
            review: request.metadata?.["$opencode.permission.safety_review"],
          })
          yield* events
            .publish(Event.Asked, request)
            .pipe(EffectRuntime.onError(() => EffectRuntime.sync(() => pending.delete(request.id))))
          return item
        }),
      )

    const ask = EffectRuntime.fn("PermissionV2.ask")(function* (input: AssertInput) {
      const scoped = yield* scopeInput(input)
      const value = request(scoped)
      const result = yield* evaluateInput({ ...scoped, id: value.id })
      const reviewed = result.review ? request({ ...scoped, id: value.id }, result.review) : value
      if (result.effect === "ask") {
        const item = yield* create(reviewed, input.agent)
        return { id: item.request.id, effect: result.effect }
      }
      return { id: reviewed.id, effect: result.effect }
    })

    const assert = EffectRuntime.fn("PermissionV2.assert")((input: AssertInput) =>
      EffectRuntime.uninterruptibleMask((restore) =>
        EffectRuntime.gen(function* () {
          const scoped = yield* scopeInput(input)
          const value = request(scoped)
          const result = yield* evaluateInput({ ...scoped, id: value.id })
          if (result.effect === "deny") {
            const feedback = rejectedSafetyRequests.get(reviewCacheKey(scoped.sessionID, scoped.action, scoped.resources, (yield* toolCall(scoped))?.input))
            if (feedback) return yield* new CorrectedError({ feedback })
            return yield* new DeniedError({
              rules: relevant(scoped, result.rules),
            })
          }
          if (result.effect === "allow") return
          const item = yield* create(
            result.review ? request({ ...scoped, id: value.id }, result.review) : value,
            scoped.agent,
          )
          return yield* restore(Deferred.await(item.deferred)).pipe(
            EffectRuntime.onInterrupt(() =>
              pending.has(item.request.id)
                ? events.publish(Event.Replied, {
                    sessionID: item.request.sessionID,
                    requestID: item.request.id,
                    reply: "reject",
                  })
                : EffectRuntime.void,
            ),
            EffectRuntime.catchTag("PermissionV2.DeclinedError", (error) => EffectRuntime.die(error)),
            EffectRuntime.ensuring(
              EffectRuntime.sync(() => {
                pending.delete(item.request.id)
              }),
            ),
          )
        }),
      ),
    )

    const reply = EffectRuntime.fn("PermissionV2.reply")((input: ReplyInput) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
          if (existing.request.metadata?.[SINGLE_USE_METADATA_KEY] === true && input.reply === "always")
            return yield* new RejectedError()
          yield* events.publish(Event.Replied, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
            reply: input.reply,
          })

          if (input.reply === "reject") {
            const safetyReview = existing.request.metadata?.["$opencode.permission.safety_review"] as PermissionSafetyReview.Result | undefined
            const safetyRejected = safetyReview !== undefined
            const feedback = safetyRejected
              ? `The user declined this safety prompt. ${input.message ? `User feedback: ${input.message}. ` : ""}Do not repeat or rephrase the denied action to bypass the decision. Continue only with a genuinely different, authorized approach; otherwise explain the blocker.`
              : input.message ?? ""
            if (safetyRejected)
              rejectedSafetyRequests.set(
                safetyReview?.scopeKey ?? reviewCacheKey(existing.request.sessionID, existing.request.action, existing.request.resources),
                feedback,
              )
            yield* Deferred.fail(
              existing.deferred,
              safetyRejected || input.message ? new CorrectedError({ feedback }) : new DeclinedError(),
            )
            pending.delete(input.requestID)
            for (const [id, item] of pending) {
              if (item.request.sessionID !== existing.request.sessionID) continue
              yield* events.publish(Event.Replied, {
                sessionID: item.request.sessionID,
                requestID: item.request.id,
                reply: "reject",
              })
              yield* Deferred.fail(item.deferred, safetyRejected ? new CorrectedError({ feedback: "A concurrent permission request was cancelled after the user declined a safety prompt. Do not retry it automatically." }) : new DeclinedError())
              pending.delete(id)
            }
            return
          }

          if (input.reply === "always" && existing.request.save?.length) {
            yield* saved.add({
              projectID: location.project.id,
              action: existing.request.action,
              resources: existing.request.save,
            })
          }
          yield* Deferred.succeed(existing.deferred, undefined)
          pending.delete(input.requestID)
          if (input.reply !== "always" || !existing.request.save?.length) return

          const rememberedRules = yield* savedRules()
          for (const [id, item] of pending) {
            if (item.request.sessionID !== existing.request.sessionID) continue
            const input = { ...item.request }
            if (input.metadata?.[SINGLE_USE_METADATA_KEY] === true) continue
            const rules = yield* configured(item.request.sessionID, item.agent).pipe(
              EffectRuntime.catchTag("Session.NotFoundError", () => EffectRuntime.succeed(undefined)),
            )
            if (!rules) continue
            if (denied(input, rules)) continue
            const effective = [...rules, ...rememberedRules]
            if (
              !item.request.resources.every(
                (resource) => evaluate(item.request.action, resource, effective).effect === "allow",
              )
            )
              continue
            yield* events.publish(Event.Replied, {
              sessionID: item.request.sessionID,
              requestID: item.request.id,
              reply: "always",
            })
            yield* Deferred.succeed(item.deferred, undefined)
            pending.delete(id)
          }
        }),
      ),
    )

    const list = EffectRuntime.fn("PermissionV2.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    const get = EffectRuntime.fn("PermissionV2.get")(function* (id: ID) {
      return pending.get(id)?.request
    })

    const forSession = EffectRuntime.fn("PermissionV2.forSession")(function* (sessionID: SessionV2.ID) {
      return Array.from(pending.values(), (item) => item.request).filter((request) => request.sessionID === sessionID)
    })

    return Service.of({ ask, assert, reply, materializationRules, get, forSession, list })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(AgentV2.locationLayer))

export function reviewCacheKey(sessionID: string, action: string, resources: readonly string[], toolInput?: unknown) {
  return `${sessionID}\0${action}\0${[...resources].sort().join("\0")}\0${toolInput === undefined ? "" : createHash("sha256").update(JSON.stringify(toolInput)).digest("hex")}`
}

export function intentMessage(message: SessionMessage.Message): PermissionSafetyReviewIntent.Message[] {
  if (message.type === "user")
    return [
      {
        role: "user",
        messageID: message.id,
        text: message.text,
        attachments: message.files?.map((file) => ({
          name: file.name,
          mime: file.mime,
          reference: file.uri,
          description: file.description,
        })),
      },
    ]
  if (message.type !== "assistant") return []
  const text = message.content
    .filter((part): part is SessionMessage.AssistantText => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
  return [{ role: "assistant", messageID: message.id, text }]
}
