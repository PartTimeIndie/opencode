export * as SessionV2 from "./session"
export * from "./session/schema"

import { Cause, DateTime, Effect, Layer, Schema, Context, Stream, Option } from "effect"
import { and, asc, desc, eq, gt, gte, inArray, like, lt, or, sql, type SQL } from "drizzle-orm"
import { ProjectV2 } from "./project"
import { WorkspaceV2 } from "./workspace"
import { ModelV2 } from "./model"
import { Location } from "./location"
import { SessionMessage } from "./session/message"
import { Prompt } from "./session/prompt"
import { EventV2 } from "./event"
import { Database } from "./database/database"
import { SessionProjector } from "./session/projector"
import { SessionActivityTable, SessionMessageTable, SessionTable } from "./session/sql"
import { SessionSchema } from "./session/schema"
import { AbsolutePath, PositiveInt, RelativePath } from "./schema"
import { AgentV2 } from "./agent"
import { SessionV1 } from "./v1/session"
import { InstallationVersion } from "./installation/version"
import { Slug } from "./util/slug"
import { ProjectTable } from "./project/sql"
import path from "path"
import { fromRow } from "./session/info"
import { SessionRunner } from "./session/runner/index"
import { SessionRunnerModel } from "./session/runner/model"
import { overrideModel, sameChainSelection } from "./session/runner/model-chain"
import { SessionStore } from "./session/store"
import * as SessionProtection from "./session/protection"
import { SessionExecution } from "./session/execution"
import { SessionFileMutation } from "./session/file-mutation"
import { logFailure } from "./session/logging"
import { MessageDecodeError } from "./session/error"
import { SessionEvent } from "./session/event"
import { SessionInput } from "./session/input"
import { SessionAgentPolicy } from "./session/agent-policy"
import { KeyedMutex } from "./effect/keyed-mutex"
import { QuestionV2 } from "./question"
import { Perf } from "./observability/perf"
import { LocationServiceMap } from "./location-layer"
import { ToolRegistry } from "./tool/registry"
import { BashTool } from "./tool/bash"
import { LLM, LLMClient, LLMError, type ToolContent } from "@opencode-ai/llm"
import { ContentStore } from "./content-store"
import { SessionArchive } from "./session-archive"
import { SessionCompaction, SummaryFailed } from "./session/compaction"
import { SessionHistory } from "./session/history"
import { SessionTodo } from "./session/todo"
import { Config } from "./config"
import { PermissionV1 } from "./v1/permission"

// get project -> project.locations
//
// get all sessions
//

// - by project
//   - by subpath
// - by workspace (home is special)

export const ListAnchor = Schema.Struct({
  id: SessionSchema.ID,
  time: Schema.Finite,
  direction: Schema.Literals(["previous", "next"]),
})
export type ListAnchor = typeof ListAnchor.Type

const hiddenMetadataFilter = sql`coalesce(json_extract(${SessionTable.metadata}, '$.opencode.hidden'), 0) != 1`

const ListInputBase = {
  workspaceID: WorkspaceV2.ID.pipe(Schema.optional),
  search: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  anchor: ListAnchor.pipe(Schema.optional),
  includeHidden: Schema.Boolean.pipe(Schema.optional),
}

const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

