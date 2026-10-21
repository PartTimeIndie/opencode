export * as SessionProjector from "./projector"

import { and, desc, eq, gt, gte, inArray, lt, sql } from "drizzle-orm"
import { DateTime, Effect, Layer, Option, Schema } from "effect"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { EventCheckpointTable, EventSequenceTable } from "../event/sql"
import { LayerNode } from "../effect/layer-node"
import { SessionEvent } from "./event"
import { SessionV1 } from "../v1/session"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import { ProjectTable } from "../project/sql"
import { SessionMessage } from "./message"
import { SessionMessageUpdater } from "./message-updater"
import { SessionSchema } from "./schema"
import { SessionInput } from "./input"
import { SessionPlanDocument } from "./plan-document"
import { WorkspaceV2 } from "../workspace"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"
import { SessionContextEpoch } from "./context-epoch"
import {
  MessageTable,
  PartTable,
  SessionContextEpochTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
} from "./sql"
import { AbsolutePath, type DeepMutable } from "../schema"
import { IsolatedWorker } from "../isolated-worker"
import { boundedPersistedContentPreview, MAX_PERSISTED_CONTENT_PREVIEW_BYTES } from "../content-preview"
import { CheckpointVerificationTransport } from "../checkpoint-verification-transport"

type DatabaseService = Database.Interface["db"]
type ProjectionDatabase = Pick<DatabaseService, "select">

const projectionCheckpointVersion = 2
export const CheckpointAdapterID = "session-v2-projection"
export const CheckpointAdapterVersion = 4
export function canRestoreCheckpointVersion(version: number) {
  return [1, projectionCheckpointVersion, 3, CheckpointAdapterVersion].includes(version)
}
export function hasCheckpointLegacyProjection(version: number) {
  return [projectionCheckpointVersion, 3, CheckpointAdapterVersion].includes(version)
}
const checkpointAdapterID = CheckpointAdapterID
const checkpointAdapterVersion = CheckpointAdapterVersion
const legacyCheckpointOnlyVersion = 1
const activeProjectionReferenceVersion = 1
const activeProjectionReferenceKey = "legacyProjectionReference"
const sessionCreatedType = SessionV1.Event.Created.sync
  ? EventV2.versionedType(SessionV1.Event.Created.type, SessionV1.Event.Created.sync.version)
  : undefined
const sessionPromptedType = SessionEvent.Prompted.sync
  ? EventV2.versionedType(SessionEvent.Prompted.type, SessionEvent.Prompted.sync.version)
  : undefined
const sessionUpdatedType = SessionV1.Event.Updated.sync
  ? EventV2.versionedType(SessionV1.Event.Updated.type, SessionV1.Event.Updated.sync.version)
  : undefined
const legacyMessageUpdatedType = SessionV1.Event.MessageUpdated.sync
  ? EventV2.versionedType(SessionV1.Event.MessageUpdated.type, SessionV1.Event.MessageUpdated.sync.version)
  : undefined
const legacyPartUpdatedType = SessionV1.Event.PartUpdated.sync
  ? EventV2.versionedType(SessionV1.Event.PartUpdated.type, SessionV1.Event.PartUpdated.sync.version)
  : undefined
const legacyPartRemovedType = SessionV1.Event.PartRemoved.sync
  ? EventV2.versionedType(SessionV1.Event.PartRemoved.type, SessionV1.Event.PartRemoved.sync.version)
  : undefined
const stepStartedType = SessionEvent.Step.Started.sync
  ? EventV2.versionedType(SessionEvent.Step.Started.type, SessionEvent.Step.Started.sync.version)
  : undefined
const stepEndedType = SessionEvent.Step.Ended.sync
  ? EventV2.versionedType(SessionEvent.Step.Ended.type, SessionEvent.Step.Ended.sync.version)
  : undefined
const textStartedType = SessionEvent.Text.Started.sync
  ? EventV2.versionedType(SessionEvent.Text.Started.type, SessionEvent.Text.Started.sync.version)
  : undefined
const textEndedType = SessionEvent.Text.Ended.sync
  ? EventV2.versionedType(SessionEvent.Text.Ended.type, SessionEvent.Text.Ended.sync.version)
  : undefined
const reasoningStartedType = SessionEvent.Reasoning.Started.sync
  ? EventV2.versionedType(SessionEvent.Reasoning.Started.type, SessionEvent.Reasoning.Started.sync.version)
  : undefined
const reasoningEndedType = SessionEvent.Reasoning.Ended.sync
  ? EventV2.versionedType(SessionEvent.Reasoning.Ended.type, SessionEvent.Reasoning.Ended.sync.version)
  : undefined
const toolInputStartedType = SessionEvent.Tool.Input.Started.sync
  ? EventV2.versionedType(SessionEvent.Tool.Input.Started.type, SessionEvent.Tool.Input.Started.sync.version)
  : undefined
const toolInputEndedType = SessionEvent.Tool.Input.Ended.sync
  ? EventV2.versionedType(SessionEvent.Tool.Input.Ended.type, SessionEvent.Tool.Input.Ended.sync.version)
  : undefined
const toolCalledType = SessionEvent.Tool.Called.sync
  ? EventV2.versionedType(SessionEvent.Tool.Called.type, SessionEvent.Tool.Called.sync.version)
  : undefined
const toolSuccessType = SessionEvent.Tool.Success.sync
  ? EventV2.versionedType(SessionEvent.Tool.Success.type, SessionEvent.Tool.Success.sync.version)
  : undefined
const toolFailedV1Type = EventV2.versionedType(SessionEvent.Tool.Failed.type, 1)
const toolFailedType = SessionEvent.Tool.Failed.sync
  ? EventV2.versionedType(SessionEvent.Tool.Failed.type, SessionEvent.Tool.Failed.sync.version)
  : undefined
const activityFailedV1Type = EventV2.versionedType(SessionEvent.Activity.Failed.type, 1)
const activityFailedV2Type = EventV2.versionedType(SessionEvent.Activity.Failed.type, 2)
const legacyChildEventTypes = new Set<string>(
  [
    SessionV1.Event.MessageUpdated,
    SessionV1.Event.MessageRemoved,
    SessionV1.Event.PartUpdated,
    SessionV1.Event.PartRemoved,
  ].flatMap((event) => event.sync ? [EventV2.versionedType(event.type, event.sync.version)] : []),
)

type SessionProjection = {
  readonly session: typeof SessionTable.$inferSelect
  readonly legacyMessages: ReadonlyArray<typeof MessageTable.$inferSelect>
  readonly legacyParts: ReadonlyArray<typeof PartTable.$inferSelect>
  readonly messages: ReadonlyArray<typeof SessionMessageTable.$inferSelect>
  readonly inputs: ReadonlyArray<typeof SessionInputTable.$inferSelect>
  readonly contextEpoch?: typeof SessionContextEpochTable.$inferSelect
}

type LegacyCheckpointOnlyEntry = {
  readonly partID: string
  readonly messageID: string
  readonly partDigest: string
  readonly messageDigest: string
}

type LegacyCheckpointOnly = {
  readonly version: typeof legacyCheckpointOnlyVersion
  readonly entries: ReadonlyArray<LegacyCheckpointOnlyEntry>
  readonly digest: string
}

type CheckpointProjection = SessionProjection & {
  readonly legacyCheckpointOnly: LegacyCheckpointOnly
}

type ActiveProjectionReference = {
  readonly version: typeof activeProjectionReferenceVersion
  readonly checkpointSeq: number
  readonly legacyMessageCount: number
  readonly legacyPartCount: number
  readonly messageCount: number
  readonly projectionHash: string
}

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

class PromptAlreadyProjected extends Error {}
export class SessionAlreadyProjected extends Error {}

type Usage = {
  cost: number
  generationMs: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

function usage(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"] | unknown): Usage | undefined {
  if (typeof part !== "object" || part === null) return undefined
  const value = part as Record<string, unknown>
  if (value.type !== "step-finish") return undefined
  if (!("cost" in value) || !("tokens" in value)) return undefined
  return { cost: value.cost as Usage["cost"], generationMs: 0, tokens: value.tokens as Usage["tokens"] }
}

function sameUsage(left: Usage | undefined, right: Usage) {
  return left?.cost === right.cost &&
    left.tokens.input === right.tokens.input &&
    left.tokens.output === right.tokens.output &&
    left.tokens.reasoning === right.tokens.reasoning &&
    left.tokens.cache.read === right.tokens.cache.read &&
    left.tokens.cache.write === right.tokens.cache.write
}

function assistantUsage(message: unknown): Usage | undefined {
  if (typeof message !== "object" || message === null) return
  const value = message as Record<string, unknown>
  if (!("cost" in value) || !("tokens" in value)) return
  const measurement = value.tokenMeasurement as { generationMilliseconds?: unknown } | undefined
  const generationMs = measurement?.generationMilliseconds
  return {
    cost: value.cost as Usage["cost"],
    generationMs:
      typeof generationMs === "number" && Number.isSafeInteger(generationMs) && generationMs >= 0
        ? generationMs
        : 0,
    tokens: value.tokens as Usage["tokens"],
  }
}

function hasV2Usage(
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  messageID: SessionV1.MessageID,
  value: Usage,
) {
  return db
    .select({ data: SessionMessageTable.data })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.id, SessionMessage.ID.make(messageID)),
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "assistant"),
      ),
    )
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => sameUsage(assistantUsage(row?.data), value)),
    )
}

function sessionRow(info: SessionV1.SessionInfo): typeof SessionTable.$inferInsert {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID ?? null,
    parent_id: info.parentID,
    slug: info.slug,
    directory: info.directory,
    path: info.path,
    title: info.title,
    agent: info.agent,
    model: info.model
      ? {
          ...info.model,
           chain: info.model.chain === null
             ? null
             : info.model.chain
               ? { ...info.model.chain, steps: [...info.model.chain.steps] }
               : undefined,
        }
      : undefined,
    version: info.version,
    share_url: info.share?.url,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs ? [...info.summary.diffs] : undefined,
    metadata: info.metadata,
    agent_policy: info.agentPolicy,
    cost: info.cost ?? 0,
    tokens_input: (info.tokens ?? { input: 0 }).input,
    tokens_output: (info.tokens ?? { output: 0 }).output,
    tokens_reasoning: (info.tokens ?? { reasoning: 0 }).reasoning,
    tokens_cache_read: (info.tokens ?? { cache: { read: 0 } }).cache.read,
    tokens_cache_write: (info.tokens ?? { cache: { write: 0 } }).cache.write,
    revert: info.revert ?? null,
    permission: info.permission ? [...info.permission] : undefined,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
  }
}

function messageData(
  info: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["info"],
): typeof MessageTable.$inferInsert.data {
  const { id: _, sessionID: __, ...rest } = info
  return rest as DeepMutable<typeof rest>
}

function partData(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"]): typeof PartTable.$inferInsert.data {
  const { id: _, messageID: __, sessionID: ___, ...rest } = part
  return rest as DeepMutable<typeof rest>
}

function applyUsage(
  db: DatabaseService,
  sessionID: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["sessionID"],
  value: Usage,
  sign = 1,
) {
  return db
    .update(SessionTable)
    .set({
      cost: sql`${SessionTable.cost} + ${value.cost * sign}`,
      tokens_input: sql`${SessionTable.tokens_input} + ${value.tokens.input * sign}`,
      tokens_output: sql`${SessionTable.tokens_output} + ${value.tokens.output * sign}`,
      tokens_reasoning: sql`${SessionTable.tokens_reasoning} + ${value.tokens.reasoning * sign}`,
      tokens_cache_read: sql`${SessionTable.tokens_cache_read} + ${value.tokens.cache.read * sign}`,
      tokens_cache_write: sql`${SessionTable.tokens_cache_write} + ${value.tokens.cache.write * sign}`,
      generation_ms: sql`${SessionTable.generation_ms} + ${value.generationMs * sign}`,
      time_updated: sql`${SessionTable.time_updated}`,
    })
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie)
}

function applyStepUsage(db: DatabaseService, event: SessionEvent.Step.Ended) {
  return Effect.gen(function* () {
    const legacy = yield* db
      .select({ data: PartTable.data })
      .from(PartTable)
      .where(
        and(
          eq(PartTable.session_id, event.data.sessionID),
          eq(PartTable.message_id, SessionV1.MessageID.make(event.data.assistantMessageID)),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    const value = {
      cost: event.data.cost,
      generationMs: event.data.tokenMeasurement?.generationMilliseconds ?? 0,
      tokens: event.data.tokens,
    }
    if (legacy.some((row) => sameUsage(usage(row.data), value))) {
      // Tokens and cost were already counted from the legacy representation, but
      // legacy step-finish parts never carry streaming time. Credit the V2 event's
      // measured generation time once so dual-write history does not lose it.
      if (value.generationMs > 0) {
        yield* db
          .update(SessionTable)
          .set({ generation_ms: sql`${SessionTable.generation_ms} + ${value.generationMs}` })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }
      return
    }
    yield* applyUsage(db, event.data.sessionID, value)
  })
}

function legacyInterruptionProvenance(db: DatabaseService, event: SessionEvent.Event) {
  if (
    event.type !== SessionEvent.Tool.Failed.type ||
    event.version !== 1 ||
    event.data.provider.executed ||
    !isRecord(event.data.result) ||
    event.data.result.type !== "error" ||
    event.data.result.value !== event.data.error.message ||
    !["Tool execution aborted", "Tool execution interrupted"].includes(event.data.error.message)
  )
    return Effect.succeed(undefined)
  return db
    .select({ data: PartTable.data })
    .from(PartTable)
    .where(
      and(
        eq(PartTable.session_id, event.data.sessionID),
        eq(PartTable.message_id, SessionV1.MessageID.make(event.data.assistantMessageID)),
      ),
    )
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) =>
        rows
          .map((row) => legacyToolInterruptionMetadata(row.data, event.data.callID, event.data.error.message))
          .find((metadata) => metadata !== undefined),
      ),
    )
}

function legacyToolWasInterrupted(data: unknown, callID: string, error: string) {
  return legacyToolInterruptionMetadata(data, callID, error) !== undefined
}

function legacyToolInterruptionMetadata(data: unknown, callID: string, error: string) {
  if (typeof data !== "object" || data === null) return
  const part = data as Record<string, unknown>
  if (part.type !== "tool" || part.callID !== callID || typeof part.state !== "object" || part.state === null)
    return
  const state = part.state as Record<string, unknown>
  if (state.status !== "error" || state.error !== error) return
  if (typeof state.metadata !== "object" || state.metadata === null) return
  const metadata = state.metadata as Record<string, unknown>
  if (metadata.interrupted !== true) return
  if (hasOnlyKeys(metadata, ["interrupted"])) return metadata
  if (
    hasOnlyKeys(metadata, ["interrupted", "output", "description"]) &&
    typeof metadata.output === "string" &&
    ["Tool execution aborted", "Tool execution interrupted"].includes(error) &&
    isRecord(state.input) &&
    typeof state.input.description === "string" &&
    metadata.description === state.input.description
  )
    return metadata
}

function run(db: DatabaseService, event: SessionEvent.Event) {
  return Effect.gen(function* () {
    const decodeRow = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type })
    const updateMessage = (message: SessionMessage.Message) => {
      if (event.seq === undefined) return Effect.die("Synchronized Session event is missing aggregate sequence")
      const encoded = encodeMessage(message)
      const { id, type, ...data } = encoded
      return db
        .update(SessionMessageTable)
        .set({
          type,
          time_created: DateTime.toEpochMillis(message.time.created),
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
          data,
        })
        .where(
          and(
            eq(SessionMessageTable.id, SessionMessage.ID.make(id)),
            eq(SessionMessageTable.session_id, event.data.sessionID),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    }
    const appendMessage = (message: SessionMessage.Message) => insertMessage(db, event, message)
    const adapter: SessionMessageUpdater.Adapter = {
      getCurrentAssistant() {
        return Effect.gen(function* () {
          // A newer turn supersedes stale incomplete rows; never resume an older assistant projection.
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "assistant")),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" && !message.time.completed ? message : undefined
        })
      },
      getAssistant(messageID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, messageID),
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "assistant"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" ? message : undefined
        })
      },
      getCurrentShell(callID) {
        return Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(SessionMessageTable)
            .where(and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "shell")))
            .orderBy(desc(SessionMessageTable.seq))
            .all()
            .pipe(Effect.orDie)
          return rows
            .map(decodeRow)
            .find((message): message is SessionMessage.Shell => message.type === "shell" && message.callID === callID)
        })
      },
      updateAssistant: updateMessage,
      updateShell: updateMessage,
      appendMessage,
    }
    yield* SessionMessageUpdater.update(adapter, event, {
      legacyInterruptionProvenance: yield* legacyInterruptionProvenance(db, event),
    })
  })
}

function touchSession(db: DatabaseService, event: Pick<SessionEvent.Event, "data">) {
  return db
    .update(SessionTable)
    .set({ time_updated: DateTime.toEpochMillis(event.data.timestamp) })
    .where(eq(SessionTable.id, event.data.sessionID))
    .run()
    .pipe(Effect.orDie)
}

