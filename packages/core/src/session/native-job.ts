export * as NativeJob from "./native-job"

import { and, eq, isNull } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { realpathSync } from "node:fs"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { Location } from "../location"
import { ProjectV2 } from "../project"
import { AbsolutePath } from "../schema"
import { SessionExecution } from "./execution"
import { SessionExecutionView } from "./execution-view"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"
import { SessionStore } from "./store"

export const METADATA_KEY = "opencode.native_job"
const COMMAND = "native-job"
const PARENT_AGENT = AgentV2.ID.make("build")

/** A caller-bound assignment. The caller owns `binding` and `attempt`; neither
 * is model output, and both decide the durable host Session and input IDs. */
export const Job = Schema.Struct({
  version: Schema.Literal(1),
  binding: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  attempt: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  prompt: Schema.String.check(Schema.isMinLength(1)),
  agent: AgentV2.ID,
})
export type Job = typeof Job.Type
/** Boundary shape: the bridge validates and brands it before anything runs. */
export type JobInput = typeof Job.Encoded

export class Refused extends Schema.TaggedErrorClass<Refused>()("NativeJob.Refused", {
  reason: Schema.Literals(["checkout_unavailable", "binding_mismatch", "invalid_job"]),
  message: Schema.String,
}) {}

export type Binding = { readonly checkout: string; readonly binding: string; readonly attempt: number }

export type Child = {
  readonly sessionID: SessionSchema.ID
  readonly inputID: SessionMessage.ID
  readonly dispatchDigest: string
  readonly placementIdentity: string
}

export type Observation =
  | { readonly state: "missing" }
  | { readonly state: "admitted"; readonly hostSessionID: string; readonly inputID: string }
  | { readonly state: "unsettled"; readonly hostSessionID: string; readonly inputID: string; readonly reason: string }
  | {
      readonly state: "running"
      readonly hostSessionID: string
      readonly inputID: string
      readonly activityID: string
      readonly status: string
      readonly questions: ReadonlyArray<{ readonly id: string; readonly state: string }>
      readonly child?: Child
    }
  | {
      readonly state: "terminal"
      readonly hostSessionID: string
      readonly inputID: string
      readonly activityID: string
      readonly status: "completed" | "failed" | "interrupted"
      readonly child?: Child
      readonly tool:
        | { readonly status: "completed"; readonly report: string }
        | { readonly status: "error"; readonly error: string }
        | undefined
      readonly lastError: string | null
    }

export type Dispatched = Binding & {
  readonly hostSessionID: SessionSchema.ID
  readonly inputID: SessionMessage.ID
  /** False when this call only observed an already recorded input. */
  readonly created: boolean
}

export interface NativeJobBridge {
  readonly dispatch: (input: { checkout: string; job: JobInput }) => Promise<Dispatched>
  readonly observe: (input: Binding) => Promise<Observation>
}

/** Structural view of the process-wide Location map. It keeps this module
 * below the Location layer graph; the real layer provides every service of
 * the target checkout, which closes the requirement channel at the cast below. */
export interface LocationSource {
  readonly get: (ref: Location.Ref) => Layer.Layer<never>
}

/** Each Location receives a bridge bound to the process-wide Location map.
 * Tools may only use it through this service; the map itself stays private. */
export class Bridge extends Context.Service<Bridge, NativeJobBridge>()("@opencode/v2/NativeJob") {}
export type Services = Database.Service | EventV2.Service | SessionStore.Service | ProjectV2.Service
export const bridge = (locations: LocationSource, owner: () => SessionExecution.Interface | undefined, services: Context.Context<Services>) => Bridge.of({
  dispatch: async (input) => {
    const execution = owner()
    if (!execution) throw new Refused({ reason: "checkout_unavailable", message: "The host Session execution owner is not bound" })
    return Effect.runPromise(dispatch(locations, input).pipe(
      Effect.provide(services), Effect.provideService(SessionExecution.Service, execution),
    ))
  },
  observe: (input) => Effect.runPromise(observe(locations, input).pipe(Effect.provide(services))),
})

const hostSessionID = (binding: string) => SessionSchema.ID.make(`ses_native_${binding}`)
const inputID = (binding: string, attempt: number) => SessionMessage.ID.make(`msg_native_${binding}_${attempt}`)
const decodeJob = Schema.decodeUnknownSync(Job)
const HostBinding = Schema.Struct({ version: Schema.Literal(1), binding: Job.fields.binding })
const isHostBinding = Schema.is(HostBinding)
const isAttempt = Schema.is(Job.fields.attempt)
const isBinding = Schema.is(Job.fields.binding)

/** Run one bound job inside the physical checkout's own Location. A missing or
 * foreign host Session binding refuses; nothing here grants write consent. */