const ListProjectInput = Schema.Struct({
  ...ListInputBase,
  project: ProjectV2.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([ListDirectoryInput, ListProjectInput, ListAllInput])
export type ListInput = typeof ListInput.Type

export type CreateInput = {
  id?: SessionSchema.ID
  parentID?: SessionSchema.ID
  title?: string
  agent?: AgentV2.ID
  model?: ModelV2.Ref
  metadata?: Record<string, unknown>
  permission?: PermissionV1.Ruleset
  agentPolicy?: SessionAgentPolicy.Info
  location: Location.Ref
}

type CompactInput = {
  sessionID: SessionSchema.ID
  prompt?: Prompt
}

type RevertInput = {
  sessionID: SessionSchema.ID
  messageID: SessionMessage.ID
  partID?: string
  files?: "journal" | "messages_only"
}

type ShareInput = {
  sessionID: SessionSchema.ID
  share?: SessionSchema.Share
}

type SummaryInput = {
  sessionID: SessionSchema.ID
  summary?: SessionSchema.Summary
}

export type PromptInput = {
  id?: SessionMessage.ID
  sessionID: SessionSchema.ID
  prompt: Prompt
  agent?: AgentV2.ID
  model?: ModelV2.Ref
  system?: string
  delivery?: SessionInput.Delivery
  resume?: boolean
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Session.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class OperationUnavailableError extends Schema.TaggedErrorClass<OperationUnavailableError>()(
  "Session.OperationUnavailableError",
  {
    operation: Schema.Literals(["move", "shell", "skill", "switchAgent", "compact", "wait"]),
  },
) {}

export class BusyError extends Schema.TaggedErrorClass<BusyError>()("SessionBusyError", {
  sessionID: SessionSchema.ID,
}) {}

export class AgentTransitionError extends Schema.TaggedErrorClass<AgentTransitionError>()(
  "Session.AgentTransitionError",
  {
    sessionID: SessionSchema.ID,
    agent: Schema.String,
    reason: Schema.Literals(["not_found", "hidden", "subagent", "model_unavailable"]),
  },
) {}

export { ContextSnapshotDecodeError, MessageDecodeError } from "./session/error"

export class PromptConflictError extends Schema.TaggedErrorClass<PromptConflictError>()("Session.PromptConflictError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {}

export class RollbackBlockedError extends Schema.TaggedErrorClass<RollbackBlockedError>()("Session.RollbackBlockedError", {
  sessionID: SessionSchema.ID,
}) {}

export class RollbackTargetError extends Schema.TaggedErrorClass<RollbackTargetError>()("Session.RollbackTargetError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
  partID: Schema.String.pipe(Schema.optional),
  reason: Schema.Literals(["message", "part"]),
}) {}

export type Error =
  | NotFoundError
  | MessageDecodeError
  | OperationUnavailableError
  | PromptConflictError
  | RollbackBlockedError
  | RollbackTargetError
  | BusyError
  | AgentTransitionError
  | ContentStore.Error

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<SessionSchema.Info[]>
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly messages: (input: {
    sessionID: SessionSchema.ID
    limit?: number
    order?: "asc" | "desc"
    cursor?: {
      id: SessionMessage.ID
      direction: "previous" | "next"
    }
  }) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly messageContext: (input: {
    sessionID: SessionSchema.ID
    before: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Message[], MessageDecodeError>
  readonly message: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Message | undefined>
  readonly context: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly events: (input: {
    sessionID: SessionSchema.ID
    after?: EventV2.Cursor
  }) => Stream.Stream<EventV2.CursorEvent<SessionEvent.DurableEvent>, NotFoundError>
  readonly switchAgent: (input: {
    sessionID: SessionSchema.ID
    agent: string
    model?: ModelV2.Ref
  }) => Effect.Effect<void, NotFoundError>
  readonly heldInputs: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<ReadonlyArray<SessionInput.Admitted>, NotFoundError>
  readonly releaseInput: (input: {
    sessionID: SessionSchema.ID
    inputID: SessionMessage.ID
  }) => Effect.Effect<SessionInput.Admitted | undefined, NotFoundError>
  readonly switchModel: (input: {
    sessionID: SessionSchema.ID
    model: ModelV2.Ref
  }) => Effect.Effect<void, NotFoundError | SummaryFailed | MessageDecodeError>
  readonly switchAgentAndPrompt: (input: {
    sessionID: SessionSchema.ID
    agent: string
    model?: ModelV2.Ref
    prompt: Prompt
  }) => Effect.Effect<
    SessionInput.Admitted,
    | NotFoundError
    | PromptConflictError
    | RollbackBlockedError
    | BusyError
    | ContentStore.Error
    | AgentTransitionError
    | OperationUnavailableError
  >
  readonly setTitle: (input: { sessionID: SessionSchema.ID; title: string }) => Effect.Effect<void, NotFoundError>
  readonly patchMetadata: (input: {
    sessionID: SessionSchema.ID
    patch: SessionSchema.MetadataPatch
  }) => Effect.Effect<void, NotFoundError>
  readonly setShare: (input: ShareInput) => Effect.Effect<void, NotFoundError>
  readonly setSummary: (input: SummaryInput) => Effect.Effect<void, NotFoundError>
  readonly prompt: (
    input: PromptInput,
  ) => Effect.Effect<SessionInput.Admitted, NotFoundError | PromptConflictError | RollbackBlockedError | BusyError | ContentStore.Error>
  readonly synthetic: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    text: string
  }) => Effect.Effect<void, NotFoundError>
  readonly revert: (input: RevertInput) => Effect.Effect<SessionSchema.Info, NotFoundError | BusyError | RollbackBlockedError>
  readonly rollback: (input: RevertInput) => Effect.Effect<SessionSchema.Info, NotFoundError | RollbackTargetError | RollbackBlockedError>
  readonly unrevert: (input: {
    sessionID: SessionSchema.ID
  }) => Effect.Effect<SessionSchema.Info, NotFoundError | BusyError>
  readonly cleanupRevert: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | BusyError>
  readonly shell: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    command: string
    agent?: AgentV2.ID
    resume?: boolean
  }) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly skill: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    skill: string
    resume?: boolean
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly compact: (input: CompactInput) => Effect.Effect<
    void,
    NotFoundError | MessageDecodeError | SessionCompaction.SummaryFailed
  >
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | SessionRunner.RunError>
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Session") {}

export const createSession = Effect.fn("V2Session.create")(function* (
  dependencies: {
    readonly db: Database.Interface["db"]
    readonly events: EventV2.Interface
    readonly projects: ProjectV2.Interface
    readonly store: SessionStore.Interface
  },
  input: CreateInput,
) {
  const sessionID = input.id ?? SessionSchema.ID.create()
  const recorded = yield* dependencies.store.get(sessionID)
  if (recorded) return recorded
  const project = yield* dependencies.projects.resolve(input.location.directory)
  yield* dependencies.db
    .insert(ProjectTable)
    .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const now = Date.now()
  const info = SessionV1.SessionInfo.make({
    id: sessionID,
    slug: Slug.create(),
    version: InstallationVersion,
    projectID: project.id,
    directory: input.location.directory,
    path: path.relative(project.directory, input.location.directory).replaceAll("\\", "/"),
    workspaceID: input.location.workspaceID ? WorkspaceV2.ID.make(input.location.workspaceID) : undefined,
    title: input.title ?? `New session - ${new Date(now).toISOString()}`,
    protected: false,
    parentID: input.parentID,
    agent: input.agent,
    model: input.model ? overrideModel(undefined, input.model) : undefined,
    metadata: input.metadata,
    permission: input.permission,
    agentPolicy: input.agentPolicy,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: now, updated: now },
  })
  const projected = yield* dependencies.events
    .publish(SessionV1.Event.Created, { sessionID, info }, { location: input.location })
    .pipe(
      Effect.as({ type: "created" } as const),
      Effect.catchDefect((defect) => {
        if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) return Effect.die(defect)
        // Concurrent creation lost the projection race. The existing Session identity wins.
        return dependencies.store
          .get(sessionID)
          .pipe(
            Effect.flatMap((session) =>
              session ? Effect.succeed({ type: "existing", session } as const) : Effect.die(defect),
            ),
          )
      }),
    )
  if (projected.type === "existing") return projected.session
  const session = yield* dependencies.store.get(sessionID)
  if (!session) return yield* Effect.die(`Session projection missing after create: ${sessionID}`)
  return session
})