function insertMessage(db: DatabaseService, event: SessionEvent.Event, message: SessionMessage.Message) {
  if (event.seq === undefined) return Effect.die("Synchronized Session event is missing aggregate sequence")
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(id),
      session_id: event.data.sessionID,
      type,
      seq: event.seq,
      time_created: DateTime.toEpochMillis(message.time.created),
      time_updated: DateTime.toEpochMillis(event.data.timestamp),
      data,
    })
    .run()
    .pipe(Effect.orDie)
}

function updateProjectedMessage(
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  message: SessionMessage.Message,
  timeUpdated: DateTime.Utc,
) {
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return db
    .update(SessionMessageTable)
    .set({
      type,
      time_created: DateTime.toEpochMillis(message.time.created),
      time_updated: DateTime.toEpochMillis(timeUpdated),
      data,
    })
    .where(and(eq(SessionMessageTable.id, SessionMessage.ID.make(id)), eq(SessionMessageTable.session_id, sessionID)))
    .run()
    .pipe(Effect.orDie)
}

function cleanupRevert(db: DatabaseService, input: typeof SessionEvent.Revert.Cleaned.Type["data"]) {
  return Effect.gen(function* () {
    const target = yield* db
      .select()
      .from(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.session_id, input.sessionID),
          eq(SessionMessageTable.id, SessionMessage.ID.make(input.revert.messageID)),
        ),
      )
      .get()
      .pipe(Effect.orDie)

    if (target && input.revert.partID) {
      const message = decodeMessage({ ...target.data, id: target.id, type: target.type })
      if (message.type === "assistant") {
        const index = message.content.findIndex((item) => item.id === input.revert.partID)
        if (index >= 0) {
          yield* updateProjectedMessage(
            db,
            input.sessionID,
            new SessionMessage.Assistant({ ...message, content: message.content.slice(0, index) }),
            input.timestamp,
          )
        }
      }
    }

    const removal =
      input.messageIDs === undefined
        ? target
          ? and(
              eq(SessionMessageTable.session_id, input.sessionID),
              input.revert.partID ? gt(SessionMessageTable.seq, target.seq) : gte(SessionMessageTable.seq, target.seq),
            )
          : undefined
        : input.messageIDs.length > 0
          ? and(
              eq(SessionMessageTable.session_id, input.sessionID),
              inArray(SessionMessageTable.id, input.messageIDs),
            )
          : undefined
    if (removal) {
      const rows = yield* db.select().from(SessionMessageTable).where(removal).all().pipe(Effect.orDie)
      for (const row of rows) {
        const message = decodeMessage({ ...row.data, id: row.id, type: row.type })
        if (message.type === "assistant" && message.cost !== undefined && message.tokens !== undefined)
          yield* applyUsage(db, input.sessionID, {
            cost: message.cost,
            generationMs: message.tokenMeasurement?.generationMilliseconds ?? 0,
            tokens: message.tokens,
          }, -1)
      }
      yield* db.delete(SessionMessageTable).where(removal).run().pipe(Effect.orDie)
    }

    yield* db
      .update(SessionTable)
      .set({ revert: null, time_updated: DateTime.toEpochMillis(input.timestamp) })
      .where(eq(SessionTable.id, input.sessionID))
      .run()
      .pipe(Effect.orDie)
  })
}

function captureProjection(db: DatabaseService, aggregateID: string) {
  return Effect.gen(function* () {
    const session = yield* db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, SessionSchema.ID.make(aggregateID)))
      .get()
      .pipe(Effect.orDie)
    if (!session) return undefined
    const legacyMessages = yield* db
      .select()
      .from(MessageTable)
      .where(eq(MessageTable.session_id, session.id))
      .orderBy(MessageTable.time_created, MessageTable.id)
      .all()
      .pipe(Effect.orDie)
    const legacyParts = yield* db
      .select()
      .from(PartTable)
      .where(eq(PartTable.session_id, session.id))
      .orderBy(PartTable.message_id, PartTable.id)
      .all()
      .pipe(Effect.orDie)
    const messages = yield* db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, session.id))
      .orderBy(SessionMessageTable.seq)
      .all()
      .pipe(Effect.orDie)
    const inputs = yield* db
      .select()
      .from(SessionInputTable)
      .where(eq(SessionInputTable.session_id, session.id))
      .orderBy(SessionInputTable.admitted_seq)
      .all()
      .pipe(Effect.orDie)
    const contextEpoch = yield* db
      .select()
      .from(SessionContextEpochTable)
      .where(eq(SessionContextEpochTable.session_id, session.id))
      .get()
      .pipe(Effect.orDie)
    return {
      session,
      legacyMessages,
      legacyParts,
      messages,
      inputs,
      ...(contextEpoch ? { contextEpoch } : {}),
    } satisfies SessionProjection
  })
}

function checkpointCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(checkpointCanonical)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, checkpointCanonical(value[key])]))
}

function checkpointDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(checkpointCanonical(value)) ?? "undefined").digest("hex")
}

function checkpointProjection(projection: SessionProjection): CheckpointProjection {
  const messages = new Map(projection.legacyMessages.map((message) => [message.id, message]))
  const entries = projection.legacyParts
    .filter(legacyPartRequiresCheckpointOnly)
    .map((part) => {
      const message = messages.get(part.message_id)
      if (!message) throw new Error(`Checkpoint-only legacy part ${part.id} has no parent message`)
      return {
        partID: part.id,
        messageID: part.message_id,
        partDigest: checkpointDigest(part),
        messageDigest: checkpointDigest(message),
      }
    })
    .sort((left, right) => left.partID.localeCompare(right.partID))
  const provenance = { version: legacyCheckpointOnlyVersion, entries } as const
  return {
    ...projection,
    legacyCheckpointOnly: { ...provenance, digest: checkpointDigest(provenance) },
  }
}

function readActiveProjectionReference(value: unknown) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "checkpointSeq",
      "legacyMessageCount",
      "legacyPartCount",
      "messageCount",
      "projectionHash",
    ]) ||
    value.version !== activeProjectionReferenceVersion ||
    !Number.isSafeInteger(value.checkpointSeq) ||
    !Number.isSafeInteger(value.legacyMessageCount) ||
    !Number.isSafeInteger(value.legacyPartCount) ||
    !Number.isSafeInteger(value.messageCount) ||
    Number(value.legacyMessageCount) < 0 ||
    Number(value.legacyPartCount) < 0 ||
    Number(value.messageCount) < 0 ||
    typeof value.projectionHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.projectionHash)
  ) return invalidCheckpoint("active projection reference has an invalid schema")
  return value as ActiveProjectionReference
}

function activeProjectionHash(projection: Pick<SessionProjection, "legacyMessages" | "legacyParts" | "messages">) {
  return checkpointDigest({
    legacyMessages: projection.legacyMessages,
    legacyParts: projection.legacyParts,
    messages: projection.messages,
  })
}

function captureActiveProjection(db: ProjectionDatabase, aggregateID: string) {
  return Effect.all({
    legacyMessages: db
      .select()
      .from(MessageTable)
      .where(eq(MessageTable.session_id, SessionSchema.ID.make(aggregateID)))
      .orderBy(MessageTable.time_created, MessageTable.id)
      .all()
      .pipe(Effect.orDie),
    legacyParts: db
      .select()
      .from(PartTable)
      .where(eq(PartTable.session_id, SessionSchema.ID.make(aggregateID)))
      .orderBy(PartTable.message_id, PartTable.id)
      .all()
      .pipe(Effect.orDie),
    messages: db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, SessionSchema.ID.make(aggregateID)))
      .orderBy(SessionMessageTable.seq)
      .all()
      .pipe(Effect.orDie),
  })
}

function checkpointSequence(db: ProjectionDatabase, aggregateID: string) {
  return db
    .select({ seq: EventSequenceTable.seq })
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, aggregateID))
    .get()
    .pipe(Effect.orDie, Effect.map((row) => row?.seq))
}

function normalizeActiveCheckpoint(
  db: ProjectionDatabase,
  input: { readonly aggregateID: string; readonly seq: number; readonly baseline: EventV2.CheckpointBaseline },
) {
  return Effect.gen(function* () {
    if (input.baseline.version !== checkpointAdapterVersion) return input.baseline
    const projection = readProjection(input.baseline)
    if (
      projection.legacyMessages.length === 0 &&
      projection.legacyParts.length === 0 &&
      projection.messages.length === 0
    ) return input.baseline
    const sequence = yield* checkpointSequence(db, input.aggregateID)
    if (sequence !== input.seq)
      return invalidCheckpoint(`active projection sequence differs (checkpoint ${input.seq}, current ${sequence ?? "missing"})`)
    const canonical = yield* captureActiveProjection(db, input.aggregateID)
    if (
      !isDeepStrictEqual(canonical.legacyMessages, projection.legacyMessages) ||
      !isDeepStrictEqual(canonical.legacyParts, projection.legacyParts) ||
      !isDeepStrictEqual(canonical.messages, projection.messages)
    ) return invalidCheckpoint("active checkpoint projection differs from canonical tables")
    return {
      ...input.baseline,
      data: {
        ...input.baseline.data,
        legacyMessages: [],
        legacyParts: [],
        messages: [],
        [activeProjectionReferenceKey]: {
          version: activeProjectionReferenceVersion,
          checkpointSeq: input.seq,
          legacyMessageCount: canonical.legacyMessages.length,
          legacyPartCount: canonical.legacyParts.length,
          messageCount: canonical.messages.length,
          projectionHash: activeProjectionHash(canonical),
        } satisfies ActiveProjectionReference,
      },
    }
  })
}

function hydrateActiveCheckpoint(
  db: ProjectionDatabase,
  input: { readonly aggregateID: string; readonly seq: number; readonly baseline: EventV2.CheckpointBaseline },
) {
  return Effect.gen(function* () {
    const stored = input.baseline.data[activeProjectionReferenceKey]
    if (stored === undefined) return input.baseline
    if (
      input.baseline.adapter !== checkpointAdapterID ||
      input.baseline.version !== checkpointAdapterVersion ||
      !Array.isArray(input.baseline.data.legacyMessages) ||
      !Array.isArray(input.baseline.data.legacyParts) ||
      !Array.isArray(input.baseline.data.messages) ||
      input.baseline.data.legacyMessages.length !== 0 ||
      input.baseline.data.legacyParts.length !== 0 ||
      input.baseline.data.messages.length !== 0
    ) return invalidCheckpoint("active checkpoint projection reference has an incompatible baseline")
    const reference = readActiveProjectionReference(stored)
    const sequence = yield* checkpointSequence(db, input.aggregateID)
    if (reference.checkpointSeq !== input.seq || sequence !== input.seq)
      return invalidCheckpoint(
        `active projection reference sequence differs (marker ${reference.checkpointSeq}, checkpoint ${input.seq}, current ${sequence ?? "missing"})`,
      )
    const canonical = yield* captureActiveProjection(db, input.aggregateID)
    if (
      canonical.legacyMessages.length !== reference.legacyMessageCount ||
      canonical.legacyParts.length !== reference.legacyPartCount ||
      canonical.messages.length !== reference.messageCount ||
      activeProjectionHash(canonical) !== reference.projectionHash
    ) return invalidCheckpoint("active checkpoint projection reference hash or counts differ")
    const { [activeProjectionReferenceKey]: _, ...data } = input.baseline.data
    return {
      ...input.baseline,
      data: {
        ...data,
        legacyMessages: canonical.legacyMessages,
        legacyParts: canonical.legacyParts,
        messages: canonical.messages,
      },
    }
  })
}

export function materializeActiveCheckpoint(db: DatabaseService, sessionID: SessionSchema.ID) {
  return db
    .transaction((tx) =>
      Effect.gen(function* () {
        const row = yield* tx
          .select()
          .from(EventCheckpointTable)
          .where(eq(EventCheckpointTable.aggregate_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!row || row.version !== EventV2.CheckpointVersion) return false
        const baseline = EventV2.readStoredCheckpointBaseline(row.data)
        const hydrated = yield* hydrateActiveCheckpoint(tx, { aggregateID: sessionID, seq: row.seq, baseline })
        if (checkpointDigest(hydrated) === checkpointDigest(baseline)) return false
        const updated = yield* tx
          .update(EventCheckpointTable)
          .set({ data: EventV2.replaceStoredCheckpointBaseline(row.data, hydrated) })
          .where(
            and(
              eq(EventCheckpointTable.aggregate_id, sessionID),
              eq(EventCheckpointTable.seq, row.seq),
              eq(EventCheckpointTable.version, row.version),
              eq(EventCheckpointTable.data, row.data),
            ),
          )
          .returning({ aggregateID: EventCheckpointTable.aggregate_id })
          .get()
          .pipe(Effect.orDie)
        if (!updated) return invalidCheckpoint("active checkpoint changed while its projection was materialized")
        return true
      }),
    )
    .pipe(Effect.orDie)
}

export function hydrateActiveCheckpointData(
  db: ProjectionDatabase,
  sessionID: SessionSchema.ID,
  seq: number,
  data: Record<string, unknown>,
) {
  return Effect.gen(function* () {
    const baseline = EventV2.readStoredCheckpointBaseline(data)
    const hydrated = yield* hydrateActiveCheckpoint(db, { aggregateID: sessionID, seq, baseline })
    if (checkpointDigest(hydrated) === checkpointDigest(baseline)) return data
    return EventV2.replaceStoredCheckpointBaseline(data, hydrated)
  })
}

function invalidCheckpoint(message: string): never {
  throw new EventV2.InvalidSyncEventError({
    type: EventV2.CheckpointCapability,
    message: `Invalid ${checkpointAdapterID}@${checkpointAdapterVersion} baseline: ${message}`,
  })
}

function readCheckpointOnly(projection: SessionProjection, value: unknown): LegacyCheckpointOnly {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "entries", "digest"]) ||
    value.version !== legacyCheckpointOnlyVersion ||
    !Array.isArray(value.entries) ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.digest)
  )
    return invalidCheckpoint("checkpoint-only legacy provenance has an invalid schema")
  const entries = value.entries.flatMap((entry): LegacyCheckpointOnlyEntry[] => {
    if (
      !isRecord(entry) ||
      !hasOnlyKeys(entry, ["partID", "messageID", "partDigest", "messageDigest"]) ||
      typeof entry.partID !== "string" ||
      typeof entry.messageID !== "string" ||
      typeof entry.partDigest !== "string" ||
      typeof entry.messageDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.partDigest) ||
      !/^[a-f0-9]{64}$/.test(entry.messageDigest)
    )
      return invalidCheckpoint("checkpoint-only legacy provenance contains an invalid entry")
    return [{
      partID: entry.partID,
      messageID: entry.messageID,
      partDigest: entry.partDigest,
      messageDigest: entry.messageDigest,
    }]
  })
  if (entries.some((entry, index) => index > 0 && entries[index - 1]!.partID >= entry.partID))
    return invalidCheckpoint("checkpoint-only legacy provenance is not strictly ordered")
  if (value.digest !== checkpointDigest({ version: legacyCheckpointOnlyVersion, entries }))
    return invalidCheckpoint("checkpoint-only legacy provenance digest differs")

  const parts = new Map<string, typeof PartTable.$inferSelect>(projection.legacyParts.map((part) => [part.id, part]))
  const messages = new Map<string, typeof MessageTable.$inferSelect>(
    projection.legacyMessages.map((message) => [message.id, message]),
  )
  const required = projection.legacyParts.filter(legacyPartRequiresCheckpointOnly).map((part) => part.id).sort()
  if (!isDeepStrictEqual(entries.map((entry) => entry.partID), required))
    return invalidCheckpoint("checkpoint-only legacy provenance coverage differs")
  entries.forEach((entry) => {
    const part = parts.get(entry.partID)
    const message = messages.get(entry.messageID)
    if (!part || !message || part.message_id !== entry.messageID || part.session_id !== message.session_id)
      return invalidCheckpoint(`checkpoint-only legacy row ${entry.partID} violates its parent invariant`)
    if (!validLegacyPartRow(part) || !validLegacyMessageRow(message))
      return invalidCheckpoint(`checkpoint-only legacy row ${entry.partID} violates its legacy schema`)
    if (checkpointDigest(part) !== entry.partDigest || checkpointDigest(message) !== entry.messageDigest)
      return invalidCheckpoint(`checkpoint-only legacy row ${entry.partID} digest differs`)
  })
  return { version: legacyCheckpointOnlyVersion, entries, digest: value.digest }
}

function validLegacyPartRow(part: typeof PartTable.$inferSelect) {
  if (
    !hasOnlyKeys(part, ["id", "message_id", "session_id", "time_created", "time_updated", "data"]) ||
    !Number.isSafeInteger(part.time_created) ||
    !Number.isSafeInteger(part.time_updated) ||
    !isRecord(part.data)
  )
    return false
  return Option.isSome(
    Schema.decodeUnknownOption(SessionV1.Part)({
      ...part.data,
      id: part.id,
      messageID: part.message_id,
      sessionID: part.session_id,
    }),
  )
}

function validLegacyMessageRow(message: typeof MessageTable.$inferSelect) {
  if (
    !hasOnlyKeys(message, ["id", "session_id", "time_created", "time_updated", "data"]) ||
    !Number.isSafeInteger(message.time_created) ||
    !Number.isSafeInteger(message.time_updated) ||
    !isRecord(message.data)
  )
    return false
  return Option.isSome(
    Schema.decodeUnknownOption(SessionV1.Info)({
      ...message.data,
      id: message.id,
      sessionID: message.session_id,
    }),
  )
}

