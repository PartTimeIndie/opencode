export * as SessionOrchestrator from "./orchestrator"

import { and, asc, eq, inArray, isNull } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { QuestionTable } from "../question/sql"
import { SessionSchema } from "./schema"
import { SessionMessage } from "./message"
import { SessionActivityTable, SessionInputTable, SessionMessageTable, SessionTable } from "./sql"
import { OrchestratorPolicy } from "./orchestrator/policy"
import { OrchestratorCheckout } from "./orchestrator/checkout"
import {
  SessionOrchestratorTable,
  SessionOrchestratorTaskTable,
  SessionOrchestratorReservationTable,
} from "./orchestrator/sql"

export type State = typeof SessionOrchestratorTable.$inferSelect
export type Task = typeof SessionOrchestratorTaskTable.$inferSelect

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("SessionOrchestrator.Conflict", {
  reason: Schema.Literals([
    "missing",
    "role",
    "revision",
    "settings",
    "origin",
    "retry",
    "dependency",
    "control",
    "transition",
    "cache",
    "resources",
    "child",
    "settlement",
  ]),
}) {}

export type ConfigureInput = OrchestratorPolicy.Settings & {
  readonly mainSessionID: SessionSchema.ID
  readonly expectedRevision: number
}
export type PlanInput = {
  readonly id: string
  readonly requestID: string
  readonly mainSessionID: SessionSchema.ID
  readonly originInputID: SessionMessage.ID
  readonly goal: string
  readonly acceptance: string
  readonly resources: readonly string[]
  readonly dependencies: readonly string[]
}
export type TaskInput = {
  readonly mainSessionID: SessionSchema.ID
  readonly taskID: string
  readonly expectedRevision: number
}
export type ChildInput = TaskInput & { readonly childSessionID: SessionSchema.ID }