export const admitPrompt = Effect.fn("V2Session.prompt")(
  (
    dependencies: {
      readonly db: Database.Interface["db"]
      readonly events: EventV2.Interface
      readonly store: SessionStore.Interface
      readonly content: ContentStore.Interface
      readonly cleanupRevert?: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | BusyError>
      readonly wake?: (admitted: SessionInput.Admitted) => Effect.Effect<void>
    },
    input: PromptInput,
  ) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const session = yield* dependencies.store.get(input.sessionID)
        if (!session) return yield* new NotFoundError({ sessionID: input.sessionID })
        if (session.revert?.status === "blocked")
          return yield* new RollbackBlockedError({ sessionID: input.sessionID })
        if (dependencies.cleanupRevert) yield* dependencies.cleanupRevert(input.sessionID)
        const messageID = input.id ?? SessionMessage.ID.create()
        const delivery = input.delivery ?? "steer"
        const requested = new Prompt({
          ...input.prompt,
          ...(input.agent === undefined ? {} : { agent: input.agent }),
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.system === undefined ? {} : { system: input.system }),
        })
        const existing = input.id === undefined ? undefined : yield* SessionInput.find(dependencies.db, messageID)
        const prompt =
          existing && SessionInput.equivalent(existing, { sessionID: input.sessionID, prompt: requested, delivery })
            ? requested
            : yield* dependencies.content.normalizePrompt({
                sessionID: input.sessionID,
                messageID,
                prompt: requested,
              })
        const expected = { sessionID: input.sessionID, messageID, prompt, delivery }
        const admitted = yield* SessionInput.admit(dependencies.db, dependencies.events, {
          id: messageID,
          sessionID: input.sessionID,
          prompt,
          delivery,
        }).pipe(
          Effect.catchDefect((defect) =>
            defect instanceof SessionInput.LifecycleConflict
              ? new PromptConflictError({ sessionID: input.sessionID, messageID })
              : Effect.die(defect),
          ),
        )
        if (!SessionInput.equivalent(admitted, expected))
          return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
        if (input.resume !== false && dependencies.wake) yield* dependencies.wake(admitted)
        return admitted
      }),
    ),
)