function legacyPartRequiresCheckpointOnly(part: typeof PartTable.$inferSelect) {
  const data = part.data as unknown
  if (!isRecord(data) || typeof data.type !== "string") return true
  if (data.type === "text")
    return data.synthetic !== undefined || data.ignored !== undefined || data.metadata !== undefined
  if (data.type === "reasoning") return data.metadata !== undefined
  if (data.type === "file") return data.source !== undefined
  if (data.type === "tool") {
    if (data.metadata !== undefined) return true
    if (!isRecord(data.state)) return false
    if (data.state.status === "running" && legacyRunningToolMetadataMatches(data.state)) return true
    return legacyTaskInterruptionMetadata(part.session_id, data.tool, data.state)
  }
  return !["step-start", "step-finish"].includes(data.type)
}

function readProjection(baseline: EventV2.CheckpointBaseline) {
  if (
    baseline.adapter !== checkpointAdapterID ||
    !canRestoreCheckpointVersion(baseline.version) ||
    !baseline.data.session ||
    !Array.isArray(baseline.data.messages) ||
    !Array.isArray(baseline.data.inputs) ||
    baseline.data[activeProjectionReferenceKey] !== undefined ||
    (baseline.version >= projectionCheckpointVersion &&
      (!Array.isArray(baseline.data.legacyMessages) || !Array.isArray(baseline.data.legacyParts)))
  )
    return invalidCheckpoint("projection schema differs")
  const { legacyCheckpointOnly: _, ...data } = baseline.data
  const projection = ({
    ...data,
    legacyMessages: Array.isArray(baseline.data.legacyMessages) ? baseline.data.legacyMessages : [],
    legacyParts: Array.isArray(baseline.data.legacyParts) ? baseline.data.legacyParts : [],
  } as unknown) as SessionProjection & Record<string, unknown>
  if (baseline.version >= 3)
    readCheckpointOnly(projection, baseline.data.legacyCheckpointOnly)
  return projection
}

const projectionBatchSize = 400

function projectionBatches<T>(rows: ReadonlyArray<T>) {
  return Array.from({ length: Math.ceil(rows.length / projectionBatchSize) }, (_, index) =>
    rows.slice(index * projectionBatchSize, (index + 1) * projectionBatchSize),
  )
}

function insertLegacyMessages(
  db: DatabaseService,
  rows: ReadonlyArray<typeof MessageTable.$inferInsert>,
  ignoreConflicts = false,
) {
  return Effect.forEach(
    projectionBatches(rows),
    (batch) => {
      if (ignoreConflicts)
        return db.insert(MessageTable).values(batch).onConflictDoNothing().run().pipe(Effect.orDie)
      return db.insert(MessageTable).values(batch).run().pipe(Effect.orDie)
    },
    { discard: true },
  )
}

function insertLegacyParts(
  db: DatabaseService,
  rows: ReadonlyArray<typeof PartTable.$inferInsert>,
  ignoreConflicts = false,
) {
  return Effect.forEach(
    projectionBatches(rows),
    (batch) => {
      if (ignoreConflicts)
        return db.insert(PartTable).values(batch).onConflictDoNothing().run().pipe(Effect.orDie)
      return db.insert(PartTable).values(batch).run().pipe(Effect.orDie)
    },
    { discard: true },
  )
}

function restoreProjection(db: DatabaseService, aggregateID: string, baseline: EventV2.CheckpointBaseline) {
  return Effect.gen(function* () {
    const projection = readProjection(baseline)
    if (projection.session.id !== aggregateID)
      return yield* Effect.die(
        new EventV2.InvalidSyncEventError({
          type: EventV2.CheckpointCapability,
          message: `Session checkpoint ${projection.session.id} does not match aggregate ${aggregateID}`,
        }),
      )
    yield* db.delete(SessionTable).where(eq(SessionTable.id, projection.session.id)).run().pipe(Effect.orDie)
    yield* db.insert(SessionTable).values(projection.session).run().pipe(Effect.orDie)
    yield* insertLegacyMessages(db, projection.legacyMessages)
    yield* insertLegacyParts(db, projection.legacyParts)
    if (projection.messages.length > 0)
      yield* db.insert(SessionMessageTable).values([...projection.messages]).run().pipe(Effect.orDie)
    if (projection.inputs.length > 0)
      yield* db.insert(SessionInputTable).values([...projection.inputs]).run().pipe(Effect.orDie)
    if (projection.contextEpoch)
      yield* db.insert(SessionContextEpochTable).values(projection.contextEpoch).run().pipe(Effect.orDie)
  })
}

export type CheckpointVerificationInput = {
  readonly aggregateID: string
  readonly expected: EventV2.CheckpointBaseline
  readonly previous?: EventV2.CheckpointBaseline
  readonly previousSeq?: number
  readonly events: ReadonlyArray<EventV2.SerializedEvent>
}

export type CheckpointVerificationWorker = (
  input: CheckpointVerificationInput,
) => Effect.Effect<void, never, never>

export type LayerOptions = {
  readonly checkpointVerificationWorker?: CheckpointVerificationWorker
  readonly registerCheckpointAdapter?: boolean
}

function verifyProjection(input: CheckpointVerificationInput): Effect.Effect<void, never, never> {
  const executable = basename(process.execPath).toLowerCase()
  if (executable === "bun" || executable === "bun.exe") return verifyProjectionInFreshRuntime(input)
  return verifyProjectionInWorker(input)
}

function verifyProjectionInWorker(input: CheckpointVerificationInput): Effect.Effect<void, never, never> {
  return Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "opencode-checkpoint-replay-"))),
    (directory) =>
      Effect.tryPromise({
        try: async () => {
          const inputPath = join(directory, "input.json")
          await writeFile(inputPath, CheckpointVerificationTransport.encode(input))
          const child = IsolatedWorker.launch(["storage", "checkpoint-worker", inputPath])
          child.stdin.end()
          child.stdout.resume()
          const stderr: Buffer[] = []
          child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
          const exitCode = await new Promise<number>((resolve, reject) => {
            child.once("error", reject)
            child.once("close", (code) => resolve(code ?? 1))
          })
          if (exitCode !== 0)
            throw new Error(Buffer.concat(stderr).toString("utf8").trim() || `Checkpoint replay worker exited ${exitCode}`)
        },
        catch: (cause) =>
          new EventV2.InvalidSyncEventError({
            type: EventV2.CheckpointCapability,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      }).pipe(Effect.orDie),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )
}

export function verifyProjectionInFreshRuntime(
  input: CheckpointVerificationInput,
): Effect.Effect<void, never, never> {
  const database = Database.layerFromPath(":memory:", { deferStartupRepairs: false })
  const events = EventV2.layer.pipe(Layer.provide(database))
  const projector = makeLayer({ registerCheckpointAdapter: false }).pipe(
    Layer.provide(events),
    Layer.provide(database),
  )
  return Effect.promise(() =>
    Effect.runPromise(
      verifyCheckpointProjectionInCurrentRuntime(input).pipe(
        Effect.provide(Layer.mergeAll(database, events, projector)),
        Effect.scoped,
      ),
    ),
  )
}

export function verifyCheckpointProjectionInCurrentRuntime(input: CheckpointVerificationInput) {
  return Effect.gen(function* () {
    const expected = readProjection(input.expected)
    const checkpointOnly =
      input.expected.version === checkpointAdapterVersion
        ? readCheckpointOnly(expected, input.expected.data.legacyCheckpointOnly)
        : undefined
    const checkpointOnlyIDs = new Set(checkpointOnly?.entries.map((entry) => entry.partID) ?? [])
    const removedLegacyPartIDs = legacyPartsRemovedAtEnd(input.events)
    const previous = input.previous && readProjection(input.previous)
    const { db } = yield* Database.Service
    const service = yield* EventV2.Service
    const initialWithoutCreated =
      !input.previous && !input.events.some((event) => event.type === sessionCreatedType)
    const legacyPromptBackfill =
      initialWithoutCreated &&
      input.events[0]?.seq === 0 &&
      input.events[0].type === sessionPromptedType
    const legacyMessageRootBackfill =
      initialWithoutCreated &&
      input.events[0]?.seq === 0 &&
      input.events[0].type === legacyMessageUpdatedType &&
      input.events.some((event) => event.type === sessionUpdatedType)
    yield* db
      .insert(ProjectTable)
      .values(replayProjects(input.events, expected, previous))
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    // Historical backfills either began at the first V2 prompt or wrote V1 children before a full SessionUpdated
    // root snapshot. Seed only that missing aggregate root. Usage is additive during replay, so it must start
    // neutral; every child row and the final counters still have to be reconstructed by the event stream.
    if (legacyPromptBackfill || legacyMessageRootBackfill)
      yield* db
        .insert(SessionTable)
        .values({
          ...expected.session,
          cost: 0,
          tokens_input: 0,
          tokens_output: 0,
          tokens_reasoning: 0,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          generation_ms: 0,
        })
        .run()
        .pipe(Effect.orDie)
    const legacy = legacyMessageRootBackfill
      ? legacyProjectionRequiredForV2Replay(
        input.events,
        expected,
        checkpointOnlyIDs,
        removedLegacyPartIDs,
      )
      : undefined
    if (legacy) {
      yield* insertLegacyMessages(db, legacy.messages)
      yield* insertLegacyParts(db, legacy.parts)
    }
    const promptReplayParts = legacyPromptBackfill
      ? legacyProjectionRequiredForV2Replay(
        input.events,
        expected,
        checkpointOnlyIDs,
        removedLegacyPartIDs,
      ).runtimeReplayParts
      : []
    if (promptReplayParts.length > 0) {
      const messageIDs = new Set(promptReplayParts.map((part) => part.message_id))
      yield* insertLegacyMessages(
        db,
        expected.legacyMessages.filter((message) => messageIDs.has(message.id)),
        true,
      )
      yield* insertLegacyParts(db, promptReplayParts, true)
    }
    if (input.previous) {
      if (!previous) return yield* Effect.die("Checkpoint baseline is missing")
      yield* restoreProjection(db, input.aggregateID, input.previous)
      if (input.previous.version === 1 && input.expected.version === checkpointAdapterVersion) {
        yield* insertLegacyMessages(db, expected.legacyMessages)
        yield* insertLegacyParts(db, expected.legacyParts)
      }
      yield* db
        .insert(EventSequenceTable)
        .values({ aggregate_id: input.aggregateID, seq: input.previousSeq ?? -1 })
        .run()
        .pipe(Effect.orDie)
      if (previous.session.id !== input.aggregateID) return yield* Effect.die("Checkpoint aggregate mismatch")
    }
    if (checkpointOnly && (legacyPromptBackfill || legacyMessageRootBackfill || input.previous)) {
      const messageIDs = new Set(checkpointOnly.entries.map((entry) => entry.messageID))
      const messages = expected.legacyMessages.filter((message) => messageIDs.has(message.id))
      yield* insertLegacyMessages(db, messages, true)
    }
    if (legacy?.checkpointReplayParts.length) yield* insertLegacyParts(db, legacy.checkpointReplayParts)
    if (input.events.length > 0)
      yield* service.replayAll(replayEventsWithProjectedLegacyActivityFailures(input.events, expected.messages))
    const projectRepair = !input.previous
      ? legacyGlobalProjectRepair(
          input.events,
          input.aggregateID,
          expected.session.project_id,
          expected.session.time_updated,
        )
      : undefined
    if (projectRepair) yield* db.run(projectRepair).pipe(Effect.orDie)
    const planDocumentRepair = !input.previous
      ? legacyPlanDocumentRepair(input.events, expected.session.metadata)
      : undefined
    if (planDocumentRepair) {
      const replayed = yield* db
        .select({ metadata: SessionTable.metadata })
        .from(SessionTable)
        .where(eq(SessionTable.id, expected.session.id))
        .get()
        .pipe(Effect.orDie)
      if (replayed && isRecord(replayed.metadata) && !Object.hasOwn(replayed.metadata, SessionPlanDocument.MetadataKey))
        yield* db
          .update(SessionTable)
          .set({
            metadata: { ...replayed.metadata, [SessionPlanDocument.MetadataKey]: planDocumentRepair },
            time_updated: expected.session.time_updated,
          })
          .where(eq(SessionTable.id, expected.session.id))
          .run()
          .pipe(Effect.orDie)
    }
    if (checkpointOnly && !input.previous) {
      const partIDs = new Set(checkpointOnly.entries.map((entry) => entry.partID))
      const messageIDs = new Set(checkpointOnly.entries.map((entry) => entry.messageID))
      const messages = expected.legacyMessages.filter((message) => messageIDs.has(message.id))
      const parts = expected.legacyParts.filter(
        (part) => partIDs.has(part.id) && !removedLegacyPartIDs.has(part.id),
      )
      yield* insertLegacyMessages(db, messages, true)
      if (parts.length > 0) {
        // Replay proves the event-backed core; the authenticated manifest remains authoritative for fields and
        // original insertion timestamps that never existed in the event contract.
        yield* Effect.forEach(
          projectionBatches(parts),
          (batch) =>
            db.delete(PartTable).where(inArray(PartTable.id, batch.map((part) => part.id))).run().pipe(Effect.orDie),
          { discard: true },
        )
        yield* insertLegacyParts(db, parts)
      }
    }
    if (
      legacyPromptBackfill &&
      expected.legacyMessages.length > 0 &&
      !input.events.some((event) => legacyChildEventTypes.has(event.type))
    ) {
      const replayedMessageIDs = new Set<string>(
        (yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, expected.session.id))
          .all()
          .pipe(Effect.orDie)).map((message) => message.id),
      )
      if (expected.legacyMessages.every((message) => replayedMessageIDs.has(message.id))) {
        yield* insertLegacyMessages(db, expected.legacyMessages, true)
        yield* insertLegacyParts(db, expected.legacyParts, true)
      }
    }
    const actual = yield* captureProjection(db, input.aggregateID)
    const parityOptions = {
      includeContextEpoch: previous?.contextEpoch !== undefined,
      normalizeLegacyProjection: input.previous?.version !== checkpointAdapterVersion,
    }
    const expectedParity = projectionForParity(expected, parityOptions)
    const actualParity = actual && projectionForParity(actual, parityOptions)
    const externalized =
      actualParity && parityOptions.normalizeLegacyProjection
        ? normalizeMigratedLegacyToolOutputParity(expectedParity, actualParity)
        : { expected: expectedParity, actual: actualParity }
    const comparable =
      externalized.actual && parityOptions.normalizeLegacyProjection
        ? normalizeCheckpointToolParity(externalized.expected, externalized.actual, checkpointOnlyIDs)
        : externalized
    const interrupted =
      comparable.actual && parityOptions.normalizeLegacyProjection
        ? normalizeLegacyInterruptedToolParity(comparable.expected, comparable.actual, input.events)
        : comparable
    if (!interrupted.actual || !isDeepStrictEqual(interrupted.actual, interrupted.expected))
      return yield* Effect.die(
        new EventV2.InvalidSyncEventError({
          type: EventV2.CheckpointCapability,
          message: `Fresh replay projection parity failed for aggregate ${input.aggregateID}: ${describeProjectionMismatch(interrupted.expected, interrupted.actual)} after ${input.events.length} events`,
        }),
      )
  })
}

function legacyGlobalProjectRepair(
  events: ReadonlyArray<EventV2.SerializedEvent>,
  aggregateID: string,
  expectedProjectID: string,
  expectedTimeUpdated: number,
) {
  if (!/^[a-f0-9]{40}$/.test(expectedProjectID)) return
  const created = events.find(
    (event) =>
      event.type === sessionCreatedType &&
      (event.data as (typeof SessionV1.Event.Created.Type)["data"]).info.projectID === "global",
  )
  if (!created) return
  const createdTimeUpdated = (created.data as (typeof SessionV1.Event.Created.Type)["data"]).info.time.updated
  // Early V1 SessionCreated events persisted the process-wide `global` project id. Project migration later
  // canonicalized the durable projection to the SHA-1 project id without emitting an event and preserved the
  // later V1 session clock. Apply only that migration when replay produced a clock within the proven legacy range;
  // every predicate fails closed so arbitrary project or timestamp drift remains subject to strict parity.
  return sql`UPDATE session SET project_id = ${expectedProjectID}, time_updated = ${expectedTimeUpdated}
    WHERE id = ${aggregateID} AND project_id = 'global'
      AND time_updated >= ${createdTimeUpdated} AND time_updated <= ${expectedTimeUpdated}`
}

function legacyPlanDocumentRepair(events: ReadonlyArray<EventV2.SerializedEvent>, expectedMetadata: unknown) {
  if (!isRecord(expectedMetadata)) return
  const document = Option.getOrUndefined(
    Schema.decodeUnknownOption(SessionPlanDocument.Info)(expectedMetadata[SessionPlanDocument.MetadataKey]),
  )
  if (!document) return
  const sessionEvents = events.filter((event) => event.type === sessionCreatedType || event.type === sessionUpdatedType)
  if (sessionEvents.length === 0) return
  if (
    sessionEvents.some((event) => {
      const metadata = (event.data as (typeof SessionV1.Event.Created.Type)["data"]).info.metadata
      return isRecord(metadata) && Object.hasOwn(metadata, SessionPlanDocument.MetadataKey)
    })
  )
    return
  // Plan documents predate event-backed persistence and were written directly to Session metadata. Restore only a
  // schema-valid expected document that no session event ever projected; strict parity still checks every other key.
  return document
}