// This store intentionally cannot grant execution authority. A host admission
// producer and SessionExecution integration must validate real-user provenance
// before using its reservations to start a child. User-shaped inbox rows and
// these planning records alone never authorize a fork.
const make = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const checkouts = yield* OrchestratorCheckout.Service
  type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

  const main = Effect.fn("SessionOrchestrator.main")(function* (
    tx: Pick<Transaction, "select">,
    sessionID: SessionSchema.ID,
    archived = false,
  ) {
    const session = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
    if (!session || (!archived && session.time_archived !== null)) return yield* new Conflict({ reason: "missing" })
    const child = yield* tx
      .select({ id: SessionOrchestratorTaskTable.id })
      .from(SessionOrchestratorTaskTable)
      .where(eq(SessionOrchestratorTaskTable.child_session_id, sessionID))
      .get()
      .pipe(Effect.orDie)
    if (session.parent_id !== null || child) return yield* new Conflict({ reason: "role" })
    return session
  })

  const task = Effect.fn("SessionOrchestrator.task")(function* (tx: Transaction, input: TaskInput, archived = false) {
    yield* main(tx, input.mainSessionID, archived)
    const row = yield* tx
      .select()
      .from(SessionOrchestratorTaskTable)
      .where(
        and(
          eq(SessionOrchestratorTaskTable.id, input.taskID),
          eq(SessionOrchestratorTaskTable.main_session_id, input.mainSessionID),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!row) return yield* new Conflict({ reason: "missing" })
    if (row.revision !== input.expectedRevision) return yield* new Conflict({ reason: "revision" })
    return row
  })

  const state = Effect.fn("SessionOrchestrator.state")(function* (tx: Transaction, sessionID: SessionSchema.ID) {
    const row = yield* tx
      .select()
      .from(SessionOrchestratorTable)
      .where(eq(SessionOrchestratorTable.main_session_id, sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return yield* new Conflict({ reason: "missing" })
    return row
  })

  // Filesystem traversal can be slow (especially UNC). Never hold SQLite's
  // write lock while resolving it; recheck the placement in the transaction.
  const placement = Effect.fn("SessionOrchestrator.placement")(function* (sessionID: SessionSchema.ID) {
    const session = yield* main(db, sessionID)
    const checkout = yield* checkouts
      .resolve(session.directory)
      .pipe(Effect.mapError(() => new Conflict({ reason: "resources" })))
    if (!checkout) return yield* new Conflict({ reason: "resources" })
    return { directory: session.directory, checkout }
  })

  const configure = Effect.fn("SessionOrchestrator.configure")(function* (input: ConfigureInput) {
    const resolved = yield* placement(input.mainSessionID)
    return yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const session = yield* main(tx, input.mainSessionID)
            if (session.directory !== resolved.directory) return yield* new Conflict({ reason: "resources" })
            const checkout = resolved.checkout
            if (!OrchestratorPolicy.validSettings(input)) return yield* new Conflict({ reason: "settings" })
            const current = yield* tx
              .select()
              .from(SessionOrchestratorTable)
              .where(eq(SessionOrchestratorTable.main_session_id, input.mainSessionID))
              .get()
              .pipe(Effect.orDie)
            if ((current?.revision ?? 0) !== input.expectedRevision) return yield* new Conflict({ reason: "revision" })
            if (current?.checkout_id && current.checkout_id !== checkout)
              return yield* new Conflict({ reason: "resources" })
            const values = {
              checkout_id: checkout,
              interaction: input.interaction,
              workspace_mode: input.workspaceMode,
              max_workers: input.maxWorkers,
              min_cache_read_ratio: input.minCacheReadRatio,
              time_updated: Date.now(),
            }
            const rows = current
              ? yield* tx
                  .update(SessionOrchestratorTable)
                  .set({ ...values, revision: current.revision + 1 })
                  .where(eq(SessionOrchestratorTable.main_session_id, input.mainSessionID))
                  .returning()
                  .all()
                  .pipe(Effect.orDie)
              : yield* tx
                  .insert(SessionOrchestratorTable)
                  .values({ ...values, main_session_id: input.mainSessionID })
                  .returning()
                  .all()
                  .pipe(Effect.orDie)
            const result = rows[0]
            if (!result) return yield* Effect.die("Orchestrator configuration returned no row")
            return result
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.catchTag("SqlError", Effect.die))
  })

  const plan = Effect.fn("SessionOrchestrator.plan")(function* (input: PlanInput) {
    const resolved = yield* placement(input.mainSessionID)
    return yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const session = yield* main(tx, input.mainSessionID)
            const settings = yield* state(tx, input.mainSessionID)
            if (session.directory !== resolved.directory || settings.checkout_id !== resolved.checkout)
              return yield* new Conflict({ reason: "resources" })
            const keys = input.resources.map(OrchestratorPolicy.resourceKey)
            if (keys.some((key) => key === undefined)) return yield* new Conflict({ reason: "resources" })
            const resources = [...new Set(keys.filter((key) => key !== undefined))].sort()
            const dependencies = [...new Set(input.dependencies)].sort()
            if (!input.id.trim() || !input.requestID.trim() || !input.goal.trim() || !input.acceptance.trim())
              return yield* new Conflict({ reason: "origin" })
            if (
              resources.length === 0 ||
              resources.some((resource) => !resource.trim() || resource !== resource.trim())
            )
              return yield* new Conflict({ reason: "resources" })
            const previous = yield* tx
              .select()
              .from(SessionOrchestratorTaskTable)
              .where(
                and(
                  eq(SessionOrchestratorTaskTable.main_session_id, input.mainSessionID),
                  eq(SessionOrchestratorTaskTable.request_id, input.requestID),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (previous) {
              if (
                previous.id !== input.id ||
                previous.origin_input_id !== input.originInputID ||
                previous.goal !== input.goal ||
                previous.acceptance !== input.acceptance ||
                JSON.stringify(previous.resources) !== JSON.stringify(resources) ||
                JSON.stringify(previous.dependencies) !== JSON.stringify(dependencies)
              )
                return yield* new Conflict({ reason: "retry" })
              return previous
            }
            const reused = yield* tx
              .select({ id: SessionOrchestratorTaskTable.id })
              .from(SessionOrchestratorTaskTable)
              .where(eq(SessionOrchestratorTaskTable.id, input.id))
              .get()
              .pipe(Effect.orDie)
            if (reused) return yield* new Conflict({ reason: "retry" })
            // This only anchors a proposal to durable dialogue. It is deliberately not
            // proof that the admission came from a human; the host must attest that.
            const origin = yield* tx
              .select()
              .from(SessionInputTable)
              .where(
                and(
                  eq(SessionInputTable.id, input.originInputID),
                  eq(SessionInputTable.session_id, input.mainSessionID),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (
              !origin ||
              origin.promoted_seq === null ||
              typeof origin.prompt?.text !== "string" ||
              !origin.prompt.text.trim()
            )
              return yield* new Conflict({ reason: "origin" })
            const user = yield* tx
              .select({ id: SessionMessageTable.id })
              .from(SessionMessageTable)
              .where(
                and(
                  eq(SessionMessageTable.session_id, input.mainSessionID),
                  eq(SessionMessageTable.id, input.originInputID),
                  eq(SessionMessageTable.type, "user"),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (!user) return yield* new Conflict({ reason: "origin" })
            for (const id of dependencies) {
              const dependency = yield* tx
                .select({ main: SessionOrchestratorTaskTable.main_session_id })
                .from(SessionOrchestratorTaskTable)
                .where(eq(SessionOrchestratorTaskTable.id, id))
                .get()
                .pipe(Effect.orDie)
              // Requiring earlier tasks avoids cycles without a second graph store.
              if (!dependency || dependency.main !== input.mainSessionID)
                return yield* new Conflict({ reason: "dependency" })
            }
            const rows = yield* tx
              .insert(SessionOrchestratorTaskTable)
              .values({
                id: input.id,
                request_id: input.requestID,
                checkout_id: settings.checkout_id,
                min_cache_read_ratio: settings.min_cache_read_ratio,
                main_session_id: input.mainSessionID,
                origin_input_id: input.originInputID,
                origin_user_message_id: user.id,
                goal: input.goal,
                acceptance: input.acceptance,
                resources,
                dependencies,
                workspace_mode: settings.workspace_mode,
              })
              .returning()
              .all()
              .pipe(Effect.orDie)
            const result = rows[0]
            if (!result) return yield* Effect.die("Orchestrator task insertion returned no row")
            return result
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.catchTag("SqlError", Effect.die))
  })

  const reserve = Effect.fn("SessionOrchestrator.reserve")(function* (input: TaskInput) {
    const resolved = yield* placement(input.mainSessionID)
    return yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const row = yield* task(tx, input)
            const session = yield* main(tx, input.mainSessionID)
            const settings = yield* state(tx, input.mainSessionID)
            if (
              session.directory !== resolved.directory ||
              settings.checkout_id !== resolved.checkout ||
              row.checkout_id !== resolved.checkout
            )
              return yield* new Conflict({ reason: "resources" })
            if (settings.control !== "active") return yield* new Conflict({ reason: "control" })
            if (row.state !== "planned" && row.state !== "waiting") return yield* new Conflict({ reason: "transition" })
            const tasks = yield* tx
              .select()
              .from(SessionOrchestratorTaskTable)
              .where(eq(SessionOrchestratorTaskTable.main_session_id, input.mainSessionID))
              .all()
              .pipe(Effect.orDie)
            const ready = row.dependencies.every((id) =>
              tasks.some(
                (dependency) => dependency.id === id && dependency.state === "done" && !dependency.slot_claimed,
              ),
            )
            const reservations = yield* tx
              .select()
              .from(SessionOrchestratorReservationTable)
              .where(eq(SessionOrchestratorReservationTable.directory, row.checkout_id))
              .all()
              .pipe(Effect.orDie)
            const claims = yield* tx
              .select()
              .from(SessionOrchestratorTaskTable)
              .where(eq(SessionOrchestratorTaskTable.slot_claimed, true))
              .all()
              .pipe(Effect.orDie)
            // Claimed tasks remain exclusion evidence if startup repair had to
            // recreate an empty reservation index. Unknown legacy scope blocks.
            const inconsistent = !row.checkout_id || claims.some((claim) => !claim.checkout_id)
            const busy =
              inconsistent ||
              claims.some((claim) =>
                claim.resources.some((held) =>
                  row.resources.some(
                    (resource) =>
                      (claim.checkout_id === row.checkout_id ||
                        (held.startsWith("path:") && resource.startsWith("path:"))) &&
                      OrchestratorPolicy.overlaps(resource, held),
                  ),
                ),
              ) ||
              row.resources.some((resource) =>
                reservations.some((held) => OrchestratorPolicy.overlaps(resource, held.resource)),
              )
            const admitted = ready && !busy && tasks.filter((item) => item.slot_claimed).length < settings.max_workers
            if (admitted)
              yield* tx
                .insert(SessionOrchestratorReservationTable)
                .values(
                  row.resources.map((resource) => ({
                    directory: row.checkout_id,
                    resource,
                    task_id: row.id,
                  })),
                )
                .run()
                .pipe(Effect.orDie)
            const rows = yield* tx
              .update(SessionOrchestratorTaskTable)
              .set({
                state: admitted ? "reserved" : "waiting",
                slot_claimed: admitted,
                revision: row.revision + 1,
                time_updated: Date.now(),
              })
              .where(eq(SessionOrchestratorTaskTable.id, row.id))
              .returning()
              .all()
              .pipe(Effect.orDie)
            const result = rows[0]
            if (!result) return yield* Effect.die("Orchestrator reservation returned no row")
            return result
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.catchTag("SqlError", Effect.die))
  })

  const transition = Effect.fn("SessionOrchestrator.transition")(
    (input: TaskInput & { readonly state: OrchestratorPolicy.TaskState }) =>
      db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* task(tx, input)
              if (input.state === "waiting" && (row.slot_claimed || row.child_session_id !== null))
                return yield* new Conflict({ reason: "transition" })
              if (!OrchestratorPolicy.canTransition(row.state, input.state))
                return yield* new Conflict({ reason: "transition" })
              // reserve() is the only lane that can claim a slot. Cache acceptance must
              // come from measured first-request usage, never a generic state update.
              if (input.state === "reserved" || (input.state === "running" && row.state === "checking_cache"))
                return yield* new Conflict({ reason: "transition" })
              const rows = yield* tx
                .update(SessionOrchestratorTaskTable)
                .set({ state: input.state, revision: row.revision + 1, time_updated: Date.now() })
                .where(eq(SessionOrchestratorTaskTable.id, row.id))
                .returning()
                .all()
                .pipe(Effect.orDie)
              const result = rows[0]
              if (!result) return yield* Effect.die("Orchestrator transition returned no row")
              return result
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die)),
  )

  const recordCache = Effect.fn("SessionOrchestrator.recordCache")(
    (input: TaskInput & { readonly profile: string; readonly usage: OrchestratorPolicy.CacheUsage }) =>
      db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* task(tx, input)
              const settings = yield* state(tx, input.mainSessionID)
              if (row.state !== "checking_cache" || !input.profile.trim())
                return yield* new Conflict({ reason: "cache" })
              if (
                !Number.isFinite(row.min_cache_read_ratio) ||
                row.min_cache_read_ratio < 0 ||
                row.min_cache_read_ratio > 1
              )
                return yield* new Conflict({ reason: "cache" })
              const evidence = OrchestratorPolicy.cacheEvidence(input.usage, row.min_cache_read_ratio)
              const rows = yield* tx
                .update(SessionOrchestratorTaskTable)
                .set({
                  cache_profile: input.profile,
                  cache_status: evidence.status,
                  cache_ratio: "ratio" in evidence ? evidence.ratio : null,
                  state: evidence.status === "accepted" ? "running" : "blocked_cache",
                  revision: row.revision + 1,
                  time_updated: Date.now(),
                })
                .where(eq(SessionOrchestratorTaskTable.id, row.id))
                .returning()
                .all()
                .pipe(Effect.orDie)
              const result = rows[0]
              if (!result) return yield* Effect.die("Orchestrator cache update returned no row")
              return { task: result, fallback: OrchestratorPolicy.cacheFallback(evidence, settings.interaction) }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die)),
  )

  const control = Effect.fn("SessionOrchestrator.control")(
    (input: {
      readonly mainSessionID: SessionSchema.ID
      readonly expectedRevision: number
      readonly control: OrchestratorPolicy.Control
    }) =>
      db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              yield* main(tx, input.mainSessionID)
              const current = yield* state(tx, input.mainSessionID)
              if (current.revision !== input.expectedRevision) return yield* new Conflict({ reason: "revision" })
              if (!Schema.is(OrchestratorPolicy.Control)(input.control))
                return yield* new Conflict({ reason: "control" })
              // This is admission control only. The execution owner, not this store,
              // performs a safe pause and confirms slot release after tools settle.
              const rows = yield* tx
                .update(SessionOrchestratorTable)
                .set({ control: input.control, revision: current.revision + 1, time_updated: Date.now() })
                .where(eq(SessionOrchestratorTable.main_session_id, input.mainSessionID))
                .returning()
                .all()
                .pipe(Effect.orDie)
              const result = rows[0]
              if (!result) return yield* Effect.die("Orchestrator control returned no row")
              return result
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die)),
  )

  const releaseUnstarted = Effect.fn("SessionOrchestrator.releaseUnstarted")((input: TaskInput) =>
    db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const row = yield* task(tx, input, true)
            if (row.child_session_id !== null || (!OrchestratorPolicy.terminal(row.state) && row.state !== "paused"))
              return yield* new Conflict({ reason: "transition" })
            yield* tx
              .delete(SessionOrchestratorReservationTable)
              .where(eq(SessionOrchestratorReservationTable.task_id, row.id))
              .run()
              .pipe(Effect.orDie)
            const result = yield* tx
              .update(SessionOrchestratorTaskTable)
              .set({ slot_claimed: false, revision: row.revision + 1, time_updated: Date.now() })
              .where(eq(SessionOrchestratorTaskTable.id, row.id))
              .returning()
              .get()
              .pipe(Effect.orDie)
            if (!result) return yield* Effect.die("Orchestrator release returned no row")
            return result
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.catchTag("SqlError", Effect.die)),
  )

  // Binding records which Session was started for a task. It is a store seam:
  // the caller still owns host attestation, fork provisioning and permissions.
  const assignChild = Effect.fn("SessionOrchestrator.assignChild")((input: ChildInput) =>
    db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const row = yield* task(tx, input)
            const session = yield* tx
              .select()
              .from(SessionTable)
              .where(eq(SessionTable.id, input.childSessionID))
              .get()
              .pipe(Effect.orDie)
            if (!session || session.time_archived !== null || session.parent_id !== input.mainSessionID)
              return yield* new Conflict({ reason: "child" })
            const orchestrator = yield* tx
              .select({ id: SessionOrchestratorTable.main_session_id })
              .from(SessionOrchestratorTable)
              .where(eq(SessionOrchestratorTable.main_session_id, input.childSessionID))
              .get()
              .pipe(Effect.orDie)
            if (orchestrator) return yield* new Conflict({ reason: "role" })
            const bound = yield* tx
              .select({ id: SessionOrchestratorTaskTable.id })
              .from(SessionOrchestratorTaskTable)
              .where(eq(SessionOrchestratorTaskTable.child_session_id, input.childSessionID))
              .get()
              .pipe(Effect.orDie)
            if (bound && bound.id !== row.id) return yield* new Conflict({ reason: "child" })
            if (row.child_session_id === input.childSessionID) return row
            if (row.child_session_id !== null || (row.state !== "snapshotting" && row.state !== "starting"))
              return yield* new Conflict({ reason: "transition" })
            const rows = yield* tx
              .update(SessionOrchestratorTaskTable)
              .set({ child_session_id: input.childSessionID, revision: row.revision + 1, time_updated: Date.now() })
              .where(eq(SessionOrchestratorTaskTable.id, row.id))
              .returning()
              .all()
              .pipe(Effect.orDie)
            const result = rows[0]
            if (!result) return yield* Effect.die("Orchestrator child binding returned no row")
            return result
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.catchTag("SqlError", Effect.die)),
  )

  // Settlement releases capacity only from durable evidence that the bound
  // child can no longer write: no unpromoted inputs, no queued/active
  // questions, no running/recovering activity and at least one recorded
  // activity. Task state alone never settles a started child, and the child
  // link is retained as provenance. A truly stopped-looking idle child with
  // zero activities fails closed and needs explicit host resolution.
  const settleChild = Effect.fn("SessionOrchestrator.settleChild")((input: ChildInput) =>
    db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const row = yield* task(tx, input)
            if (row.child_session_id !== input.childSessionID) return yield* new Conflict({ reason: "child" })
            if (!row.slot_claimed) return row
            const pending = yield* tx
              .select({ id: SessionInputTable.id })
              .from(SessionInputTable)
              .where(
                and(eq(SessionInputTable.session_id, input.childSessionID), isNull(SessionInputTable.promoted_seq)),
              )
              .get()
              .pipe(Effect.orDie)
            if (pending) return yield* new Conflict({ reason: "settlement" })
            const question = yield* tx
              .select({ id: QuestionTable.id })
              .from(QuestionTable)
              .where(
                and(
                  eq(QuestionTable.session_id, input.childSessionID),
                  inArray(QuestionTable.state, ["queued", "active"]),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (question) return yield* new Conflict({ reason: "settlement" })
            const activities = yield* tx
              .select({ status: SessionActivityTable.status })
              .from(SessionActivityTable)
              .where(eq(SessionActivityTable.session_id, input.childSessionID))
              .all()
              .pipe(Effect.orDie)
            if (
              activities.length === 0 ||
              activities.some((activity) => activity.status === "running" || activity.status === "recovering")
            )
              return yield* new Conflict({ reason: "settlement" })
            yield* tx
              .delete(SessionOrchestratorReservationTable)
              .where(eq(SessionOrchestratorReservationTable.task_id, row.id))
              .run()
              .pipe(Effect.orDie)
            const result = yield* tx
              .update(SessionOrchestratorTaskTable)
              .set({ slot_claimed: false, revision: row.revision + 1, time_updated: Date.now() })
              .where(eq(SessionOrchestratorTaskTable.id, row.id))
              .returning()
              .get()
              .pipe(Effect.orDie)
            if (!result) return yield* Effect.die("Orchestrator settlement returned no row")
            return result
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.catchTag("SqlError", Effect.die)),
  )

  return {
    configure,
    plan,
    reserve,
    transition,
    recordCache,
    control,
    releaseUnstarted,
    assignChild,
    settleChild,
    get: (sessionID: SessionSchema.ID) =>
      db
        .select()
        .from(SessionOrchestratorTable)
        .where(eq(SessionOrchestratorTable.main_session_id, sessionID))
        .get()
        .pipe(Effect.orDie),
    tasks: (sessionID: SessionSchema.ID) =>
      db
        .select()
        .from(SessionOrchestratorTaskTable)
        .where(eq(SessionOrchestratorTaskTable.main_session_id, sessionID))
        .orderBy(asc(SessionOrchestratorTaskTable.time_created), asc(SessionOrchestratorTaskTable.id))
        .all()
        .pipe(Effect.orDie),
  }
})

export class Service extends Context.Service<Service, Effect.Success<typeof make>>()(
  "@opencode/v2/SessionOrchestrator",
) {}

export const layer = Layer.effect(Service, make)