export const dispatch = (locations: LocationSource, input: { checkout: string; job: JobInput }) =>
  Effect.gen(function* () {
    const execution = yield* SessionExecution.Service
    const resolved = yield* Effect.try({
      try: () => decodeJob(input.job),
      catch: (cause) => new Refused({ reason: "invalid_job", message: String(cause) }),
    })
    const checkout = yield* Effect.try({
      try: () => realpathSync.native(input.checkout),
      catch: (cause) => new Refused({ reason: "checkout_unavailable", message: String(cause) }),
    })
    const ref = Location.Ref.make({ directory: AbsolutePath.make(checkout) })
    const layer = yield* Effect.try({
      try: () => locations.get(ref),
      catch: (cause) => new Refused({ reason: "checkout_unavailable", message: String(cause) }),
    })
    // Loaded lazily: this module sits below the Location layer graph.
    const { SessionV2 } = yield* Effect.promise(() => import("../session"))
    // Session admission needs the project registry, which lives above the
    // Location layer; reuse the host's instance when it is already ambient.
    const projects = yield* Effect.serviceOption(ProjectV2.Service).pipe(Effect.map((current) =>
      Option.match(current, {
        onNone: () => ProjectV2.defaultLayer,
        onSome: (service) => Layer.succeed(ProjectV2.Service, service),
      })))
    return yield* Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const id = hostSessionID(resolved.binding)
      const host = yield* sessions.create({
        id, title: resolved.title, agent: PARENT_AGENT, location: ref,
        metadata: { [METADATA_KEY]: { version: 1, binding: resolved.binding } },
      })
      const saved = host.metadata?.[METADATA_KEY]
      if (!isHostBinding(saved) || saved.binding !== resolved.binding ||
        host.location.directory !== checkout || host.location.workspaceID || host.parentID)
        return yield* new Refused({ reason: "binding_mismatch", message: "The host Session is bound to another job" })
      const messageID = inputID(resolved.binding, resolved.attempt)
      const previous = yield* SessionInput.find(db, messageID).pipe(Effect.orDie)
      const prompt = new Prompt({ agent: PARENT_AGENT, text: resolved.prompt, subtask: {
        command: COMMAND, description: resolved.title, agent: resolved.agent, workspace: "main",
      } })
      if (previous && (previous.origin !== "plugin" || !SessionInput.equivalent(previous, { sessionID: host.id, prompt, delivery: "queue" })))
        return yield* new Refused({ reason: "binding_mismatch", message: "The saved attempt does not match this assignment" })
      if (!previous) yield* sessions.prompt({ sessionID: host.id, id: messageID, prompt, delivery: "queue", origin: "plugin",
        ...(resolved.attempt === 1 ? { expectedLatestInputID: null } : {}),
      })
      return {
        checkout, binding: resolved.binding, attempt: resolved.attempt,
        hostSessionID: host.id, inputID: messageID, created: previous === undefined,
      } satisfies Dispatched
    }).pipe(
      Effect.mapError((error) => error instanceof Refused ? error : new Refused({
        reason: "checkout_unavailable", message: error instanceof Error ? error.message : String(error),
      })),
      // The real Location layer above provides every service this body needs.
      Effect.provide(SessionV2.layerWithExecution(execution).pipe(Layer.provide(projects))),
      Effect.provide(layer),
      (effect) => effect as unknown as Effect.Effect<Dispatched, Refused>,
    )
  })

const childOf = Effect.fn("NativeJob.child")(function* (db: Database.Interface["db"], sessionID: SessionSchema.ID, childID: string) {
  if (!Schema.is(SessionSchema.ID)(childID)) return undefined
  const rows = yield* db.select({
    id: SessionTable.id, digest: SessionTable.fork_dispatch_digest, policy: SessionTable.agent_policy,
  }).from(SessionTable).where(and(eq(SessionTable.parent_id, sessionID), eq(SessionTable.id, childID)))
    .limit(1).all().pipe(Effect.orDie)
  const row = rows[0]
  const consent = row?.policy?.mainWriteConsent
  const placement = row?.policy?.executionPlacement
  if (!row?.digest || !consent || !placement) return undefined
  return {
    sessionID: row.id, inputID: SessionMessage.ID.make(consent.inputID), dispatchDigest: row.digest, placementIdentity: placement.identity,
  } satisfies Child
})

type ActivityView = Extract<Effect.Success<ReturnType<typeof SessionExecutionView.read>>, { phase: "activity" }>
const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)