function replayEventsWithProjectedLegacyActivityFailures(
  events: ReadonlyArray<EventV2.SerializedEvent>,
  messages: ReadonlyArray<typeof SessionMessageTable.$inferSelect>,
) {
  const projected = new Map(messages.map((message) => [message.id, message]))
  return events.map((event) => {
    if (event.type !== activityFailedV1Type) return event
    const data = event.data as {
      readonly timestamp: number
      readonly activityID: string
      readonly error: SessionEvent.UnknownError
    }
    const message = projected.get(SessionMessage.ID.make(`msg_activity_failure_${data.activityID}`))
    if (!message || message.type !== "assistant" || message.seq !== event.seq) return event
    if (message.time_created !== data.timestamp) return event
    const decoded = decodeMessage({ ...message.data, id: message.id, type: message.type })
    if (decoded.type !== "assistant" || decoded.finish !== "error" || decoded.content.length !== 0) return event
    if (!isDeepStrictEqual(decoded.error, data.error)) return event
    // V1 spans both sides of the deployment that introduced synthetic failures. Only the matching durable
    // projection proves this event materialized a message; older V1 failures must remain absent on replay.
    return { ...event, type: activityFailedV2Type }
  })
}

function legacyPartsRemovedAtEnd(events: ReadonlyArray<EventV2.SerializedEvent>) {
  const removed = new Set<string>()
  events.forEach((event) => {
    if (event.type === legacyPartUpdatedType) {
      removed.delete((event.data as (typeof SessionV1.Event.PartUpdated.Type)["data"]).part.id)
      return
    }
    if (event.type === legacyPartRemovedType)
      removed.add((event.data as (typeof SessionV1.Event.PartRemoved.Type)["data"]).partID)
  })
  return removed
}