const make = (execution: SessionExecution.Interface) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const store = yield* SessionStore.Service
    const content = yield* ContentStore.Service
    const modelSwitchRunner = Option.getOrUndefined(yield* Effect.serviceOption(SessionRunner.Service))
    const fileMutations = Option.getOrUndefined(yield* Effect.serviceOption(SessionFileMutation.Service))
    const locations = Option.getOrUndefined(yield* Effect.serviceOption(LocationServiceMap))
    const archive = Option.getOrUndefined(yield* Effect.serviceOption(SessionArchive.Service))
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)
    const isDurableSessionEvent = Schema.is(SessionEvent.Durable)
    const operations = KeyedMutex.makeUnsafe<SessionSchema.ID>()

    const enqueueWake = (admitted: SessionInput.Admitted) =>
      execution.wake(admitted.sessionID, admitted.admittedSeq).pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : logFailure("Failed to wake Session", admitted.sessionID, cause),
        ),
        Effect.ignore,
        Effect.asVoid,
      )

    const decode = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
        Effect.mapError(
          () =>
            new MessageDecodeError({
              sessionID: SessionSchema.ID.make(row.session_id),
              messageID: SessionMessage.ID.make(row.id),
            }),
        ),
      )

    const decodeArchived = (sessionID: SessionSchema.ID, row: SessionArchive.MessagePage["rows"][number]) => {
      const data = decodeJSONColumn(row.data)
      return decodeMessage({
        ...(typeof data === "object" && data !== null && !Array.isArray(data) ? data : {}),
        id: row.id,
        type: row.type,
      }).pipe(
        Effect.mapError(
          () =>
            new MessageDecodeError({
              sessionID,
              messageID: SessionMessage.ID.make(String(row.id)),
            }),
        ),
      )
    }

    const archivedInfo = (entry: SessionArchive.CatalogEntry) =>
      Effect.gen(function* () {
        const protectedState = yield* SessionProtection.isProtected(db, entry.sessionID)
        return yield* Effect.try({
          try: () => {
            if (!entry.sessionData) throw new Error("Archive catalog has no Session projection")
            // Catalog `session_data` stores the raw SQLite row (see SessionArchive.refreshCatalog
            // and scanActive), so every SessionTable `text({ mode: "json" })` column arrives as a
            // JSON string. Keep this list in sync with those columns: summary_diffs, metadata,
            // revert, permission, agent_policy, model. Values that are not valid JSON stay
            // untouched here so the schema decode below fails loudly instead of hiding corruption.
            return fromRow(
              {
                ...entry.sessionData,
                summary_diffs: decodeJSONColumn(entry.sessionData.summary_diffs),
                metadata: decodeJSONColumn(entry.sessionData.metadata),
                revert: decodeJSONColumn(entry.sessionData.revert),
                permission: decodeJSONColumn(entry.sessionData.permission),
                agent_policy: decodeJSONColumn(entry.sessionData.agent_policy),
                model: decodeJSONColumn(entry.sessionData.model),
              } as typeof SessionTable.$inferSelect,
              protectedState,
            )
          },
          catch: (cause) =>
            new SessionArchive.IntegrityError({
              sessionID: entry.sessionID,
              message: `Archived Session projection cannot be decoded: ${String(cause)}`,
            }),
        }).pipe(Effect.orDie)
      })

    const activate = Effect.fn("V2Session.activateArchived")(function* (sessionID: SessionSchema.ID) {
      if (!archive) return false
      const entry = yield* archive
        .getCatalog(sessionID)
        .pipe(Effect.catchTag("SessionArchive.NotFoundError", () => Effect.succeed(undefined)))
      if (entry?.location !== "archived") return false
      yield* archive.ensureActive(sessionID).pipe(
        Effect.catchTag("SessionArchive.NotFoundError", () => new NotFoundError({ sessionID })),
        Effect.catchTag("SessionArchive.IntegrityError", (error) => Effect.die(error)),
      )
      return true
    })

    const assertNotBusy = Effect.fn("V2Session.assertNotBusy")(function* (sessionID: SessionSchema.ID) {
      const running = yield* db
        .select({ id: SessionActivityTable.id })
        .from(SessionActivityTable)
        .where(
          and(
            eq(SessionActivityTable.session_id, sessionID),
            inArray(SessionActivityTable.status, ["running", "recovering"]),
            gt(SessionActivityTable.lease_until, Date.now()),
          ),
        )
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (running) return yield* new BusyError({ sessionID })
    })

    const cleanupRevert = Effect.fn("V2Session.cleanupRevert")(function* (sessionID: SessionSchema.ID) {
      const session = yield* result.get(sessionID)
      if (!session.revert) return
      yield* assertNotBusy(sessionID)
      if (session.revert.status !== "reverted" || !session.revert.fileAction) return
      const target = yield* db
        .select({ seq: SessionMessageTable.seq })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.id, SessionMessage.ID.make(session.revert.messageID)),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      const messageIDs = target
        ? yield* db
            .select({ id: SessionMessageTable.id })
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.session_id, sessionID),
                session.revert.partID
                  ? gt(SessionMessageTable.seq, target.seq)
                  : gte(SessionMessageTable.seq, target.seq),
              ),
            )
            .all()
            .pipe(
              Effect.orDie,
              Effect.map((rows) => rows.map((row) => row.id)),
            )
        : []
      yield* events.publish(SessionEvent.Revert.Cleaned, {
        sessionID,
        timestamp: yield* DateTime.now,
        revert: session.revert,
        messageIDs,
      })
    })

    const markRevert = Effect.fn("V2Session.markRevert")(function* (input: RevertInput) {
      const session = yield* result.get(input.sessionID)
      const messages = yield* result.messages({ sessionID: input.sessionID, order: "asc" }).pipe(Effect.orDie)
      const targetIndex = messages.findIndex((message) => message.id === input.messageID)
      if (targetIndex < 0) return session
      const target = messages[targetIndex]
      const lastUser = messages.slice(0, targetIndex + 1).findLast((message) => message.type === "user")
      const revert = resolveRevert(target, input.partID, lastUser)
      if (!revert) return session
      if (
        session.revert?.status === "reverted" && session.revert.fileAction &&
        session.revert.messageID === revert.messageID && session.revert.partID === revert.partID
      ) return session
      const messagesOnly = input.files === "messages_only" || session.revert?.fileAction === "messages_only"
      const restored =
        messagesOnly
          ? undefined
          : fileMutations
            ? yield* fileMutations.revert({
                sessionID: input.sessionID, revert,
                from: session.revert?.fileAction === "journal"
                  ? session.revert : undefined,
              })
            : undefined
      // A failed transition has not changed files. Keep the applied checkpoint
      // so retry and unrevert still know which journal range is actually restored.
      if (restored?.conflicts.length && session.revert?.fileAction === "journal")
        return yield* new RollbackBlockedError({ sessionID: input.sessionID })
      const next =
        messagesOnly
          ? { ...revert, status: "reverted" as const, fileAction: "messages_only" as const }
          : restored
            ? restored.conflicts.length > 0
              ? {
                  ...revert,
                  status: "blocked" as const,
                  blockedReason: "conflict" as const,
                  conflicts: restored.conflicts,
                  repair: { status: "not_started" as const, attempts: 0 },
                }
              : restored.mutations > 0
                ? { ...revert, status: "reverted" as const, fileAction: "journal" as const }
                : { ...revert, status: "blocked" as const, blockedReason: "unattributed" as const }
            : { ...revert, status: "blocked" as const, blockedReason: "unattributed" as const }
      yield* events.publish(SessionEvent.Revert.Marked, {
        sessionID: input.sessionID,
        timestamp: yield* DateTime.now,
        revert: next,
      })
      return yield* result.get(input.sessionID)
    })

    const validateRollbackTarget = Effect.fn("V2Session.validateRollbackTarget")(function* (input: RevertInput) {
      const messages = yield* result.messages({ sessionID: input.sessionID, order: "asc" }).pipe(Effect.orDie)
      const targetIndex = messages.findIndex((message) => message.id === input.messageID)
      if (targetIndex < 0)
        return yield* new RollbackTargetError({
          sessionID: input.sessionID,
          messageID: input.messageID,
          partID: input.partID,
          reason: "message",
        })
      if (input.partID === undefined) return
      const target = messages[targetIndex]
      if (target.type === "assistant" && target.content.some((item) => item.id === input.partID)) return
      return yield* new RollbackTargetError({
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: input.partID,
        reason: "part",
      })
    })

    const result = Service.of({
      create: (input) => {
        if (!archive) return createSession({ db, events, projects, store }, input)
        if (!input.id) return createSession({ db, events, projects, store }, input)
        const sessionID = input.id
        return operations.withLock(sessionID)(
          activate(sessionID).pipe(
            Effect.flatMap((reactivated) =>
              Effect.gen(function* () {
                const session = yield* store.get(sessionID)
                if (session) return session
                if (reactivated)
                  return yield* Effect.die(`Session projection missing after archive reactivation: ${sessionID}`)
                return yield* createSession({ db, events, projects, store }, { ...input, id: sessionID })
              }),
            ),
            Effect.catchTag("Session.NotFoundError", (error) => Effect.die(error)),
          ),
        )
      },
      get: Effect.fn("V2Session.get")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (session) return session
        if (!archive) return yield* new NotFoundError({ sessionID })
        const entry = yield* archive
          .getCatalog(sessionID)
          .pipe(Effect.catchTag("SessionArchive.NotFoundError", () => new NotFoundError({ sessionID })))
        return yield* archivedInfo(entry)
      }),
      list: Effect.fn("V2Session.list")(function* (input = {}) {
        const direction = input.anchor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const sortColumn = SessionTable.time_created
        const conditions: SQL[] = []
        if ("directory" in input) conditions.push(eq(SessionTable.directory, input.directory))
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        if ("project" in input) conditions.push(eq(SessionTable.project_id, input.project))
        if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
        if (!input.includeHidden) conditions.push(hiddenMetadataFilter)
        if (input.anchor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), gt(SessionTable.id, input.anchor.id)),
                )!
              : or(
                  lt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), lt(SessionTable.id, input.anchor.id)),
                )!,
          )
        }
        const query = db
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(sortColumn) : desc(sortColumn),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        const protectedSet = yield* SessionProtection.protectedIDs(
          db,
          rows.map((row) => row.id),
        )
        if (!archive)
          return (direction === "previous" ? rows.toReversed() : rows).map((row) =>
            fromRow(row, protectedSet.has(row.id)),
          )

        const target = input.limit ?? Number.POSITIVE_INFINITY
        const collect = (
          anchor: SessionArchive.CatalogAnchor | undefined,
          accepted: ReadonlyArray<SessionArchive.CatalogEntry>,
        ): Effect.Effect<ReadonlyArray<SessionArchive.CatalogEntry>> =>
          archive
            .listCatalog({
              ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }),
              ...(input.search === undefined ? {} : { search: input.search }),
              ...("directory" in input ? { directory: input.directory } : {}),
              ...("project" in input ? { projectID: input.project } : {}),
              location: "archived",
              ...(input.includeHidden === undefined ? {} : { includeHidden: input.includeHidden }),
              order: order === "asc" ? "created-asc" : "created-desc",
              ...(anchor ? { anchor } : {}),
              limit: Number.isFinite(target) ? Math.max(1, Math.min(target - accepted.length, 500)) : 500,
            })
            .pipe(
              Effect.flatMap((page) => {
                const next = [...accepted, ...page.rows]
                if (next.length >= target || !page.hasMore || !page.nextAnchor) return Effect.succeed(next)
                return collect(page.nextAnchor, next)
              }),
            )
        const archived = yield* collect(
          input.anchor
            ? {
                sessionID: input.anchor.id,
                timeCreated: input.anchor.time,
                timeLastModified: 0,
                title: "",
              }
            : undefined,
          [],
        )
        const active = rows.map((row) => ({
          time: row.time_created,
          id: row.id,
          value: fromRow(row, protectedSet.has(row.id)),
        }))
        const stored = yield* Effect.forEach(archived, (entry) =>
          archivedInfo(entry).pipe(Effect.map((value) => ({ time: entry.timeCreated, id: entry.sessionID, value }))),
        )
        const sorted = [...active, ...stored].toSorted((left, right) => {
          const value = left.time - right.time || left.id.localeCompare(right.id)
          return order === "asc" ? value : -value
        })
        const merged = (input.limit === undefined ? sorted : sorted.slice(0, input.limit)).map((entry) => entry.value)
        return direction === "previous" ? merged.toReversed() : merged
      }),
      messages: Effect.fn("V2Session.messages")(function* (input) {
        const active = yield* store.get(input.sessionID)
        if (!active && archive) {
          const rows = yield* archive
            .readMessages(input.sessionID, {
              ...(input.limit === undefined ? {} : { limit: input.limit }),
              ...(input.order === undefined ? {} : { order: input.order }),
              ...(input.cursor === undefined
                ? {}
                : {
                    cursor: {
                      messageID: input.cursor.id,
                      direction: input.cursor.direction,
                    },
                  }),
            })
            .pipe(
              Effect.map((page) => page.rows),
              Effect.catchTag("SessionArchive.NotFoundError", (error) =>
                error.itemID ? Effect.succeed([]) : Effect.fail(new NotFoundError({ sessionID: input.sessionID })),
              ),
              Effect.catchTag("SessionArchive.IntegrityError", (error) => Effect.die(error)),
            )
          return yield* Effect.forEach(rows, (row) => decodeArchived(input.sessionID, row))
        }
        if (!active) return yield* new NotFoundError({ sessionID: input.sessionID })
        const direction = input.cursor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const anchor = input.cursor
          ? yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.cursor.id)),
              )
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (input.cursor && !anchor) return []
        const boundary = anchor
          ? order === "asc"
            ? gt(SessionMessageTable.seq, anchor.seq)
            : lt(SessionMessageTable.seq, anchor.seq)
          : undefined
        const where = boundary
          ? and(eq(SessionMessageTable.session_id, input.sessionID), boundary)
          : eq(SessionMessageTable.session_id, input.sessionID)
        const query = db
          .select()
          .from(SessionMessageTable)
          .where(where)
          .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return yield* Effect.forEach(direction === "previous" ? rows.toReversed() : rows, decode)
      }),
      messageContext: Effect.fn("V2Session.messageContext")(function* (input) {
        if (!(yield* store.get(input.sessionID))) return []
        const anchor = yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.before)))
          .get()
          .pipe(Effect.orDie)
        if (!anchor) return []
        const parent = yield* db
          .select()
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, input.sessionID),
              lt(SessionMessageTable.seq, anchor.seq),
              inArray(SessionMessageTable.type, ["user", "compaction", "synthetic", "shell"]),
            ),
          )
          .orderBy(desc(SessionMessageTable.seq))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        const state = yield* Effect.all([
          db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.session_id, input.sessionID),
                lt(SessionMessageTable.seq, parent?.seq ?? anchor.seq),
                eq(SessionMessageTable.type, "agent-switched"),
              ),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie),
          db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.session_id, input.sessionID),
                lt(SessionMessageTable.seq, parent?.seq ?? anchor.seq),
                eq(SessionMessageTable.type, "model-switched"),
              ),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie),
        ])
        return yield* Effect.forEach(
          [parent, ...state]
            .filter((row): row is NonNullable<typeof row> => row !== undefined)
            .toSorted((a, b) => a.seq - b.seq),
          decode,
        )
      }),
      message: Effect.fn("V2Session.message")(function* (input) {
        const stored = yield* store.message(input.messageID)
        if (stored?.sessionID === input.sessionID) return stored.message
        if (!archive) return
        const row = yield* archive.readMessage(input.sessionID, input.messageID).pipe(
          Effect.catchTag("SessionArchive.NotFoundError", () => Effect.succeed(undefined)),
          Effect.catchTag("SessionArchive.IntegrityError", (error) => Effect.die(error)),
        )
        if (!row) return
        return yield* decodeArchived(input.sessionID, row).pipe(Effect.orDie)
      }),
      context: Effect.fn("V2Session.context")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* store.context(sessionID)
      }),
      events: (input) =>
        Stream.unwrap(
          result
            .get(input.sessionID)
            .pipe(Effect.as(events.aggregateEvents({ aggregateID: input.sessionID, after: input.after }))),
        ).pipe(
          Stream.filter((event): event is EventV2.CursorEvent<SessionEvent.DurableEvent> =>
            isDurableSessionEvent(event.event),
          ),
        ),
      prompt: (input) =>
        operations.withLock(input.sessionID)(
          activate(input.sessionID).pipe(
            Effect.andThen(admitPrompt({ db, events, store, content, cleanupRevert, wake: enqueueWake }, input)),
          ),
        ),
      synthetic: (input) =>
        operations.withLock(input.sessionID)(
          activate(input.sessionID).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                yield* result.get(input.sessionID)
                yield* events.publish(SessionEvent.Synthetic, {
                  sessionID: input.sessionID,
                  messageID: input.id ?? SessionMessage.ID.create(),
                  timestamp: yield* DateTime.now,
                  text: input.text,
                })
              }),
            ),
          ),
        ),
      revert: (input) =>
        operations.withLock(input.sessionID)(
          Effect.gen(function* () {
            yield* activate(input.sessionID)
            yield* result.get(input.sessionID)
            yield* assertNotBusy(input.sessionID)
            return yield* markRevert(input)
          }),
        ),
      rollback: (input) =>
        operations.withLock(input.sessionID)(
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* activate(input.sessionID)
              const current = yield* result.get(input.sessionID)
              yield* validateRollbackTarget(input)
              yield* result.interrupt(input.sessionID)
              yield* execution.wait(input.sessionID)
              if (locations) {
                yield* QuestionV2.Service.use((questions) => questions.dismissSession(input.sessionID)).pipe(
                  Effect.provide(locations.get(current.location)),
                )
              }
              // Keep the range available to unrevert and the recovery tray. Admission
              // commits the removal only when the user sends a replacement prompt.
              return yield* markRevert(input)
            }),
          ),
        ),
      unrevert: (input) =>
        operations.withLock(input.sessionID)(
          activate(input.sessionID).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const session = yield* result.get(input.sessionID)
                yield* assertNotBusy(input.sessionID)
                if (!session.revert) return session
                if (session.revert.status === "blocked" && session.revert.fileAction !== "journal") return session
                if (session.revert.status === "reverted" && session.revert.fileAction === undefined) {
                  yield* events.publish(SessionEvent.Revert.Marked, {
                    sessionID: input.sessionID,
                    timestamp: yield* DateTime.now,
                    revert: { ...session.revert, status: "blocked", blockedReason: "unattributed" },
                  })
                  return yield* result.get(input.sessionID)
                }
                if (session.revert.status !== "reverted" && session.revert.fileAction !== "journal") {
                  yield* events.publish(SessionEvent.Revert.Marked, {
                    sessionID: input.sessionID,
                    timestamp: yield* DateTime.now,
                    revert: { ...session.revert, status: "blocked", blockedReason: "unattributed" },
                  })
                  return yield* result.get(input.sessionID)
                }
                if (
                  session.revert.fileAction !== "messages_only" &&
                  !fileMutations
                ) {
                  yield* events.publish(SessionEvent.Revert.Marked, {
                    sessionID: input.sessionID,
                    timestamp: yield* DateTime.now,
                    revert: { ...session.revert, status: "blocked", blockedReason: "unattributed" },
                  })
                  return yield* result.get(input.sessionID)
                }
                if (
                  fileMutations &&
                  session.revert.fileAction !== "messages_only"
                ) {
                  const restored = yield* fileMutations.unrevert({ sessionID: input.sessionID, revert: session.revert })
                  if (restored.conflicts.length > 0) {
                    yield* events.publish(SessionEvent.Revert.Marked, {
                      sessionID: input.sessionID,
                      timestamp: yield* DateTime.now,
                      revert: {
                        ...session.revert,
                        status: "blocked",
                        blockedReason: "conflict",
                        conflicts: restored.conflicts,
                        repair: session.revert.repair ?? { status: "not_started", attempts: 0 },
                      },
                    })
                    return yield* result.get(input.sessionID)
                  }
                  // A verified transition can end beyond the final journaled write.
                  // Unrevert then clears the message marker without changing files.
                  if (restored.mutations === 0 && !restored.verifiedEmpty) {
                    yield* events.publish(SessionEvent.Revert.Marked, {
                      sessionID: input.sessionID,
                      timestamp: yield* DateTime.now,
                      revert: { ...session.revert, status: "blocked", blockedReason: "unattributed" },
                    })
                    return yield* result.get(input.sessionID)
                  }
                }
                yield* events.publish(SessionEvent.Revert.Cleared, {
                  sessionID: input.sessionID,
                  timestamp: yield* DateTime.now,
                })
                return yield* result.get(input.sessionID)
              }),
            ),
          ),
        ),
      cleanupRevert: (sessionID) =>
        operations.withLock(sessionID)(activate(sessionID).pipe(Effect.andThen(cleanupRevert(sessionID)))),
      shell: (input) =>
        operations.withLock(input.sessionID)(
          activate(input.sessionID).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const session = yield* result.get(input.sessionID)
                if (!locations) return yield* new OperationUnavailableError({ operation: "shell" })
                const messageID = SessionMessage.ID.create()
                const callID = crypto.randomUUID()
                yield* events.publish(SessionEvent.Shell.Started, {
                  sessionID: input.sessionID,
                  messageID,
                  callID,
                  command: input.command,
                  timestamp: yield* DateTime.now,
                })
                const exit = yield* ToolRegistry.Service.use((registry) =>
                  registry.materialize().pipe(
                    Effect.flatMap((materialization) =>
                      materialization.settle({
                        sessionID: input.sessionID,
                        agent: input.agent ?? session.agent ?? AgentV2.ID.make("build"),
                        assistantMessageID: messageID,
                        call: {
                          type: "tool-call",
                          id: callID,
                          name: BashTool.name,
                          input: { command: input.command },
                        },
                      }),
                    ),
                  ),
                ).pipe(Effect.provide(locations.get(session.location)), Effect.exit)
                yield* events.publish(SessionEvent.Shell.Ended, {
                  sessionID: input.sessionID,
                  callID,
                  output: exit._tag === "Success" ? shellSettlementText(exit.value) : Cause.pretty(exit.cause),
                  timestamp: yield* DateTime.now,
                })
              }),
            ),
          ),
        ),
      skill: Effect.fn("V2Session.skill")(function* () {
        return yield* new OperationUnavailableError({ operation: "skill" })
      }),
      switchAgent: (input) =>
        operations.withLock(input.sessionID)(
          activate(input.sessionID).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const current = yield* result.get(input.sessionID)
                // Re-affirming the stored selection (composer restore, desktop-testing
                // status checks) must not interrupt a running turn: the switch would
                // surface as a user stop while nothing actually changed.
                if (isSameAgentSelection(current.agent, current.model, input.agent, input.model)) return
                yield* SessionInput.holdPending(db, events, input.sessionID)
                yield* result.interrupt(input.sessionID)
                yield* execution.wait(input.sessionID)
                yield* events.publish(SessionEvent.AgentSwitched, {
                  sessionID: input.sessionID,
                  messageID: SessionMessage.ID.create(),
                  timestamp: yield* DateTime.now,
                  agent: input.agent,
                })
                if (input.model)
                  yield* events.publish(SessionEvent.ModelSwitched, {
                    sessionID: input.sessionID,
                    messageID: SessionMessage.ID.create(),
                    timestamp: yield* DateTime.now,
                    model: input.model,
                  })
              }),
            ),
            Effect.asVoid,
          ),
        ),
      heldInputs: (sessionID) =>
        operations.withLock(sessionID)(
          activate(sessionID).pipe(
            Effect.andThen(result.get(sessionID)),
            Effect.andThen(SessionInput.held(db, sessionID)),
          ),
        ),
      releaseInput: (input) =>
        operations.withLock(input.sessionID)(
          Effect.gen(function* () {
            yield* activate(input.sessionID)
            const current = yield* result.get(input.sessionID)
            const admitted = yield* SessionInput.find(db, input.inputID)
            if (!admitted || admitted.sessionID !== input.sessionID) return
            const released = yield* SessionInput.release(db, events, {
              id: input.inputID,
              sessionID: input.sessionID,
              prompt: new Prompt({
                ...admitted.prompt,
                ...(current.agent ? { agent: current.agent } : {}),
                ...(current.model ? { model: current.model } : {}),
              }),
            })
            if (released) yield* enqueueWake(released)
            return released
          }),
        ),
      switchModel: (input) =>
        operations.withLock(input.sessionID)(
          activate(input.sessionID).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const current = yield* result.get(input.sessionID)
                const runner = modelSwitchRunner
                if (runner && locations) {
                  const active = yield* db
                    .select({ id: SessionActivityTable.id })
                    .from(SessionActivityTable)
                    .where(
                      and(
                        eq(SessionActivityTable.session_id, input.sessionID),
                        inArray(SessionActivityTable.status, ["running", "recovering"]),
                        gt(SessionActivityTable.lease_until, Date.now()),
                      ),
                    )
                    .limit(1)
                    .get()
                    .pipe(Effect.orDie)
                  if (!active) {
                    yield* Effect.gen(function* () {
                      if (!(yield* runner.requiresModelSwitchCompaction(input))) return
                      yield* runner.prepareModelSwitch(input)
                    }).pipe(Effect.provide(locations.get(current.location)))
                  }
                }
                yield* events.publish(SessionEvent.ModelSwitched, {
                  sessionID: input.sessionID,
                  messageID: SessionMessage.ID.create(),
                  timestamp: yield* DateTime.now,
                  model: input.model,
                })
              }),
            ),
            Effect.asVoid,
          ),
        ),
      switchAgentAndPrompt: (input) =>
        operations.withLock(input.sessionID)(
          activate(input.sessionID).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const current = yield* result.get(input.sessionID)
                if (!locations) return yield* new OperationUnavailableError({ operation: "switchAgent" })
                const locationLayer = locations.get(current.location)
                const target = yield* AgentV2.Service.use((agents) => agents.get(AgentV2.ID.make(input.agent))).pipe(
                  Effect.provide(locationLayer),
                )
                if (!target)
                  return yield* new AgentTransitionError({
                    sessionID: input.sessionID,
                    agent: input.agent,
                    reason: "not_found",
                  })
                if (target.hidden)
                  return yield* new AgentTransitionError({
                    sessionID: input.sessionID,
                    agent: input.agent,
                    reason: "hidden",
                  })
                if (target.mode === "subagent")
                  return yield* new AgentTransitionError({
                    sessionID: input.sessionID,
                    agent: input.agent,
                    reason: "subagent",
                  })
                const model = input.model ? overrideModel(current.model, input.model) : undefined
                if (model) {
                  yield* SessionRunnerModel.Service.use((models) =>
                    models.resolve({ ...current, agent: target.id, model }),
                  ).pipe(
                    Effect.provide(locationLayer),
                    Effect.mapError(
                      () =>
                        new AgentTransitionError({
                          sessionID: input.sessionID,
                          agent: input.agent,
                          reason: "model_unavailable",
                        }),
                    ),
                  )
                }
                return yield* admitPrompt(
                  { db, events, store, content, cleanupRevert, wake: enqueueWake },
                  {
                    sessionID: input.sessionID,
                    prompt: new Prompt({ ...input.prompt, agent: target.id, model }),
                    agent: target.id,
                    model,
                  },
                )
              }),
            ),
          ),
        ),
      setTitle: (input) =>
        operations.withLock(input.sessionID)(
          activate(input.sessionID).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                yield* result.get(input.sessionID)
                yield* events.publish(SessionEvent.TitleUpdated, {
                  sessionID: input.sessionID,
                  timestamp: yield* DateTime.now,
                  title: input.title,
                })
              }),
            ),
            Effect.asVoid,
          ),
        ),
      patchMetadata: (input) =>
        operations.withLock(input.sessionID)(
          activate(input.sessionID).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                yield* result.get(input.sessionID)
                yield* events.publish(SessionEvent.MetadataPatched, {
                  sessionID: input.sessionID,
                  timestamp: yield* DateTime.now,
                  ...input.patch,
                })
              }),
            ),
            Effect.asVoid,
          ),
        ),
      setShare: (input) =>
        operations.withLock(input.sessionID)(
          activate(input.sessionID).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                yield* result.get(input.sessionID)
                yield* events.publish(SessionEvent.ShareUpdated, {
                  sessionID: input.sessionID,
                  timestamp: yield* DateTime.now,
                  share: input.share,
                })
              }),
            ),
            Effect.asVoid,
          ),
        ),
      setSummary: (input) =>
        operations.withLock(input.sessionID)(
          activate(input.sessionID).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                yield* result.get(input.sessionID)
                yield* events.publish(SessionEvent.SummaryUpdated, {
                  sessionID: input.sessionID,
                  timestamp: yield* DateTime.now,
                  summary: input.summary,
                })
              }),
            ),
            Effect.asVoid,
          ),
        ),
      compact: (input): Effect.Effect<undefined, MessageDecodeError | SummaryFailed | NotFoundError, never> =>
        operations.withLock(input.sessionID)(
          activate(input.sessionID).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const session = yield* store.get(input.sessionID)
                if (!session) return yield* Effect.die(`Session not found: ${input.sessionID}`)
                const summarize = Effect.gen(function* () {
                  const llm = Option.getOrUndefined(yield* Effect.serviceOption(LLMClient.Service))
                  const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
                  const models = Option.getOrUndefined(yield* Effect.serviceOption(SessionRunnerModel.Service))
                  if (!llm || !config || !models)
                    return yield* Effect.fail(
                      new SessionCompaction.SummaryFailed({
                        sessionID: input.sessionID,
                        reason: "no summarizer model chain is available in this process",
                      }),
                    )
                  const model = yield* models.resolve(session).pipe(
                    Effect.mapError((error) => new SessionCompaction.SummaryFailed({
                      sessionID: input.sessionID,
                      reason: `summarizer model resolution failed: ${error.message}`,
                    })),
                  )
                  const compaction = SessionCompaction.make({
                    events,
                    llm,
                    config: yield* config.entries(),
                    loadCurrent: (sessionID) =>
                      Effect.all({
                        entries: SessionHistory.currentEntriesForRunner(db, sessionID),
                        todos: SessionTodo.load(db, sessionID),
                      }),
                  })
                  yield* compaction.compactManual({
                    sessionID: input.sessionID,
                    model,
                    request: LLM.request({ model, messages: [], tools: [] }),
                    entries: [],
                  }).pipe(Effect.catchTag("LLM.Error", (error) => Effect.fail(new SessionCompaction.SummaryFailed({
                    sessionID: input.sessionID,
                    reason: `LLM error during manual compaction: ${error.message}`,
                  }))))
                })
                yield* locations ? summarize.pipe(Effect.provide(locations.get(session.location))) : summarize
              }),
            ),
          ),
        ),
      wait: Effect.fn("V2Session.wait")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.wait(sessionID)
      }),
      resume: (sessionID) =>
        operations
          .withLock(sessionID)(activate(sessionID).pipe(Effect.andThen(result.get(sessionID))))
          .pipe(
            Effect.andThen(execution.resume(sessionID)),
            Effect.catchTag("SessionRunner.UserDeclinedError", () => Effect.interrupt),
          ),
      interrupt: Effect.fn("V2Session.interrupt")((sessionID) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const session = yield* store.get(sessionID)
            if (!session) {
              yield* Perf.record({ kind: "interrupt", sessionID, phase: "missing_session" }, "interrupts")
              return yield* execution.interrupt(sessionID)
            }
            const event = yield* events.publish(SessionEvent.InterruptRequested, {
              sessionID,
              timestamp: yield* DateTime.now,
            })
            if (event.seq === undefined)
              return yield* Effect.die("Interrupt request event is missing aggregate sequence")
            yield* Perf.record({ kind: "interrupt", sessionID, phase: "requested", event_seq: event.seq }, "interrupts")
            yield* execution.interrupt(sessionID, event.seq)
          }),
        ),
      ),
    })

    return result
  })