type Terminal = Extract<Observation, { state: "terminal" }>
const toolOutcome = Effect.fn("NativeJob.toolOutcome")(function* (view: ActivityView, input: string) {
  for (const row of [...view.assistants].reverse()) {
    // The view selects assistant rows only; projectors omit id/type from `data`.
    const decoded = yield* decodeMessage({ ...row.data, id: row.id, type: "assistant" }).pipe(Effect.option)
    if (decoded._tag === "None" || decoded.value.type !== "assistant") continue
    const message = decoded.value
    const part = message.content.find((item): item is SessionMessage.AssistantTool =>
      item.type === "tool" && item.name === "task" && item.id === `command:${input}`)
    if (!part) continue
    if (part.state.status === "completed") {
      const text = part.state.structured.text
      const childID = part.state.structured.sessionID
      if (part.state.structured.state !== "completed" || typeof text !== "string" || typeof childID !== "string")
        return { status: "error" as const, error: "Native Task did not report a completed child" }
      return { status: "completed" as const, report: text, childID }
    }
    if (part.state.status === "error")
      return { status: "error" as const, error: JSON.stringify(part.state.failure ?? part.state.error ?? part.state.structured).slice(0, 4000) }
  }
  return undefined
})

/** Read durable evidence for one bound attempt. Never wakes, retries or
 * resumes anything; an orphaned or unmapped state stays "unsettled". */
export const observe = (locations: LocationSource, input: Binding) =>
  Effect.gen(function* () {
    if (!isBinding(input.binding) || !isAttempt(input.attempt))
      return yield* new Refused({ reason: "invalid_job", message: "Invalid native job binding or attempt" })
    const checkout = yield* Effect.try({
      try: () => realpathSync.native(input.checkout),
      catch: () => new Refused({ reason: "checkout_unavailable", message: input.checkout }),
    })
    const ref = Location.Ref.make({ directory: AbsolutePath.make(checkout) })
    const layer = yield* Effect.try({
      try: () => locations.get(ref),
      catch: (cause) => new Refused({ reason: "checkout_unavailable", message: String(cause) }),
    })
    return yield* Effect.gen(function* () {
      const database = yield* Database.Service
      const id = hostSessionID(input.binding)
      const host = yield* database.db.select({ metadata: SessionTable.metadata }).from(SessionTable)
        .where(and(eq(SessionTable.id, id), eq(SessionTable.directory, checkout), isNull(SessionTable.parent_id),
          isNull(SessionTable.workspace_id))).get().pipe(Effect.orDie)
      if (!host) return { state: "missing" as const }
      const saved = host.metadata?.[METADATA_KEY]
      if (!isHostBinding(saved) || saved.binding !== input.binding)
        return yield* new Refused({ reason: "binding_mismatch", message: "The host Session is bound to another job" })
      const messageID = inputID(input.binding, input.attempt)
      const admitted = yield* SessionInput.find(database.db, messageID).pipe(Effect.orDie)
      if (!admitted) return { state: "missing" as const }
      if (admitted.sessionID !== id || admitted.origin !== "plugin" || admitted.delivery !== "queue" ||
        admitted.prompt.subtask?.command !== COMMAND || admitted.prompt.subtask.workspace !== "main")
        return yield* new Refused({ reason: "binding_mismatch", message: "The saved input is not a native job assignment" })
      const view = yield* SessionExecutionView.read(database, { sessionID: id, messageID, requireOriginalActivity: true })
      const base = { hostSessionID: id, inputID: messageID }
      if (view.phase === "admission_missing") return { state: "missing" as const }
      if (view.phase === "admitted") return { state: "admitted" as const, ...base }
      if (view.phase === "promoted") return { state: "unsettled" as const, ...base, reason: "promoted_without_activity" }
      if (view.activity.status === "orphaned")
        return { state: "unsettled" as const, ...base, reason: "orphaned_activity" }
      const status = view.activity.status === "completed" || view.activity.status === "failed" || view.activity.status === "interrupted"
        ? view.activity.status : "failed"
      if (view.activity.status !== status)
        return { state: "running" as const, ...base, activityID: view.activity.id, status: view.activity.status, questions: view.questions }
      if (view.activity.closed_seq === null)
        return { state: "unsettled" as const, ...base, reason: "activity_missing_closing_sequence" }
      const outcome = yield* toolOutcome(view, messageID)
      const child = outcome?.status === "completed" ? yield* childOf(database.db, id, outcome.childID) : undefined
      const childView = child ? yield* SessionExecutionView.readMainTask(database, {
        parentSessionID: id, sessionID: child.sessionID, messageID: child.inputID,
        dispatchDigest: child.dispatchDigest, placementIdentity: child.placementIdentity,
      }) : undefined
      const tool = outcome?.status === "completed"
        ? childView?.phase === "activity" && childView.activity.status === "completed" && childView.activity.closed_seq !== null &&
           !childView.laterAdmissions.length && !view.laterAdmissions.length
          ? { status: "completed" as const, report: outcome.report }
          : { status: "error" as const, error: "The exact child did not produce a settled completion receipt" }
        : outcome
      return {
        state: "terminal" as const, ...base, activityID: view.activity.id, status,
        ...(child ? { child } : {}), tool, lastError: view.activity.last_error,
      } satisfies Terminal
    }).pipe(
      Effect.provide(layer),
      (effect) => effect as unknown as Effect.Effect<Observation, Refused>,
    )
  })