function legacyProjectionRequiredForV2Replay(
  events: ReadonlyArray<EventV2.SerializedEvent>,
  expected: SessionProjection,
  checkpointOnlyIDs: ReadonlySet<string>,
  removedLegacyPartIDs: ReadonlySet<string>,
  validateCheckpointOnly = true,
) {
  // These rows predate V1 event capture but are independently referenced by the migrated V2 stream. A later
  // root snapshot cannot satisfy an earlier child FK, and a part is pre-existing only when its stored creation
  // time strictly predates its first update or a specific V2 event proves that exact semantic part.
  const legacyMessageUpdates = new Map<string, number>()
  const legacyPartUpdates = new Map<
    string,
    { readonly time: number; readonly part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"] }
  >()
  const legacyPartValues = new Map<
    string,
    Array<(typeof SessionV1.Event.PartUpdated.Type)["data"]["part"]>
  >()
  const firstPartUpdateByMessage = new Map<string, number>()
  const v2Messages = new Map<string, number>()
  const messageEvidence = new Map<string, number>()
  const prompts: TimedEvidence<(typeof SessionEvent.Prompted.Type)["data"]>[] = []
  const steps: LegacyStepEvidence[] = []
  const texts: LegacyTextEvidence[] = []
  const reasoning: LegacyReasoningEvidence[] = []
  const tools: LegacyToolEvidence[] = []
  const openSteps = new Map<string, LegacyStepEvidence>()
  const openTexts = new Map<string, LegacyTextEvidence>()
  const openReasoning = new Map<string, LegacyReasoningEvidence>()
  const openTools = new Map<string, LegacyToolEvidence>()
  const firstChildByMessage = new Map<string, number>()
  events.forEach((event) => {
    if (event.type === legacyMessageUpdatedType) {
      const messageID = (event.data as (typeof SessionV1.Event.MessageUpdated.Type)["data"]).info.id
      if (!legacyMessageUpdates.has(messageID)) legacyMessageUpdates.set(messageID, event.seq)
      if (!messageEvidence.has(messageID)) messageEvidence.set(messageID, event.seq)
      return
    }
    if (event.type === legacyPartUpdatedType) {
      const data = event.data as (typeof SessionV1.Event.PartUpdated.Type)["data"]
      if (!legacyPartUpdates.has(data.part.id))
        legacyPartUpdates.set(data.part.id, { time: data.time, part: data.part })
      const values = legacyPartValues.get(data.part.id)
      if (values) values.push(data.part)
      if (!values) legacyPartValues.set(data.part.id, [data.part])
      if (!firstPartUpdateByMessage.has(data.part.messageID))
        firstPartUpdateByMessage.set(data.part.messageID, event.seq)
      return
    }
    if (event.type === legacyPartRemovedType) {
      return
    }
    if (event.type === stepStartedType) {
      const data = event.data as (typeof SessionEvent.Step.Started.Type)["data"]
      if (!v2Messages.has(data.assistantMessageID)) v2Messages.set(data.assistantMessageID, event.seq)
      if (!messageEvidence.has(data.assistantMessageID)) messageEvidence.set(data.assistantMessageID, event.seq)
      const time = serializedTimestamp(data)
      if (time !== undefined) {
        const step = { start: { data, time, key: event.seq } }
        steps.push(step)
        openSteps.set(String(data.assistantMessageID), step)
      }
      return
    }
    if (event.type === stepEndedType) {
      const data = event.data as (typeof SessionEvent.Step.Ended.Type)["data"]
      if (!v2Messages.has(data.assistantMessageID)) v2Messages.set(data.assistantMessageID, event.seq)
      if (!messageEvidence.has(data.assistantMessageID)) messageEvidence.set(data.assistantMessageID, event.seq)
      const time = serializedTimestamp(data)
      const step = openSteps.get(String(data.assistantMessageID))
      if (step && time !== undefined) {
        step.end = { data, time, key: event.seq }
        openSteps.delete(String(data.assistantMessageID))
      }
      return
    }
    if (event.type === sessionPromptedType) {
      const data = event.data as (typeof SessionEvent.Prompted.Type)["data"]
      if (!v2Messages.has(data.messageID)) v2Messages.set(data.messageID, event.seq)
      if (!messageEvidence.has(data.messageID)) messageEvidence.set(data.messageID, event.seq)
      const time = serializedTimestamp(data)
      if (time !== undefined) prompts.push({ data, time, key: event.seq })
      return
    }
    if (event.type === textStartedType) {
      const data = event.data as (typeof SessionEvent.Text.Started.Type)["data"]
      const time = serializedTimestamp(data)
      if (time !== undefined) {
        const text = { start: { data, time, key: event.seq } }
        texts.push(text)
        openTexts.set(`${String(data.assistantMessageID)}\0${data.textID}`, text)
        const messageID = String(data.assistantMessageID)
        if ((firstChildByMessage.get(messageID) ?? Number.POSITIVE_INFINITY) > time)
          firstChildByMessage.set(messageID, time)
      }
      return
    }
    if (event.type === textEndedType) {
      const data = event.data as (typeof SessionEvent.Text.Ended.Type)["data"]
      const time = serializedTimestamp(data)
      const key = `${String(data.assistantMessageID)}\0${data.textID}`
      const text = openTexts.get(key)
      if (text && time !== undefined) {
        text.end = { data, time, key: event.seq }
        openTexts.delete(key)
      }
      return
    }
    if (event.type === reasoningStartedType) {
      const data = event.data as (typeof SessionEvent.Reasoning.Started.Type)["data"]
      const time = serializedTimestamp(data)
      if (time !== undefined) {
        const item = { start: { data, time, key: event.seq } }
        reasoning.push(item)
        openReasoning.set(`${String(data.assistantMessageID)}\0${data.reasoningID}`, item)
        const messageID = String(data.assistantMessageID)
        if ((firstChildByMessage.get(messageID) ?? Number.POSITIVE_INFINITY) > time)
          firstChildByMessage.set(messageID, time)
      }
      return
    }
    if (event.type === reasoningEndedType) {
      const data = event.data as (typeof SessionEvent.Reasoning.Ended.Type)["data"]
      const time = serializedTimestamp(data)
      const key = `${String(data.assistantMessageID)}\0${data.reasoningID}`
      const item = openReasoning.get(key)
      if (item && time !== undefined) {
        item.end = { data, time, key: event.seq }
        openReasoning.delete(key)
      }
      return
    }
    if (event.type === toolInputStartedType) {
      const data = event.data as (typeof SessionEvent.Tool.Input.Started.Type)["data"]
      const time = serializedTimestamp(data)
      if (time !== undefined) {
        const tool = {
          assistantMessageID: String(data.assistantMessageID),
          callID: data.callID,
          name: data.name,
          start: { data, time, key: event.seq },
        }
        tools.push(tool)
        openTools.set(`${tool.assistantMessageID}\0${tool.callID}`, tool)
        if ((firstChildByMessage.get(tool.assistantMessageID) ?? Number.POSITIVE_INFINITY) > time)
          firstChildByMessage.set(tool.assistantMessageID, time)
      }
      return
    }
    const data = event.data as Record<string, unknown>
    const tool = openTools.get(`${String(data.assistantMessageID)}\0${String(data.callID)}`)
    if (!tool) return
    const time = serializedTimestamp(data)
    if (time === undefined) return
    if (event.type === toolInputEndedType) {
      if (tool.input) tool.invalid = true
      tool.input = { data: event.data as (typeof SessionEvent.Tool.Input.Ended.Type)["data"], time, key: event.seq }
      return
    }
    if (event.type === toolCalledType) {
      if (tool.called) tool.invalid = true
      tool.called = { data: event.data as (typeof SessionEvent.Tool.Called.Type)["data"], time, key: event.seq }
      return
    }
    if (event.type === toolSuccessType) {
      if (tool.success || tool.failed) tool.invalid = true
      tool.success = { data: event.data as (typeof SessionEvent.Tool.Success.Type)["data"], time, key: event.seq }
      return
    }
    if (event.type === toolFailedV1Type || event.type === toolFailedType) {
      if (tool.success || tool.failed) tool.invalid = true
      tool.failed = {
        data: event.data as (typeof SessionEvent.Tool.Failed.Type)["data"],
        time,
        key: event.seq,
        version: event.type === toolFailedType ? 2 : 1,
      }
    }
  })
  const promptParts = promptPartEvidence(expected, prompts)
  const compactionParts = compactionPartEvidence(expected, prompts, steps, messageEvidence)
  const evidence = {
    promptParts,
    compactionParts,
    compactionSettlements: legacyCompactionSettlements(prompts, steps),
    steps,
    texts,
    reasoning,
    tools,
    stepsByMessage: indexEvidence(steps, (item) => String(item.start.data.assistantMessageID)),
    textsByMessage: indexEvidence(texts, (item) => String(item.start.data.assistantMessageID)),
    reasoningByMessage: indexEvidence(reasoning, (item) => String(item.start.data.assistantMessageID)),
    toolsByCallID: indexEvidence(tools, (item) => item.callID),
    firstChildByMessage,
  }
  const checkpointOnlyParts = expected.legacyParts.filter((part) => checkpointOnlyIDs.has(part.id))
  const checkpointOnlyMatched = completeEvidenceAssignment(
    new Map(
      checkpointOnlyParts.map((part) => {
        const eventBacked =
          legacyPartValues.get(part.id)?.some((value) => isDeepStrictEqual(part.data, partData(value))) ?? false
        const candidates = legacyPartEvidenceCandidates(part, evidence, true)
        if (eventBacked) candidates.push({ key: `legacy-part:${part.id}` })
        if (candidates.length === 0 && legacyCheckpointOnlyStructural(part))
          candidates.push({ key: `checkpoint-structural:${part.id}` })
        return [part.id, candidates] as const
      }),
    ),
  )
  const invalidCheckpointOnly = checkpointOnlyParts.filter(
    (part) => removedLegacyPartIDs.has(part.id) || !checkpointOnlyMatched.has(part.id),
  )
  if (validateCheckpointOnly && invalidCheckpointOnly.length > 0)
    throw new EventV2.InvalidSyncEventError({
      type: EventV2.CheckpointCapability,
      message: `Checkpoint-only legacy causality failed for ${invalidCheckpointOnly
        .slice(0, 20)
        .map((part) => {
          const keys = legacyPartEvidenceCandidates(part, evidence, true).map((candidate) => candidate.key)
          if (removedLegacyPartIDs.has(part.id)) return `${part.id}[removed]`
          if (keys.length) return `${part.id}[${keys.join("|")}]`
          const data = part.data as unknown
          const tools = isRecord(data) && typeof data.callID === "string"
            ? (evidence.toolsByCallID.get(data.callID) ?? [])
              .map((tool) => `${tool.start.key}:${tool.invalid ? "invalid" : "valid"}:${tool.name}:${tool.input ? "input" : "no-input"}:${tool.called ? "called" : "not-called"}:${tool.success ? "success" : tool.failed ? "failed" : "running"}`)
            : []
          return `${part.id}[no-candidate${tools.length ? `;${tools.join("|")}` : ""}]`
        })
        .join(", ")}${invalidCheckpointOnly.length > 20 ? ` (+${invalidCheckpointOnly.length - 20} more)` : ""}`,
    })
  const matched = completeLegacyEvidenceAssignment(
    expected.legacyParts.filter(
      (part) =>
        !checkpointOnlyIDs.has(part.id) &&
        !legacyPartUpdates.has(part.id) &&
        !removedLegacyPartIDs.has(part.id),
    ),
    evidence,
  )
  const parts = expected.legacyParts.flatMap((part) => {
    if (removedLegacyPartIDs.has(part.id) || checkpointOnlyIDs.has(part.id)) return []
    const update = legacyPartUpdates.get(part.id)
    // A PartUpdated event carries the full semantic row. Seed only its event-backed value to preserve the older
    // insertion timestamp; replay overwrites it with every subsequent update. No checkpoint data is used as an oracle.
    if (update) return part.time_created < update.time ? [{ ...part, data: partData(update.part) }] : []
    return matched.has(part.id) ? [part] : []
  })
  const partMessageIDs = new Set(parts.map((part) => part.message_id))
  const messages = expected.legacyMessages.filter((message) => {
    const messageUpdate = legacyMessageUpdates.get(message.id)
    const v2Message = v2Messages.get(message.id)
    if (messageUpdate === undefined && v2Message === undefined) return false
    const required = [v2Message, firstPartUpdateByMessage.get(message.id)].filter(
      (seq): seq is number => seq !== undefined,
    )
    return partMessageIDs.has(message.id) || required.some((seq) => messageUpdate === undefined || seq < messageUpdate)
  })
  const messageIDs = new Set(messages.map((message) => message.id))
  return {
    messages,
    parts: parts.filter((part) => messageIDs.has(part.message_id)),
    checkpointReplayParts: checkpointOnlyParts.filter(
      (part) => checkpointOnlyMatched.has(part.id) && legacyRuntimeReplayEvidence(part, evidence),
    ),
    runtimeReplayParts: expected.legacyParts.filter(
      (part) =>
        !removedLegacyPartIDs.has(part.id) &&
        (checkpointOnlyIDs.has(part.id) ? checkpointOnlyMatched.has(part.id) : matched.has(part.id)) &&
        legacyRuntimeReplayEvidence(part, evidence),
    ),
  }
}

function legacyRuntimeReplayEvidence(part: typeof PartTable.$inferSelect, evidence: LegacyPartEvidence) {
  const data = part.data as unknown
  if (!isRecord(data) || data.type !== "tool" || typeof data.callID !== "string") return false
  return (evidence.toolsByCallID.get(data.callID) ?? []).some(
    (item) =>
      legacyToolMatches(
        part,
        data,
        item,
        true,
        evidence.compactionSettlements,
        evidence.stepsByMessage.get(part.message_id) ?? [],
      ),
  )
}

type TimedEvidence<T> = {
  readonly data: T
  readonly time: number
  readonly key: number
}

type LegacyStepEvidence = {
  readonly start: TimedEvidence<(typeof SessionEvent.Step.Started.Type)["data"]>
  end?: TimedEvidence<(typeof SessionEvent.Step.Ended.Type)["data"]>
}

type LegacyTextEvidence = {
  readonly start: TimedEvidence<(typeof SessionEvent.Text.Started.Type)["data"]>
  end?: TimedEvidence<(typeof SessionEvent.Text.Ended.Type)["data"]>
}

type LegacyReasoningEvidence = {
  readonly start: TimedEvidence<(typeof SessionEvent.Reasoning.Started.Type)["data"]>
  end?: TimedEvidence<(typeof SessionEvent.Reasoning.Ended.Type)["data"]>
}

type LegacyToolEvidence = {
  readonly assistantMessageID: string
  readonly callID: string
  readonly name: string
  readonly start: TimedEvidence<(typeof SessionEvent.Tool.Input.Started.Type)["data"]>
  invalid?: boolean
  input?: TimedEvidence<(typeof SessionEvent.Tool.Input.Ended.Type)["data"]>
  called?: TimedEvidence<(typeof SessionEvent.Tool.Called.Type)["data"]>
  success?: TimedEvidence<(typeof SessionEvent.Tool.Success.Type)["data"]>
  failed?: TimedEvidence<(typeof SessionEvent.Tool.Failed.Type)["data"]> & { readonly version: 1 | 2 }
}

type LegacyPartEvidence = {
  readonly promptParts: ReadonlyMap<string, LegacyPartCandidate>
  readonly compactionParts: ReadonlyMap<string, LegacyPartCandidate>
  readonly compactionSettlements: ReadonlyArray<{
    readonly prompt: number
    readonly settled: number
    readonly terminal: boolean
    readonly nextPrompt?: number
  }>
  readonly steps: ReadonlyArray<LegacyStepEvidence>
  readonly texts: ReadonlyArray<LegacyTextEvidence>
  readonly reasoning: ReadonlyArray<LegacyReasoningEvidence>
  readonly tools: ReadonlyArray<LegacyToolEvidence>
  readonly stepsByMessage: ReadonlyMap<string, ReadonlyArray<LegacyStepEvidence>>
  readonly textsByMessage: ReadonlyMap<string, ReadonlyArray<LegacyTextEvidence>>
  readonly reasoningByMessage: ReadonlyMap<string, ReadonlyArray<LegacyReasoningEvidence>>
  readonly toolsByCallID: ReadonlyMap<string, ReadonlyArray<LegacyToolEvidence>>
  readonly firstChildByMessage: ReadonlyMap<string, number>
}

function indexEvidence<T>(items: ReadonlyArray<T>, key: (item: T) => string) {
  const result = new Map<string, T[]>()
  items.forEach((item) => {
    const value = key(item)
    const current = result.get(value)
    if (current) current.push(item)
    if (!current) result.set(value, [item])
  })
  return result
}

type LegacyPartCandidate = {
  readonly key: string
}

function promptPartEvidence(
  expected: SessionProjection,
  prompts: ReadonlyArray<TimedEvidence<(typeof SessionEvent.Prompted.Type)["data"]>>,
) {
  const result = new Map<string, LegacyPartCandidate>()
  prompts.forEach((prompt) => {
    const parts = expected.legacyParts.filter((part) => part.message_id === String(prompt.data.messageID))
    const texts = parts.filter((part) => legacyPromptTextData(part.data))
    if (
      texts.length > 0 &&
      texts.every((part) => (part.data as unknown as { readonly text: string }).text.length > 0) &&
      ["", "\n\n"].some(
        (separator) =>
          texts.map((part) => (part.data as unknown as { readonly text: string }).text).join(separator) ===
          prompt.data.prompt.text,
      )
    )
      texts
        .filter(
          (part) =>
            legacyInsertionTimeMatches(part.time_created, prompt.time, 10, 2_000) &&
            legacyPromptPartTimeMatches(part, prompt.time),
        )
        .forEach((part) => result.set(part.id, { key: `prompt:${prompt.key}:text:${part.id}` }))
    const files = parts.filter((part) => legacyFileData(part.data))
    const remaining = [...(prompt.data.prompt.files ?? [])]
    const matches = files.map((part) => {
      const index = remaining.findIndex((file) => legacyFileMatches(part.data as Record<string, unknown>, file))
      if (index < 0) return false
      remaining.splice(index, 1)
      return true
    })
    if (files.length > 0 && matches.every(Boolean) && remaining.length === 0)
      files
        .filter((part) => legacyInsertionTimeMatches(part.time_created, prompt.time, 10, 10))
        .forEach((part) => result.set(part.id, { key: `prompt:${prompt.key}:file:${part.id}` }))
  })
  return result
}

function compactionPartEvidence(
  expected: SessionProjection,
  prompts: ReadonlyArray<TimedEvidence<(typeof SessionEvent.Prompted.Type)["data"]>>,
  steps: ReadonlyArray<LegacyStepEvidence>,
  messageEvidence: ReadonlyMap<string, number>,
) {
  const result = new Map<string, LegacyPartCandidate>()
  expected.legacyParts.forEach((part) => {
    const data = part.data as unknown
    if (
      !isRecord(data) ||
      !hasOnlyKeys(data, ["type", "auto", "overflow", "tail_start_id"]) ||
      data.type !== "compaction" ||
      typeof data.auto !== "boolean" ||
      (data.overflow !== undefined && typeof data.overflow !== "boolean") ||
      (data.tail_start_id !== undefined && typeof data.tail_start_id !== "string")
    )
      return
    if (
      typeof data.tail_start_id === "string" &&
      !expected.legacyMessages.some(
        (message) =>
          message.id === data.tail_start_id &&
          message.id !== part.message_id &&
          message.time_created < part.time_created,
      )
    )
      return
    const prompt = prompts.find(
      (item) =>
        String(item.data.messageID) === part.message_id &&
        item.data.prompt.text === "" &&
        (item.data.prompt.files?.length ?? 0) === 0,
    )
    if (!prompt) return
    const tail = typeof data.tail_start_id === "string" ? messageEvidence.get(data.tail_start_id) : undefined
    if (typeof data.tail_start_id === "string" && (tail === undefined || tail >= prompt.key)) return
    const step = steps.find(
      (item) =>
        item.start.data.agent === "compaction" &&
        item.start.time >= prompt.time &&
        item.start.time <= prompt.time + 1_000 &&
        expected.legacyMessages.some((message) => legacyCompactionAssistantMatches(message, part, item)),
    )
    if (!step) return
    if (
      !legacyInsertionTimeMatches(part.time_created, prompt.time, 10, 50) &&
      (part.time_created < prompt.time - 10 || part.time_created > step.start.time + 10)
    )
      return
    result.set(part.id, { key: `compaction:${prompt.key}:${step.start.key}` })
  })
  return result
}

function legacyCompactionSettlements(
  prompts: ReadonlyArray<TimedEvidence<(typeof SessionEvent.Prompted.Type)["data"]>>,
  steps: ReadonlyArray<LegacyStepEvidence>,
) {
  return prompts.flatMap((prompt) => {
    const compactionPrompt = prompt.data.prompt.text === "" && (prompt.data.prompt.files?.length ?? 0) === 0
    const compaction = compactionPrompt
      ? steps.find(
          (step) =>
            step.start.key > prompt.key &&
            step.start.data.agent === "compaction" &&
            step.start.time >= prompt.time &&
            step.start.time <= prompt.time + 1_000 &&
            step.end !== undefined,
        )
      : undefined
    if (compactionPrompt && !compaction?.end) return []
    const compactionSettlement = compaction?.end
      ? [{ prompt: prompt.time, settled: compaction.end.time, terminal: false }]
      : []
    const activityPrompt = compaction?.end
      ? prompts.find((item) => item.key > compaction.end!.key)
      : prompt
    if (!activityPrompt) return compactionSettlement
    const nextPrompt = prompts.find((item) => item.key > activityPrompt.key)
    const activitySteps = steps.filter(
      (step) =>
        step.start.key > activityPrompt.key &&
        (nextPrompt === undefined || step.start.key < nextPrompt.key) &&
        step.start.data.agent !== "compaction" &&
        step.start.time >= activityPrompt.time,
    )
    const terminal = activitySteps.at(-1)
    return [
      ...compactionSettlement,
      ...activitySteps.flatMap((step) =>
        step.end
          ? [{ prompt: prompt.time, settled: step.end.time, terminal: step === terminal, nextPrompt: nextPrompt?.time }]
          : [],
      ),
    ]
  })
}

function completeLegacyEvidenceAssignment(
  parts: ReadonlyArray<typeof PartTable.$inferSelect>,
  evidence: LegacyPartEvidence,
) {
  const candidates = new Map<string, LegacyPartCandidate[]>(
    parts.map((part) => [part.id, legacyPartEvidenceCandidates(part, evidence)]),
  )
  return completeEvidenceAssignment(candidates)
}

export function completeEvidenceAssignment(candidates: ReadonlyMap<string, ReadonlyArray<{ readonly key: string }>>) {
  const owners = new Map<string, string>()
  const assign = (partID: string, visited: Set<string>): boolean => {
    for (const candidate of candidates.get(partID) ?? []) {
      if (visited.has(candidate.key)) continue
      visited.add(candidate.key)
      const owner = owners.get(candidate.key)
      if (owner && !assign(owner, visited)) continue
      owners.set(candidate.key, partID)
      return true
    }
    return false
  }
  candidates.forEach((_, partID) => assign(partID, new Set()))
  return new Set(owners.values())
}

function legacyPartEvidenceCandidates(
  part: typeof PartTable.$inferSelect,
  evidence: LegacyPartEvidence,
  checkpointOnly = false,
) {
  // Bounds come from the read-only production history, with a small clock/order tolerance in both
  // directions: prompt projection up to 1,084ms, text/reasoning +0..1ms, step-start +965..6,498ms (or before its first
  // durable child event), patch up to 327ms before step-end,
  // step-finish -1,233..-139ms, and tool insertion up to 429,191ms before its input-start event.
  const data = part.data as unknown
  if (!isRecord(data) || typeof data.type !== "string") return []
  if (data.type === "text") {
    const prompt = evidence.promptParts.get(part.id)
    if (prompt) return [prompt]
    return (evidence.textsByMessage.get(part.message_id) ?? []).flatMap((item) =>
      (checkpointOnly ? legacyTextCoreMatches(part, data, item, true) : legacyTextMatches(part, data, item))
        ? [{ key: `text:${item.start.key}` }]
        : [],
    )
  }
  if (data.type === "file") return evidence.promptParts.has(part.id) ? [evidence.promptParts.get(part.id)!] : []
  if (data.type === "compaction")
    return evidence.compactionParts.has(part.id) ? [evidence.compactionParts.get(part.id)!] : []
  if (data.type === "step-start")
    return (evidence.stepsByMessage.get(part.message_id) ?? []).flatMap((item) =>
      legacyStepStartMatches(part, data, item, evidence)
        ? [{ key: `step-start:${item.start.key}` }]
        : [],
    )
  if (data.type === "patch")
    return (evidence.stepsByMessage.get(part.message_id) ?? []).flatMap((item) =>
      item.end &&
      (checkpointOnly
        ? legacyPatchCoreMatches(part, data, item)
        : legacyPatchData(data) &&
          String(item.start.data.assistantMessageID) === part.message_id &&
          item.start.data.snapshot === data.hash &&
          legacyInsertionTimeMatches(part.time_created, item.end.time, 10, 1))
        ? [{ key: `patch:${item.start.key}` }]
        : [],
    )
  if (data.type === "step-finish")
    return (evidence.stepsByMessage.get(part.message_id) ?? []).flatMap((item) =>
      item.end && legacyStepFinishMatches(part, data, item) ? [{ key: `step-finish:${item.start.key}` }] : [],
    )
  if (data.type === "reasoning")
    return (evidence.reasoningByMessage.get(part.message_id) ?? []).flatMap((item) =>
      (checkpointOnly ? legacyReasoningCoreMatches(part, data, item) : legacyReasoningMatches(part, data, item))
        ? [{ key: `reasoning:${item.start.key}` }]
        : [],
    )
  if (data.type === "tool")
    return (evidence.toolsByCallID.get(data.callID as string) ?? []).flatMap((item) =>
      legacyToolMatches(
        part,
        data,
        item,
        checkpointOnly,
        evidence.compactionSettlements,
        evidence.stepsByMessage.get(part.message_id) ?? [],
      )
        ? [{ key: `tool:${item.start.key}` }]
        : [],
    )
  return []
}

function legacyStepStartMatches(
  part: typeof PartTable.$inferSelect,
  data: Record<string, unknown>,
  step: LegacyStepEvidence,
  evidence: LegacyPartEvidence,
) {
  if (
    !hasOnlyKeys(data, ["type", "snapshot"]) ||
    String(step.start.data.assistantMessageID) !== part.message_id ||
    step.start.data.snapshot !== data.snapshot
  )
    return false
  if (legacyInsertionTimeMatches(part.time_created, step.start.time, 10, 7_000)) return true
  const firstChild = evidence.firstChildByMessage.get(part.message_id)
  return (
    firstChild !== undefined &&
    Number.isSafeInteger(part.time_created) &&
    part.time_created >= step.start.time - 10 &&
    part.time_created <= firstChild
  )
}

function legacyCheckpointOnlyStructural(part: typeof PartTable.$inferSelect) {
  const data = part.data as unknown
  if (!isRecord(data) || typeof data.type !== "string") return false
  // V1-only structural cards have no corresponding durable V2 event. Their exact bytes remain checkpoint-owned.
  return !["text", "reasoning", "file", "patch", "compaction", "tool"].includes(data.type)
}

function legacyInsertionTimeMatches(time: number, evidence: number, before: number, after: number) {
  return Number.isSafeInteger(time) && time >= evidence - before && time <= evidence + after
}

function serializedTimestamp(data: Record<string, unknown>) {
  return typeof data.timestamp === "number" && Number.isSafeInteger(data.timestamp) ? data.timestamp : undefined
}

function legacyPromptTextData(value: unknown) {
  if (!isRecord(value) || !hasOnlyKeys(value, ["type", "text", "synthetic", "ignored", "metadata", "time"]))
    return false
  return (
    value.type === "text" &&
    typeof value.text === "string" &&
    (value.synthetic === undefined || typeof value.synthetic === "boolean") &&
    (value.ignored === undefined || value.ignored === false) &&
    (value.metadata === undefined || isRecord(value.metadata)) &&
    (value.time === undefined ||
      (isRecord(value.time) &&
        hasOnlyKeys(value.time, ["start", "end"]) &&
        Number.isSafeInteger(value.time.start) &&
        (value.time.end === undefined || Number.isSafeInteger(value.time.end))))
  )
}

function legacyPromptPartTimeMatches(part: typeof PartTable.$inferSelect, promptTime: number) {
  const data = part.data as unknown
  if (!isRecord(data) || data.time === undefined) return true
  if (!isRecord(data.time)) return false
  const valid = data.time.start === part.time_created || data.time.start === promptTime
  return valid && (data.time.end === undefined || data.time.end === data.time.start)
}

function legacyFileData(value: unknown) {
  if (!isRecord(value) || !hasOnlyKeys(value, ["type", "mime", "filename", "url", "source"])) return false
  return (
    value.type === "file" &&
    typeof value.mime === "string" &&
    typeof value.url === "string" &&
    (value.filename === undefined || typeof value.filename === "string")
  )
}

function legacyCompactionAssistantMatches(
  message: typeof MessageTable.$inferSelect,
  part: typeof PartTable.$inferSelect,
  step: LegacyStepEvidence,
) {
  const data = message.data as unknown
  if (!isRecord(data) || !isRecord(data.time)) return false
  return (
    message.id === String(step.start.data.assistantMessageID) &&
    message.time_created === step.start.time &&
    data.role === "assistant" &&
    data.parentID === part.message_id &&
    data.agent === "compaction" &&
    data.mode === "compaction" &&
    data.summary === true &&
    data.modelID === step.start.data.model.id &&
    data.providerID === step.start.data.model.providerID &&
    data.time.created === step.start.time
  )
}

function legacyTextMatches(
  part: typeof PartTable.$inferSelect,
  data: Record<string, unknown>,
  evidence: LegacyTextEvidence,
) {
  if (!legacyTextCoreMatches(part, data, evidence) || data.synthetic !== undefined || data.ignored !== undefined)
    return false
  return data.metadata === undefined || legacyOpenAIMetadata(data.metadata, ["itemId", "phase"])
}

function legacyTextCoreMatches(
  part: typeof PartTable.$inferSelect,
  data: Record<string, unknown>,
  evidence: LegacyTextEvidence,
  checkpointOnly = false,
) {
  const omittedCheckpointEnd =
    checkpointOnly &&
    data.text === "" &&
    isRecord(data.time) &&
    data.time.end === undefined &&
    evidence.start.data.textID === part.id &&
    evidence.end !== undefined &&
    evidence.end.time >= evidence.start.time &&
    evidence.end.time <= evidence.start.time + 1
  if (
    !evidence.end ||
    !hasOnlyKeys(data, ["type", "text", "synthetic", "ignored", "time", "metadata"]) ||
    String(evidence.start.data.assistantMessageID) !== part.message_id ||
    evidence.end.data.assistantMessageID !== evidence.start.data.assistantMessageID ||
    evidence.end.data.textID !== evidence.start.data.textID ||
    evidence.end.data.text !== data.text ||
    typeof data.text !== "string" ||
    !isRecord(data.time) ||
    !hasOnlyKeys(data.time, ["start", "end"]) ||
    data.time.start !== evidence.start.time ||
    (data.time.end !== evidence.end.time && !omittedCheckpointEnd) ||
    !legacyInsertionTimeMatches(part.time_created, evidence.start.time, 10, 10)
  )
    return false
  return true
}

function legacyReasoningMatches(
  part: typeof PartTable.$inferSelect,
  data: Record<string, unknown>,
  evidence: LegacyReasoningEvidence,
) {
  if (!legacyReasoningCoreMatches(part, data, evidence)) return false
  const providerMetadata = evidence.end?.data.providerMetadata ?? evidence.start.data.providerMetadata
  if (providerMetadata !== undefined) return isDeepStrictEqual(data.metadata, providerMetadata)
  return data.metadata === undefined || legacyOpenAIMetadata(data.metadata, ["itemId", "reasoningEncryptedContent"])
}

function legacyReasoningCoreMatches(
  part: typeof PartTable.$inferSelect,
  data: Record<string, unknown>,
  evidence: LegacyReasoningEvidence,
) {
  if (
    !evidence.end ||
    !hasOnlyKeys(data, ["type", "text", "time", "metadata"]) ||
    String(evidence.start.data.assistantMessageID) !== part.message_id ||
    evidence.end.data.assistantMessageID !== evidence.start.data.assistantMessageID ||
    evidence.end.data.reasoningID !== evidence.start.data.reasoningID ||
    evidence.end.data.text !== data.text ||
    typeof data.text !== "string" ||
    !isRecord(data.time) ||
    !hasOnlyKeys(data.time, ["start", "end"]) ||
    data.time.start !== evidence.start.time ||
    (data.time.end !== evidence.end.time &&
      !(
        data.text === "" &&
        data.time.end === undefined &&
        evidence.end.time >= evidence.start.time &&
        evidence.end.time <= evidence.start.time + 1
      )) ||
    !legacyInsertionTimeMatches(part.time_created, evidence.start.time, 10, 60)
  )
    return false
  return true
}

function legacyStepFinishMatches(
  part: typeof PartTable.$inferSelect,
  data: Record<string, unknown>,
  evidence: LegacyStepEvidence,
) {
  if (
    !evidence.end ||
    !hasOnlyKeys(data, ["type", "reason", "snapshot", "cost", "tokens"]) ||
    !isRecord(data.tokens) ||
    !hasOnlyKeys(data.tokens, ["total", "input", "output", "reasoning", "cache"]) ||
    !isRecord(data.tokens.cache) ||
    !hasOnlyKeys(data.tokens.cache, ["read", "write"]) ||
    String(evidence.end.data.assistantMessageID) !== part.message_id ||
    evidence.end.data.snapshot !== data.snapshot ||
    evidence.end.data.finish !== data.reason ||
    evidence.end.data.cost !== data.cost ||
    evidence.end.data.tokens.input !== data.tokens.input ||
    evidence.end.data.tokens.output !== data.tokens.output ||
    evidence.end.data.tokens.reasoning !== data.tokens.reasoning ||
    evidence.end.data.tokens.cache.read !== data.tokens.cache.read ||
    evidence.end.data.tokens.cache.write !== data.tokens.cache.write ||
    !legacyInsertionTimeMatches(part.time_created, evidence.end.time, 1_500, 10)
  )
    return false
  const total =
    evidence.end.data.tokens.input +
    evidence.end.data.tokens.output +
    evidence.end.data.tokens.reasoning +
    evidence.end.data.tokens.cache.read +
    evidence.end.data.tokens.cache.write
  return data.tokens.total === undefined || data.tokens.total === total
}

function legacyPatchData(data: Record<string, unknown>) {
  if (
    !hasOnlyKeys(data, ["type", "hash", "files"]) ||
    typeof data.hash !== "string" ||
    !Array.isArray(data.files) ||
    data.files.length === 0 ||
    data.files.some((file) => {
      if (typeof file !== "string" || file.includes("\\") || (!/^[A-Za-z]:\//.test(file) && !file.startsWith("/")))
        return true
      return file
        .replace(/^[A-Za-z]:\//, "")
        .replace(/^\//, "")
        .split("/")
        .some((segment) => segment === "" || segment === "." || segment === "..")
    })
  )
    return false
  const files = data.files as string[]
  return new Set(files).size === files.length && isDeepStrictEqual(files, [...files].sort())
}

function legacyPatchCoreMatches(
  part: typeof PartTable.$inferSelect,
  data: Record<string, unknown>,
  evidence: LegacyStepEvidence,
) {
  return (
    evidence.end !== undefined &&
    hasOnlyKeys(data, ["type", "hash", "files"]) &&
    typeof data.hash === "string" &&
    Array.isArray(data.files) &&
    data.files.every((file) => typeof file === "string") &&
    String(evidence.start.data.assistantMessageID) === part.message_id &&
    (evidence.start.data.snapshot === data.hash ||
      (evidence.start.data.snapshot === undefined && legacyPatchData(data))) &&
    legacyInsertionTimeMatches(part.time_created, evidence.end.time, 500, 1)
  )
}

function legacyOpenAIMetadata(value: unknown, allowed: ReadonlyArray<string>) {
  if (!isRecord(value) || !hasOnlyKeys(value, ["openai"]) || !isRecord(value.openai)) return false
  if (
    !hasOnlyKeys(value.openai, allowed) ||
    typeof value.openai.itemId !== "string" ||
    value.openai.itemId.length === 0
  )
    return false
  return Object.entries(value.openai).every(([key, item]) => key === "itemId" || typeof item === "string")
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlyArray<string>) {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function legacyFileMatches(part: Record<string, unknown>, file: typeof SessionEvent.FileAttachment.Type) {
  if (file.description !== undefined || part.url !== file.uri || part.mime !== file.mime || part.filename !== file.name)
    return false
  return file.source === undefined
}

function legacyToolMatches(
  partRow: typeof PartTable.$inferSelect,
  part: Record<string, unknown>,
  evidence: LegacyToolEvidence,
  checkpointOnlyMetadata = false,
  compactionSettlements: LegacyPartEvidence["compactionSettlements"] = [],
  steps: LegacyPartEvidence["steps"] = [],
) {
  const insertionMatches =
    legacyInsertionTimeMatches(partRow.time_created, evidence.start.time, 600_000, 10) ||
    steps.some(
      (step) =>
        String(step.start.data.assistantMessageID) === partRow.message_id &&
        step.start.key < evidence.start.key &&
        (step.end === undefined || evidence.start.key < step.end.key) &&
        partRow.time_created >= step.start.time - 10 &&
        partRow.time_created <= evidence.start.time + 10,
    )
  const checkpointTerminal =
    checkpointOnlyMetadata &&
    isRecord(part.state) &&
    (part.state.status === "completed" || part.state.status === "error")
  if (
    evidence.invalid ||
    !hasOnlyKeys(part, ["type", "callID", "tool", "state", "metadata"]) ||
    evidence.assistantMessageID !== partRow.message_id ||
    part.callID !== evidence.callID ||
    part.tool !== evidence.name ||
    !isRecord(part.state) ||
    (!insertionMatches && !checkpointTerminal)
  )
    return false
  const state = part.state
  if (state.status === "pending")
    return (
      part.metadata === undefined &&
      hasOnlyKeys(state, ["status", "input", "raw"]) &&
      isRecord(state.input) &&
      Object.keys(state.input).length === 0 &&
      state.raw === "" &&
      evidence.input === undefined &&
      evidence.called === undefined
    )
  if (!evidence.input || !evidence.called || evidence.called.data.tool !== part.tool) return false
  const input =
    evidence.input.data.text === "" && Object.keys(evidence.called.data.input).length === 0
      ? {}
      : Option.getOrUndefined(
        Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(evidence.input.data.text),
      )
  if (!isRecord(input) || !isDeepStrictEqual(input, evidence.called.data.input)) return false
  if (!isDeepStrictEqual(evidence.called.data.input, state.input)) return false
  if (
    checkpointOnlyMetadata
      ? part.metadata !== undefined &&
        !legacyOpenAIMetadata(part.metadata, ["itemId"]) &&
        !legacyOpenRouterMetadata(part.metadata) &&
        !legacyProviderExecutedMetadata(part.metadata)
      : !legacyToolMetadataMatches(part.metadata, evidence.called.data.provider)
  )
    return false
  if (state.status === "running")
    return (
      hasOnlyKeys(state, ["status", "input", "title", "metadata", "time", "raw"]) &&
      (state.raw === undefined || state.raw === "") &&
      ((state.title === undefined && state.metadata === undefined) ||
        (checkpointOnlyMetadata && legacyRunningToolMetadataMatches(state))) &&
      isRecord(state.time) &&
      hasOnlyKeys(state.time, ["start"]) &&
      state.time.start === evidence.start.time &&
      !evidence.success &&
      !evidence.failed
    )
  if (state.status === "completed")
    return (
      !evidence.failed &&
      hasOnlyKeys(state, ["status", "input", "output", "title", "metadata", "time", "attachments", "raw"]) &&
      (state.raw === undefined || state.raw === "") &&
      isRecord(state.time) &&
      hasOnlyKeys(state.time, ["start", "end", "compacted"]) &&
      state.time.start === evidence.start.time &&
      (evidence.success
        ? state.time.end === evidence.success.time
        : checkpointOnlyMetadata && Number.isSafeInteger(state.time.end)) &&
      legacyToolCompactedMatches(
        partRow,
        state.time,
        evidence.success?.time,
        compactionSettlements,
        checkpointOnlyMetadata,
      ) &&
      legacyCompletedToolMatches(
        part.tool as string,
        state,
        evidence.called.data.input,
        evidence.success,
        checkpointOnlyMetadata,
      )
    )
  if (state.status === "error")
    return (
      !evidence.success &&
      hasOnlyKeys(state, ["status", "input", "error", "metadata", "time", "raw", "title"]) &&
      (state.raw === undefined || state.raw === "") &&
      isRecord(state.time) &&
      hasOnlyKeys(state.time, ["start", "end"]) &&
      state.time.start === evidence.start.time &&
      state.time.end === evidence.failed?.time &&
      legacyFailedToolMatches(part.tool as string, state, evidence.failed, evidence.called.data.input, checkpointOnlyMetadata)
    )
  return false
}

function legacyOpenRouterMetadata(value: unknown) {
  if (!isRecord(value) || !hasOnlyKeys(value, ["openrouter"]) || !isRecord(value.openrouter)) return false
  if (!hasOnlyKeys(value.openrouter, ["reasoning_details"]) || !Array.isArray(value.openrouter.reasoning_details))
    return false
  return value.openrouter.reasoning_details.every(
    (detail) =>
      isRecord(detail) &&
      hasOnlyKeys(detail, ["type", "text", "format", "index"]) &&
      typeof detail.type === "string" &&
      typeof detail.text === "string" &&
      typeof detail.format === "string" &&
      Number.isSafeInteger(detail.index) &&
      (detail.index as number) >= 0,
  )
}

function legacyProviderExecutedMetadata(value: unknown) {
  return isRecord(value) && hasOnlyKeys(value, ["providerExecuted"]) && value.providerExecuted === true
}

function legacyRunningToolMetadataMatches(state: Record<string, unknown>) {
  if (!isRecord(state.metadata)) return false
  if (typeof state.title === "string" && state.title.length > 0) return true
  return (
    state.title === undefined &&
    hasOnlyKeys(state.metadata, ["output", "description"]) &&
    typeof state.metadata.output === "string" &&
    isRecord(state.input) &&
    typeof state.input.description === "string" &&
    state.metadata.description === state.input.description
  )
}

function legacyToolCompactedMatches(
  part: typeof PartTable.$inferSelect,
  time: Record<string, unknown>,
  ended: number | undefined,
  settlements: LegacyPartEvidence["compactionSettlements"],
  checkpointOnly: boolean,
) {
  if (time.compacted === undefined) return true
  if (!checkpointOnly || ended === undefined || !Number.isSafeInteger(time.compacted)) return false
  if ((time.compacted as number) <= ended) return false
  return settlements.some((settlement) => {
    if (ended >= settlement.prompt || (time.compacted as number) < settlement.settled) return false
    if ((time.compacted as number) <= settlement.settled + 1_000) return true
    if (
      !settlement.terminal ||
      part.time_updated < (time.compacted as number) ||
      part.time_updated > (time.compacted as number) + 100
    )
      return false
    // The V1 compactor may prune completed tool payloads asynchronously after the final provider step. With no
    // following prompt, the terminal step plus the tightly batched compacted/update timestamps are the complete
    // durable bound. Production V1 batches finish within 88ms, so 100ms leaves only scheduling tolerance.
    return settlement.nextPrompt === undefined || (time.compacted as number) < settlement.nextPrompt
  })
}

function legacyToolMetadataMatches(
  value: unknown,
  provider: (typeof SessionEvent.Tool.Called.Type)["data"]["provider"],
) {
  if (value === undefined) return provider.metadata === undefined
  if (!isRecord(value) || !hasOnlyKeys(value, ["providerExecuted", "openai"])) return false
  if (value.providerExecuted !== undefined && value.providerExecuted !== provider.executed) return false
  if (provider.metadata !== undefined) {
    const metadata = { ...value }
    delete metadata.providerExecuted
    return isDeepStrictEqual(metadata, provider.metadata)
  }
  return value.openai === undefined || legacyOpenAIMetadata({ openai: value.openai }, ["itemId"])
}

function legacyCompletedToolMatches(
  tool: string,
  state: Record<string, unknown>,
  input: Record<string, unknown>,
  success: LegacyToolEvidence["success"],
  checkpointOnly: boolean,
) {
  if (typeof state.output !== "string" || typeof state.title !== "string" || !isRecord(state.metadata))
    return false
  if (!success) return false
  const text = success.data.content.filter((item) => item.type === "text")
  const files = success.data.content.filter((item) => item.type === "file")
  const attachments = Array.isArray(state.attachments) ? state.attachments : []
  const externalizedEventOutput =
    checkpointOnly &&
    text.length === 1 &&
    legacyExternalizedEventToolOutputMatches(state, success.data.structured, text[0]?.text)
  if (
    text.length !== 1 ||
    (text[0]?.text !== state.output && !externalizedEventOutput) ||
    files.length !== attachments.length ||
    (!isDeepStrictEqual(success.data.structured, state.metadata) &&
      (!checkpointOnly ||
        (!legacyMigratedToolOutputMatches(state.metadata, success.data.structured) && !externalizedEventOutput))) ||
    (!checkpointOnly && legacyToolTitle(success.data.result, tool, input, state.output) !== state.title)
  )
    return false
  return attachments.every((attachment, index) => {
    const file = files[index]
    return (
      isRecord(attachment) &&
      hasOnlyKeys(attachment, ["id", "sessionID", "messageID", "type", "mime", "filename", "url", "source"]) &&
      attachment.type === "file" &&
      attachment.source === undefined &&
      file?.type === "file" &&
      attachment.url === file.uri &&
      attachment.mime === file.mime &&
      attachment.filename === file.name
    )
  })
}

function legacyExternalizedEventToolOutputMatches(
  state: Record<string, unknown>,
  structured: unknown,
  preview: unknown,
) {
  if (
    typeof state.output !== "string" ||
    typeof preview !== "string" ||
    !isRecord(state.metadata) ||
    !isRecord(structured) ||
    !isRecord(structured.$opencode)
  )
    return false
  const reference = structured.$opencode.text
  if (
    !isRecord(reference) ||
    reference.type !== "content-reference" ||
    typeof reference.uri !== "string" ||
    !reference.uri.startsWith("attachment://") ||
    reference.mime !== "text/plain" ||
    reference.sizeBytes !== Buffer.byteLength(state.output, "utf8") ||
    reference.sizeBytes <= MAX_PERSISTED_CONTENT_PREVIEW_BYTES ||
    boundedPersistedContentPreview(state.output) !== preview
  )
    return false
  const metadata = { ...structured }
  const opencode = { ...structured.$opencode }
  delete opencode.text
  delete opencode.result
  if (Object.keys(opencode).length === 0) delete metadata.$opencode
  if (Object.keys(opencode).length > 0) metadata.$opencode = opencode
  return isDeepStrictEqual(metadata, state.metadata)
}

function legacyMigratedToolOutputMatches(metadata: Record<string, unknown>, structured: unknown) {
  if (!isRecord(metadata.$opencode) || !isRecord(structured) || !isRecord(structured.$opencode)) return false
  if (!isDeepStrictEqual(metadata.$opencode.output, structured.$opencode.text)) return false
  const expectedMetadata = { ...metadata }
  const expectedOpenCode = { ...metadata.$opencode }
  delete expectedOpenCode.output
  if (Object.keys(expectedOpenCode).length === 0) delete expectedMetadata.$opencode
  if (Object.keys(expectedOpenCode).length > 0) expectedMetadata.$opencode = expectedOpenCode
  const actualMetadata = { ...structured }
  const actualOpenCode = { ...structured.$opencode }
  delete actualOpenCode.text
  delete actualOpenCode.result
  if (Object.keys(actualOpenCode).length === 0) delete actualMetadata.$opencode
  if (Object.keys(actualOpenCode).length > 0) actualMetadata.$opencode = actualOpenCode
  return isDeepStrictEqual(expectedMetadata, actualMetadata)
}

function legacyToolTitle(result: unknown, tool: string, input: Record<string, unknown>, output: string) {
  if (isRecord(result) && isRecord(result.value) && typeof result.value.output === "string")
    return typeof result.value.title === "string" ? result.value.title : tool
  if (tool === "apply_patch") return output
  if (["bash", "task"].includes(tool) && typeof input.description === "string") return input.description
  if (tool === "question" && Array.isArray(input.questions))
    return `Asked ${input.questions.length} ${input.questions.length === 1 ? "question" : "questions"}`
  return tool
}

function legacyFailedToolMatches(
  tool: string,
  state: Record<string, unknown>,
  failed: LegacyToolEvidence["failed"],
  input: Record<string, unknown>,
  checkpointOnly: boolean,
) {
  if (!failed || typeof state.error !== "string" || failed.data.error.message !== state.error) return false
  const taskInterruption =
    checkpointOnly && failed.version === 1 && legacyTaskInterruptionMetadata(failed.data.sessionID, tool, state)
  if (state.title !== undefined && !taskInterruption) return false
  if (state.metadata === undefined) return failed.data.interruption === undefined
  if (!isRecord(state.metadata) || state.metadata.interrupted !== true) return false
  const simpleInterruption = hasOnlyKeys(state.metadata, ["interrupted"])
  const historicalInterruption =
    checkpointOnly &&
    failed.version === 1 &&
    ["Tool execution aborted", "Tool execution interrupted"].includes(state.error) &&
    hasOnlyKeys(state.metadata, ["interrupted", "output", "description"]) &&
    typeof state.metadata.output === "string" &&
    typeof input.description === "string" &&
    state.metadata.description === input.description
  if (!simpleInterruption && !historicalInterruption && !taskInterruption) return false
  if (failed.version === 2) return failed.data.interruption !== undefined
  return (
    !failed.data.provider.executed &&
    isRecord(failed.data.result) &&
    failed.data.result.type === "error" &&
    failed.data.result.value === state.error
  )
}

function legacyTaskInterruptionMetadata(sessionID: string, tool: unknown, state: Record<string, unknown>) {
  if (
    tool !== "task" ||
    state.status !== "error" ||
    state.error !== "Tool execution aborted" ||
    typeof state.title !== "string" ||
    !isRecord(state.input) ||
    state.input.description !== state.title ||
    !isRecord(state.metadata) ||
    !hasOnlyKeys(state.metadata, ["parentSessionId", "sessionId", "model", "interrupted"]) ||
    state.metadata.parentSessionId !== sessionID ||
    typeof state.metadata.sessionId !== "string" ||
    state.metadata.sessionId.length === 0 ||
    state.metadata.sessionId === sessionID ||
    state.metadata.interrupted !== true ||
    !isRecord(state.metadata.model) ||
    !hasOnlyKeys(state.metadata.model, ["modelID", "providerID"]) ||
    typeof state.metadata.model.modelID !== "string" ||
    state.metadata.model.modelID.length === 0 ||
    typeof state.metadata.model.providerID !== "string" ||
    state.metadata.model.providerID.length === 0
  )
    return false
  return true
}

function replayProjects(
  events: ReadonlyArray<EventV2.SerializedEvent>,
  expected: SessionProjection,
  previous: SessionProjection | undefined,
) {
  const movedType = SessionEvent.Moved.sync
    ? EventV2.versionedType(SessionEvent.Moved.type, SessionEvent.Moved.sync.version)
    : undefined
  return [
    { id: expected.session.project_id, directory: expected.session.directory },
    ...(previous ? [{ id: previous.session.project_id, directory: previous.session.directory }] : []),
    ...events.flatMap((event) => {
      if (event.type === sessionCreatedType) {
        const data = event.data as (typeof SessionV1.Event.Created.Type)["data"]
        return [{ id: data.info.projectID, directory: data.info.directory }]
      }
      if (event.type !== movedType) return []
      const data = event.data as (typeof SessionEvent.Moved.Type)["data"]
      if (!data.projectID) return []
      return [{ id: data.projectID, directory: data.location.directory }]
    }),
  ]
    .filter((project, index, projects) => projects.findIndex((candidate) => candidate.id === project.id) === index)
    .map((project) => ({
      id: project.id,
      worktree: AbsolutePath.make(project.directory),
      name: "checkpoint replay",
      sandboxes: [],
      time_created: expected.session.time_created,
      time_updated: expected.session.time_created,
    }))
}

function projectionForParity(
  projection: SessionProjection,
  options: { readonly includeContextEpoch: boolean; readonly normalizeLegacyProjection: boolean },
): SessionProjection {
  // An initial replay can cover rows written before deterministic projection timestamps existed. A current
  // checkpoint is already a trustworthy baseline, so every timestamp in its tail must remain strict.
  const timestamp = (value: number) => (options.normalizeLegacyProjection ? 0 : value)
  return {
    ...projection,
    // Historical Windows events used native separators while startup normalization persisted forward slashes.
    session: options.normalizeLegacyProjection
      ? { ...projection.session, directory: projection.session.directory.replaceAll("\\", "/") }
      : projection.session,
    // The first epoch is initialized outside the event stream. Once checkpointed, its tail mutations remain strict.
    ...(options.includeContextEpoch ? {} : { contextEpoch: undefined }),
    legacyMessages: projection.legacyMessages.map((row) => ({ ...row, time_updated: timestamp(row.time_updated) })),
    legacyParts: projection.legacyParts.map((row) => ({
      ...row,
      time_updated: timestamp(row.time_updated),
      data: options.normalizeLegacyProjection ? normalizeLegacyPartData(row.data) : row.data,
    })),
    messages: projection.messages.map((row) => {
      if (row.type !== "assistant") return { ...row, time_updated: timestamp(row.time_updated) }
      const data = { ...row.data } as Record<string, unknown>
      if (data.snapshot && typeof data.snapshot === "object") {
        const snapshot = Object.fromEntries(
          Object.entries(data.snapshot).filter(([, value]) => value !== "" && value !== undefined),
        )
        if (Object.keys(snapshot).length === 0) delete data.snapshot
        if (Object.keys(snapshot).length > 0) data.snapshot = snapshot
      }
      return { ...row, time_updated: timestamp(row.time_updated), data: data as typeof row.data }
    }),
  }
}

function normalizeMigratedLegacyToolOutputParity(expected: SessionProjection, actual: SessionProjection) {
  if (
    expected.legacyParts.length !== actual.legacyParts.length ||
    expected.legacyParts.some((row, index) => row.id !== actual.legacyParts[index]?.id)
  )
    return { expected, actual }
  const parts = expected.legacyParts.map((row, index) =>
    normalizeMigratedLegacyToolOutput(row.data, actual.legacyParts[index].data),
  )
  return {
    expected: {
      ...expected,
      legacyParts: expected.legacyParts.map((row, index) => ({ ...row, data: parts[index].expected })),
    },
    actual: {
      ...actual,
      legacyParts: actual.legacyParts.map((row, index) => ({ ...row, data: parts[index].actual })),
    },
  }
}

function normalizeCheckpointToolParity(
  expected: SessionProjection,
  actual: SessionProjection,
  checkpointOnlyIDs: ReadonlySet<string>,
) {
  const structured = new Map(
    expected.legacyParts.flatMap((part) => {
      const data = part.data as unknown
      if (!checkpointOnlyIDs.has(part.id) || !isRecord(data) || data.type !== "tool" || typeof data.callID !== "string")
        return []
      if (!isRecord(data.state) || !isRecord(data.state.metadata)) return []
      if (
        data.state.status !== "running" &&
        !legacyTaskInterruptionMetadata(part.session_id, data.tool, data.state)
      )
        return []
      return [[data.callID, data.state.metadata] as const]
    }),
  )
  if (structured.size === 0) return { expected, actual }
  const messages = expected.messages.map((row) => {
    const actualRow = actual.messages.find((candidate) => candidate.id === row.id)
    const data = row.data as unknown
    const actualData = actualRow?.data as unknown
    if (!isRecord(data) || !Array.isArray(data.content) || !isRecord(actualData) || !Array.isArray(actualData.content))
      return row
    const expectedContent = data.content
    const actualContent = actualData.content
    const content = expectedContent.map((item: unknown) => {
      if (!isRecord(item) || item.type !== "tool" || typeof item.id !== "string" || !isRecord(item.state)) return item
      if (!isDeepStrictEqual(item.state.structured, structured.get(item.id))) return item
      const actualItem = actualContent.find(
        (candidate: unknown) => isRecord(candidate) && candidate.type === "tool" && candidate.id === item.id,
      )
      if (
        !isRecord(actualItem) ||
        !isRecord(actualItem.state) ||
        actualItem.state.status !== item.state.status
      )
        return item
      if (!isRecord(actualItem.state.structured) || Object.keys(actualItem.state.structured).length > 0) return item
      const normalized = { ...item, state: { ...item.state, structured: actualItem.state.structured } }
      return isDeepStrictEqual(normalized, actualItem) ? normalized : item
    })
    if (content.every((item, index) => item === expectedContent[index])) return row
    return { ...row, data: { ...data, content } as unknown as typeof row.data }
  })
  return { expected: { ...expected, messages }, actual }
}

function normalizeLegacyInterruptedToolParity(
  expected: SessionProjection,
  actual: SessionProjection,
  events: ReadonlyArray<EventV2.SerializedEvent>,
) {
  const callIDs = new Set(
    events.flatMap((event) => {
      if (event.type !== toolFailedV1Type) return []
      const data = event.data as (typeof SessionEvent.Tool.FailedV1.Type)["data"]
      if (
        data.provider.executed ||
        data.result !== undefined ||
        !["Tool execution aborted", "Tool execution interrupted"].includes(data.error.message)
      )
        return []
      return [data.callID]
    }),
  )
  if (callIDs.size === 0) return { expected, actual }
  const expectedMessages = new Map(expected.messages.map((message) => [message.id, message]))
  const messages = actual.messages.map((message) => {
    const expectedMessage = expectedMessages.get(message.id)
    const data = message.data as unknown
    const expectedData = expectedMessage?.data as unknown
    if (!isRecord(data) || !Array.isArray(data.content) || !isRecord(expectedData) || !Array.isArray(expectedData.content))
      return message
    const actualContent = data.content
    const expectedContent = expectedData.content
    const content = actualContent.map((item: unknown) => {
      if (!isRecord(item) || item.type !== "tool" || typeof item.id !== "string" || !callIDs.has(item.id)) return item
      const wanted = expectedContent.find(
        (candidate: unknown) => isRecord(candidate) && candidate.type === "tool" && candidate.id === item.id,
      )
      if (!isRecord(wanted) || !isRecord(wanted.state) || !isRecord(item.state)) return item
      if (wanted.state.status !== "error" || item.state.status !== "error") return item
      if (!isRecord(wanted.state.structured) || !isRecord(item.state.structured)) return item
      if (Object.hasOwn(wanted.state.structured, "interrupted") || item.state.structured.interrupted !== true) return item
      const structured = { ...item.state.structured }
      delete structured.interrupted
      const normalized = { ...item, state: { ...item.state, structured } }
      return isDeepStrictEqual(normalized, wanted) ? normalized : item
    })
    if (content.every((item, index) => item === actualContent[index])) return message
    return { ...message, data: { ...data, content } as unknown as typeof message.data }
  })
  return { expected, actual: { ...actual, messages } }
}

function normalizeMigratedLegacyToolOutput(
  expectedData: (typeof PartTable.$inferSelect)["data"],
  actualData: (typeof PartTable.$inferSelect)["data"],
) {
  const expected = expectedData as unknown as Record<string, unknown>
  const actual = actualData as unknown as Record<string, unknown>
  if (expected.type !== "tool" || actual.type !== "tool" || !isRecord(expected.state) || !isRecord(actual.state))
    return { expected: expectedData, actual: actualData }
  if (typeof expected.state.output !== "string" || typeof actual.state.output !== "string")
    return { expected: expectedData, actual: actualData }
  if (!isRecord(expected.state.metadata) || !isRecord(expected.state.metadata.$opencode))
    return { expected: expectedData, actual: actualData }
  const reference = expected.state.metadata.$opencode.output
  if (
    !isRecord(reference) ||
    reference.type !== "content-reference" ||
    typeof reference.uri !== "string" ||
    !reference.uri.startsWith("attachment://") ||
    reference.mime !== "text/plain" ||
    typeof reference.sizeBytes !== "number" ||
    !Number.isSafeInteger(reference.sizeBytes) ||
    reference.sizeBytes <= MAX_PERSISTED_CONTENT_PREVIEW_BYTES
  )
    return { expected: expectedData, actual: actualData }
  const duplicatedMetadataOutput =
    expected.state.metadata.output === expected.state.output &&
    isRecord(actual.state.metadata) &&
    actual.state.metadata.output === actual.state.output

  if (
    isRecord(actual.state.metadata) &&
    isRecord(actual.state.metadata.$opencode) &&
    isDeepStrictEqual(reference, actual.state.metadata.$opencode.text) &&
    actual.state.output === expected.state.output
  ) {
    const expectedMetadata = { ...expected.state.metadata }
    const expectedOpenCode = { ...expected.state.metadata.$opencode }
    delete expectedOpenCode.output
    if (Object.keys(expectedOpenCode).length === 0) delete expectedMetadata.$opencode
    if (Object.keys(expectedOpenCode).length > 0) expectedMetadata.$opencode = expectedOpenCode
    const actualMetadata = { ...actual.state.metadata }
    const actualOpenCode = { ...actual.state.metadata.$opencode }
    delete actualOpenCode.text
    delete actualOpenCode.result
    if (duplicatedMetadataOutput) actualMetadata.output = expected.state.metadata.output
    if (Object.keys(actualOpenCode).length === 0) delete actualMetadata.$opencode
    if (Object.keys(actualOpenCode).length > 0) actualMetadata.$opencode = actualOpenCode
    return {
      expected: { ...expectedData, state: { ...expected.state, metadata: expectedMetadata } } as typeof expectedData,
      actual: { ...actualData, state: { ...actual.state, metadata: actualMetadata } } as typeof actualData,
    }
  }

  if (
    Buffer.byteLength(actual.state.output, "utf8") !== reference.sizeBytes ||
    boundedPersistedContentPreview(actual.state.output) !== expected.state.output
  )
    return { expected: expectedData, actual: actualData }

  // Older staged candidates externalized only the projected part. Its attachment bytes and hash are validated
  // separately before activation while replay still produces the original full event output.
  const opencode = { ...expected.state.metadata.$opencode }
  delete opencode.output
  const metadata = { ...expected.state.metadata }
  if (Object.keys(opencode).length === 0) delete metadata.$opencode
  if (Object.keys(opencode).length > 0) metadata.$opencode = opencode
  return {
    expected: {
      ...expectedData,
      state: { ...expected.state, metadata },
    } as typeof expectedData,
    actual: {
      ...actualData,
      state: {
        ...actual.state,
        output: expected.state.output,
        ...(duplicatedMetadataOutput && isRecord(actual.state.metadata)
          ? { metadata: { ...actual.state.metadata, output: expected.state.metadata.output } }
          : {}),
      },
    } as typeof actualData,
  }
}

function normalizeLegacyPartData(data: (typeof PartTable.$inferSelect)["data"]) {
  const value = data as unknown as Record<string, unknown>
  if (value.type !== "tool" || !isRecord(value.state)) return data
  const state = value.state
  if (state.status === "pending" || state.raw !== "") return data
  const normalized = { ...state }
  delete normalized.raw
  return { ...data, state: normalized } as typeof data
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function describeProjectionMismatch(expected: SessionProjection, actual: SessionProjection | undefined) {
  if (!actual) return "projection is missing"
  const sections = ["session", "legacyMessages", "legacyParts", "messages", "inputs", "contextEpoch"] as const
  const section = sections.find((key) => !isDeepStrictEqual(actual[key], expected[key]))
  if (!section) return "projection differs"
  if (!Array.isArray(expected[section]) || !Array.isArray(actual[section])) {
    const expectedValue = expected[section]
    const actualValue = actual[section]
    if (expectedValue && actualValue && typeof expectedValue === "object" && typeof actualValue === "object") {
      const field = Object.keys(expectedValue).find(
        (key) => !isDeepStrictEqual(expectedValue[key as keyof typeof expectedValue], actualValue[key as keyof typeof actualValue]),
      )
      if (field) {
        const wanted = expectedValue[field as keyof typeof expectedValue]
        const received = actualValue[field as keyof typeof actualValue]
        return describeNestedMismatch(wanted, received, `${section}.${field}`)
      }
    }
    return `${section} differs`
  }
  const expectedRows = expected[section] as ReadonlyArray<unknown>
  const actualRows = actual[section] as ReadonlyArray<unknown>
  if (expectedRows.length !== actualRows.length) {
    const expectedIDs = expectedRows.flatMap((row) =>
      isRecord(row) && typeof row.id === "string" ? [row.id] : [],
    )
    const actualIDs = new Set(
      actualRows.flatMap((row) => (isRecord(row) && typeof row.id === "string" ? [row.id] : [])),
    )
    const missing = expectedIDs.filter((id) => !actualIDs.has(id)).slice(0, 8)
    const known = new Set(expectedIDs)
    const extra = actualRows
      .flatMap((row) => (isRecord(row) && typeof row.id === "string" && !known.has(row.id) ? [row.id] : []))
      .slice(0, 8)
    const details = [
      missing.length > 0 ? `missing IDs ${missing.join(", ")}` : "",
      extra.length > 0 ? `extra IDs ${extra.join(", ")}` : "",
    ].filter(Boolean)
    return `${section} count differs (expected ${expectedRows.length}, actual ${actualRows.length})${details.length > 0 ? `; ${details.join("; ")}` : ""}`
  }
  const index = expectedRows.findIndex((value, item) => !isDeepStrictEqual(value, actualRows[item]))
  const wanted = expectedRows[index]
  const received = actualRows[index]
  if (wanted && received && typeof wanted === "object" && typeof received === "object") {
    const field = Object.keys(wanted).find(
      (key) => !isDeepStrictEqual(wanted[key as keyof typeof wanted], received[key as keyof typeof received]),
    )
    if (field) {
      const expectedField = wanted[field as keyof typeof wanted]
      const actualField = received[field as keyof typeof received]
      return describeNestedMismatch(expectedField, actualField, `${section}[${index}].${field}`)
    }
  }
  return `${section}[${index}] differs`
}

function describeNestedMismatch(expected: unknown, actual: unknown, path: string, depth = 0): string {
  if (depth >= 6) return `${path} differs`
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length)
      return `${path} count differs (expected ${expected.length}, actual ${actual.length})`
    const index = expected.findIndex((value, item) => !isDeepStrictEqual(value, actual[item]))
    return index < 0 ? `${path} differs` : describeNestedMismatch(expected[index], actual[index], `${path}[${index}]`, depth + 1)
  }
  if (expected && actual && typeof expected === "object" && typeof actual === "object") {
    const keys = Array.from(new Set([...Object.keys(expected), ...Object.keys(actual)])).sort()
    const key = keys.find(
      (item) => !isDeepStrictEqual((expected as Record<string, unknown>)[item], (actual as Record<string, unknown>)[item]),
    )
    return key
      ? describeNestedMismatch(
          (expected as Record<string, unknown>)[key],
          (actual as Record<string, unknown>)[key],
          `${path}.${key}`,
          depth + 1,
        )
      : `${path} differs`
  }
  if (typeof expected === "string" && typeof actual === "string")
    return `${path} differs (string lengths ${expected.length} and ${actual.length})`
  return `${path} differs (expected ${String(expected)}, actual ${String(actual)})`
}

function registerProjectors(options: LayerOptions) {
  return Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    if (options.registerCheckpointAdapter !== false) yield* events.registerCheckpointAdapter({
      id: checkpointAdapterID,
      version: checkpointAdapterVersion,
      capture: (aggregateID) =>
        captureProjection(db, aggregateID).pipe(
          Effect.map((projection) =>
            projection
              ? {
                  adapter: checkpointAdapterID,
                  version: checkpointAdapterVersion,
                  data: checkpointProjection(projection) as unknown as Record<string, unknown>,
                }
              : undefined,
          ),
        ),
      upgrade: (baseline) =>
        Effect.sync(() => ({
          adapter: checkpointAdapterID,
          version: checkpointAdapterVersion,
          data: checkpointProjection(readProjection(baseline)) as unknown as Record<string, unknown>,
        })),
      normalize: (input) => normalizeActiveCheckpoint(db, input),
      hydrate: (input) => hydrateActiveCheckpoint(db, input),
      restore: (aggregateID, baseline) => restoreProjection(db, aggregateID, baseline),
      verify: options.checkpointVerificationWorker ?? verifyProjection,
    })
    yield* events.beforeCommit((event) => SessionInput.guardReservedID(db, event))
    yield* events.beforeCommit((event) => {
      if (event.type !== SessionEvent.TitleUpdated.type) return Effect.void
      const expected = event.metadata?.[SessionEvent.GeneratedTitleExpectedMetadataKey]
      if (typeof expected !== "string") return Effect.void
      return db
        .select({ title: SessionTable.title })
        .from(SessionTable)
        .where(eq(SessionTable.id, (event.data as { sessionID: SessionSchema.ID }).sessionID))
        .get()
        .pipe(
          Effect.orDie,
          Effect.flatMap((session) =>
            session?.title === expected ? Effect.void : Effect.die(new SessionEvent.GeneratedTitleSuperseded()),
          ),
        )
    })
    yield* events.beforeCommit((event) => {
      if (event.type !== SessionEvent.ModelSwitched.type) return Effect.void
      // Compare-and-switch bound to the observed persisted model. The expected
      // value is the runner-owned internal Ref metadata; malformed or missing
      // metadata belongs to unrelated switches and skips the guard. The
      // comparison is the same semantic model equality as durable prompt
      // admission (SessionInput): id and provider equal, absent variants
      // normalized to "default" (SessionInfo materializes them), and chain
      // state compared in full — a newer chain revision of the same base model
      // is still a conflicting switch.
      const expected = event.metadata?.[SessionEvent.ModelSwitchedExpectedMetadataKey]
      if (!Schema.is(ModelV2.Ref)(expected)) return Effect.void
      return db
        .select({ model: SessionTable.model })
        .from(SessionTable)
        .where(eq(SessionTable.id, (event.data as { sessionID: SessionSchema.ID }).sessionID))
        .get()
        .pipe(
          Effect.orDie,
          Effect.flatMap((session) => {
            const stored = session?.model
            const matches =
              stored !== undefined &&
              stored !== null &&
              stored.id === expected.id &&
              stored.providerID === expected.providerID &&
              (stored.variant ?? "default") === (expected.variant ?? "default") &&
              JSON.stringify(stored.chain) === JSON.stringify(expected.chain)
            return matches ? Effect.void : Effect.die(new SessionEvent.ModelSwitchSuperseded())
          }),
        )
    })
    yield* events.project(SessionV1.Event.Created, (event) =>
      Effect.gen(function* () {
        const stored = yield* db
          .insert(SessionTable)
          .values(sessionRow(event.data.info))
          .onConflictDoNothing()
          .returning({ sessionID: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!stored) return yield* Effect.die(new SessionAlreadyProjected())
        if (event.data.info.workspaceID) {
          yield* db
            .update(WorkspaceTable)
            .set({ time_used: Date.now() })
            .where(eq(WorkspaceTable.id, event.data.info.workspaceID))
            .run()
            .pipe(Effect.orDie)
        }
      }),
    )
    yield* events.project(SessionV1.Event.Updated, (event) =>
      db
        .update(SessionTable)
        .set(sessionRow(event.data.info))
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* events.project(SessionEvent.Moved, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({
            ...(event.data.projectID ? { project_id: event.data.projectID } : {}),
            directory: event.data.location.directory,
            path: event.data.subdirectory,
            workspace_id: event.data.location.workspaceID ? WorkspaceV2.ID.make(event.data.location.workspaceID) : null,
            time_updated: DateTime.toEpochMillis(event.data.timestamp),
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* SessionContextEpoch.reset(db, event.data.sessionID)
      }),
    )
    yield* events.project(SessionEvent.ProjectAssigned, (event) =>
      db
        .update(SessionTable)
        .set({ project_id: event.data.projectID, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* events.project(SessionEvent.TitleUpdated, (event) =>
      db
        .update(SessionTable)
        .set({ title: event.data.title, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* events.project(SessionEvent.MetadataPatched, (event) =>
      Effect.gen(function* () {
        const row = yield* db
          .select({ metadata: SessionTable.metadata })
          .from(SessionTable)
          .where(eq(SessionTable.id, event.data.sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!row) return
        const metadata = { ...(row.metadata ?? {}), ...(event.data.set ?? {}) }
        for (const key of event.data.unset ?? []) delete metadata[key]
        yield* db
          .update(SessionTable)
          .set({ metadata, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionEvent.ShareUpdated, (event) =>
      db
        .update(SessionTable)
        .set({ share_url: event.data.share?.url ?? null, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* events.project(SessionEvent.SummaryUpdated, (event) =>
      db
        .update(SessionTable)
        .set({
          summary_additions: event.data.summary?.additions ?? null,
          summary_deletions: event.data.summary?.deletions ?? null,
          summary_files: event.data.summary?.files ?? null,
          summary_diffs: event.data.summary?.diffs ? [...event.data.summary.diffs] : null,
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* events.project(SessionV1.Event.Deleted, (event) =>
      db.delete(SessionTable).where(eq(SessionTable.id, event.data.sessionID)).run().pipe(Effect.orDie),
    )
    yield* events.project(SessionV1.Event.MessageUpdated, (event) =>
      Effect.gen(function* () {
        const time_created = event.data.info.time.created
        const time_updated = event.data.info.role === "assistant"
          ? event.data.info.time.completed ?? time_created
          : time_created
        const id = event.data.info.id
        const sessionID = event.data.info.sessionID
        const data = messageData(event.data.info)
        yield* db
          .insert(MessageTable)
          .values({ id, session_id: sessionID, time_created, time_updated, data })
          .onConflictDoUpdate({ target: MessageTable.id, set: { time_updated, data } })
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.MessageRemoved, (event) =>
      Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.message_id, event.data.messageID), eq(PartTable.session_id, event.data.sessionID)))
          .all()
          .pipe(Effect.orDie)
        for (const row of rows) {
          const previous = usage(row.data)
          if (previous && !(yield* hasV2Usage(db, event.data.sessionID, row.message_id, previous)))
            yield* applyUsage(db, event.data.sessionID, previous, -1)
        }
        yield* db
          .delete(MessageTable)
          .where(and(eq(MessageTable.id, event.data.messageID), eq(MessageTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.PartRemoved, (event) =>
      Effect.gen(function* () {
        const row = yield* db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.id, event.data.partID), eq(PartTable.session_id, event.data.sessionID)))
          .get()
          .pipe(Effect.orDie)
        const previous = row && usage(row.data)
        if (previous && !(yield* hasV2Usage(db, event.data.sessionID, row.message_id, previous)))
          yield* applyUsage(db, event.data.sessionID, previous, -1)
        yield* db
          .delete(PartTable)
          .where(and(eq(PartTable.id, event.data.partID), eq(PartTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.PartUpdated, (event) =>
      Effect.gen(function* () {
        const id = event.data.part.id
        const messageID = event.data.part.messageID
        const sessionID = event.data.part.sessionID
        const data = partData(event.data.part)
        const next = usage(event.data.part)
        const row = next
          ? yield* db.select().from(PartTable).where(eq(PartTable.id, id)).get().pipe(Effect.orDie)
          : undefined
        yield* db
          .insert(PartTable)
          .values({
            id,
            message_id: messageID,
            session_id: sessionID,
            time_created: event.data.time,
            time_updated: event.data.time,
            data,
          })
          .onConflictDoUpdate({ target: PartTable.id, set: { time_updated: event.data.time, data } })
          .run()
          .pipe(Effect.orDie)
        const previous = row && usage(row.data)
        if (previous && !(yield* hasV2Usage(db, row.session_id, row.message_id, previous)))
          yield* applyUsage(db, row.session_id, previous, -1)
        if (next && !(yield* hasV2Usage(db, sessionID, messageID, next))) yield* applyUsage(db, sessionID, next)
      }),
    )
    yield* events.project(SessionEvent.AgentSwitched, (event) => {
      if (event.seq === undefined) return Effect.die("Synchronized Session event is missing aggregate sequence")
      return db
        .update(SessionTable)
        .set({ agent: event.data.agent, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(
          Effect.orDie,
          Effect.andThen(run(db, event)),
          Effect.andThen(SessionContextEpoch.requestReplacement(db, event.data.sessionID, event.seq)),
        )
    })
    yield* events.project(SessionEvent.ModelSwitched, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({
            model: {
              ...event.data.model,
              chain: event.data.model.chain === null
                ? null
                : event.data.model.chain
                  ? {
                      ...event.data.model.chain,
                      steps: event.data.model.chain.steps.map((step) => ({ ...step })),
                    }
                  : undefined,
            },
            time_updated: DateTime.toEpochMillis(event.data.timestamp),
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* run(db, event)
        if (event.seq === undefined)
          return yield* Effect.die("Synchronized Session event is missing aggregate sequence")
        yield* SessionContextEpoch.requestReplacement(db, event.data.sessionID, event.seq)
      }),
    )
    yield* events.project(SessionEvent.Prompted, (event) =>
      Effect.gen(function* () {
        const messageID = event.data.messageID
        const existing = yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, messageID))
          .get()
          .pipe(Effect.orDie)
        if (existing) return yield* Effect.die(new PromptAlreadyProjected())
        yield* run(db, event)
        if (event.seq === undefined)
          return yield* Effect.die("Synchronized Session event is missing aggregate sequence")
        yield* SessionInput.projectLegacyPrompted(db, {
          id: messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
          promotedSeq: event.seq,
        })
      }),
    )
    yield* events.project(SessionEvent.PromptLifecycle.Admitted, (event) =>
      Effect.gen(function* () {
        if (event.seq === undefined)
          return yield* Effect.die("Synchronized Session event is missing aggregate sequence")
        yield* touchSession(db, event)
        yield* SessionInput.projectAdmitted(db, {
          admittedSeq: event.seq,
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
        })
      }),
    )
    yield* events.project(SessionEvent.PromptLifecycle.Held, (event) =>
      SessionInput.projectHeld(db, {
        sessionID: event.data.sessionID,
        inputIDs: event.data.inputIDs,
        heldAt: event.data.timestamp,
      }),
    )
    yield* events.project(SessionEvent.PromptLifecycle.Released, (event) =>
      SessionInput.projectReleased(db, {
        sessionID: event.data.sessionID,
        id: event.data.messageID,
        prompt: event.data.prompt,
      }),
    )
    yield* events.project(SessionEvent.PromptLifecycle.Promoted, (event) =>
      Effect.gen(function* () {
        if (event.seq === undefined)
          return yield* Effect.die("Synchronized Session event is missing aggregate sequence")
        yield* insertMessage(
          db,
          event,
          yield* SessionInput.projectPromoted(db, {
            id: event.data.messageID,
            sessionID: event.data.sessionID,
            prompt: event.data.prompt,
            timeCreated: event.data.timeCreated,
            promotedSeq: event.seq,
          }),
        )
      }),
    )
    yield* events.project(SessionEvent.InterruptRequested, () => Effect.void)
    yield* events.project(SessionEvent.ContextUpdated, (event) => {
      if (!event.replay || event.seq === undefined) return run(db, event)
      return run(db, event).pipe(
        Effect.andThen(SessionContextEpoch.requestReplacement(db, event.data.sessionID, event.seq)),
      )
    })
    yield* events.project(SessionEvent.Synthetic, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Ended, (event) =>
      run(db, event).pipe(
        Effect.andThen(applyStepUsage(db, event)),
      ),
    )
    yield* events.project(SessionEvent.Step.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Custom.Added, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Called, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Progress, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Success, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Retried, (event) => touchSession(db, event))
    yield* events.project(SessionEvent.Revert.Marked, (event) =>
      db
        .update(SessionTable)
        .set({ revert: event.data.revert, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.andThen(SessionInput.projectDiscardPending(db, event.data.sessionID))),
    )
    yield* events.project(SessionEvent.Revert.Cleared, (event) =>
      db
        .update(SessionTable)
        .set({ revert: null, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* events.project(SessionEvent.Revert.Cleaned, (event) => cleanupRevert(db, event.data))
    yield* events.project(SessionEvent.Compaction.Ended, (event) => {
      if (event.version === 1) return Effect.void
      const seq = event.seq
      if (seq === undefined) return Effect.die("Synchronized Session event is missing aggregate sequence")
      return Effect.gen(function* () {
        yield* run(db, event)
        yield* SessionContextEpoch.requestReplacement(db, event.data.sessionID, seq)
      })
    })
    yield* events.project(SessionEvent.Activity.Started, () => Effect.void)
    yield* events.project(SessionEvent.Activity.Recovered, () => Effect.void)
    yield* events.project(SessionEvent.Activity.Interrupted, (event) => touchSession(db, event))
    yield* events.project(SessionEvent.Activity.Completed, (event) => touchSession(db, event))
    yield* events.project(SessionEvent.Activity.Failed, (event) =>
      Effect.gen(function* () {
        const seq = event.seq
        if (seq === undefined) return yield* Effect.die("Synchronized Session event is missing aggregate sequence")
        const latest = yield* db
          .select()
          .from(SessionMessageTable)
          .where(and(eq(SessionMessageTable.session_id, event.data.sessionID), lt(SessionMessageTable.seq, seq)))
          .orderBy(desc(SessionMessageTable.seq))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        if (latest?.type === "assistant") yield* run(db, event)
        yield* touchSession(db, event)
        if (latest?.type !== "user" || event.version !== 2) return
        const session = yield* db
          .select({ agent: SessionTable.agent, model: SessionTable.model })
          .from(SessionTable)
          .where(eq(SessionTable.id, event.data.sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!session) return
        yield* insertMessage(
          db,
          event,
          new SessionMessage.Assistant({
            id: SessionMessage.ID.make(`msg_activity_failure_${event.data.activityID}`),
            type: "assistant",
            agent: session.agent ?? "build",
            model: session.model
              ? {
                  id: ModelV2.ID.make(session.model.id),
                  providerID: ProviderV2.ID.make(session.model.providerID),
                  variant: session.model.variant ? ModelV2.VariantID.make(session.model.variant) : undefined,
                }
              : { id: ModelV2.ID.make("unknown"), providerID: ProviderV2.ID.make("unknown") },
            content: [],
            finish: "error",
            error: event.data.error,
            failure: event.data.failure,
            time: { created: event.data.timestamp, completed: event.data.timestamp },
          }),
        )
      }),
    )
  })
}

export const makeLayer = (
  options: LayerOptions = {},
): Layer.Layer<never, never, EventV2.Service | Database.Service> => Layer.effectDiscard(registerProjectors(options))

export const layer = makeLayer()

export const defaultLayer = layer.pipe(Layer.provide(EventV2.defaultLayer), Layer.provide(Database.defaultLayer))
export const node = LayerNode.make(layer, [EventV2.node, Database.node])