export const layerWithExecution = (execution: SessionExecution.Interface) => Layer.effect(Service, make(execution))

export const layer = Layer.effect(Service, SessionExecution.Service.pipe(Effect.flatMap(make)))

function resolveRevert(
  target: SessionMessage.Message,
  partID: string | undefined,
  lastUser: SessionMessage.Message | undefined,
): SessionSchema.Revert | undefined {
  if (partID === undefined) {
    return { messageID: target.type === "assistant" && lastUser ? lastUser.id : target.id }
  }
  if (target.type !== "assistant") return undefined
  const partIndex = target.content.findIndex((item) => item.id === partID)
  if (partIndex < 0) return undefined
  const keepPartialAssistant = target.content
    .slice(0, partIndex)
    .some((item) => item.type === "text" || item.type === "tool")
  if (!keepPartialAssistant) return { messageID: lastUser ? lastUser.id : target.id }
  return { messageID: target.id, partID }
}

function shellSettlementText(settlement: ToolRegistry.Settlement) {
  const content: ReadonlyArray<ToolContent> =
    settlement.output?.content ?? (settlement.result.type === "content" ? settlement.result.value : [])
  const text = content.flatMap((item) => (item.type === "text" ? [item.text] : [`[file] ${item.name ?? item.uri}`]))
  if (text.length > 0) return text.join("\n")
  if (settlement.result.type === "error" || settlement.result.type === "text") return String(settlement.result.value)
  return JSON.stringify(settlement.result.value) ?? String(settlement.result.value)
}

// Re-affirming the stored selection (composer restore, status checks) must not
// interrupt: same agent plus the same effective chain selection would continue
// identically. The request resolves through the existing override contract
// first — a request without a chain keeps the stored chain (chain
// preservation), while a request carrying its own chain or another variant is
// a real switch.
function isSameAgentSelection(
  agent: string | undefined,
  model: ModelV2.Ref | undefined,
  nextAgent: string,
  nextModel: ModelV2.Ref | undefined,
) {
  if (agent !== nextAgent) return false
  if (!nextModel) return true
  if (!model) return false
  return sameChainSelection(model, overrideModel(model, nextModel))
}

function decodeJSONColumn(value: unknown) {
  if (typeof value !== "string") return value
  return Option.getOrElse(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(value), () => value)
}

export const defaultLayer = layer.pipe(
  Layer.provide(ContentStore.defaultLayer),
  Layer.provide(SessionFileMutation.defaultLayer),
  Layer.provide(SessionExecution.noopLayer),
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(SessionProjector.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(ProjectV2.defaultLayer),
  Layer.orDie,
)
