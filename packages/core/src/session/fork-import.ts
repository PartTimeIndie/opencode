export * as SessionForkImport from "./fork-import"

import { and, desc, eq, gt, lte } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { AttachmentTable, ContentBlobTable } from "../attachment.sql"
import { ContentStore } from "../content-store"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { EventSequenceTable, EventTable } from "../event/sql"
import { isRecord } from "../util/record"
import { SessionEvent } from "./event"
import { SessionFork } from "./fork"
import { TaskContext } from "./task-context"
import { SessionForkAttachmentID } from "./fork-attachment-id"
import { SessionForkEvent } from "./fork-event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import {
  SessionActivityTable,
  SessionContextEpochTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
} from "./sql"

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("SessionForkImport.Conflict", {
  reason: Schema.Literals(["child", "changed", "attachment", "prepared"]),
}) {
  override get message() { return `Session fork import refused (${this.reason})` }
}

type DB = Database.Interface["db"]
type Attachment = (typeof SessionForkEvent.AttachmentsImported.Type)["data"]["attachments"][number]
type ImportData = {
  readonly db: DB
  readonly childSessionID: SessionSchema.ID
  readonly captured: SessionFork.Capture
  readonly context: TaskContext.Mode
  readonly dispatch?: SessionFork.Dispatch
  readonly dispatchDigest?: string
  readonly entries: ReadonlyArray<{
    sourceSeq: number
    sourceMessageID: SessionMessage.ID
    message: SessionMessage.Message
  }>
  readonly attachments: Attachment[]
  readonly originalAttachments: Array<typeof AttachmentTable.$inferSelect>
}
const preparedImports = new WeakMap<object, ImportData>()

/** Prepare immutable attachment bytes outside the write transaction. This only
 * prepares history: it does not create a Session, attest a task or start work. */
export const prepare = Effect.fn("SessionForkImport.prepare")(function* (
  db: DB,
  content: ContentStore.Interface,
  input: {
    readonly sourceSessionID: SessionSchema.ID
    readonly throughSeq: number
    readonly childSessionID: SessionSchema.ID
    readonly dispatch?: SessionFork.Dispatch
    readonly dispatchDigest?: string
    readonly context?: TaskContext.Mode
  },
) {
  if (input.sourceSessionID === input.childSessionID) return yield* new Conflict({ reason: "child" })
  // Capture immutable boundary values before attachment I/O can yield to the caller.
  const dispatch = input.dispatch && { ...input.dispatch }
  const context = input.context ?? "fork"
  const dispatchDigest = input.dispatchDigest
  if (dispatchDigest !== undefined && (!dispatch || !/^[a-f0-9]{64}$/.test(dispatchDigest)))
    return yield* new Conflict({ reason: "prepared" })
  const captured = yield* SessionFork.capture(db, {
    sessionID: input.sourceSessionID,
    throughSeq: input.throughSeq,
    dispatch,
    context,
  })
  const source = captured.entries
  const ids = new Map(source.map(({ message }) => [message.id, SessionMessage.ID.create()]))
  const encoded = source.map(({ seq, message }) => {
    const { metadata: _metadata, ...history } = Schema.encodeSync(SessionMessage.Message)(message)
    // Drop presentation/capability metadata before collecting attachment links.
    // Provider tool IDs remain paired historical wire identifiers, not globally
    // owned Message IDs; retaining them also preserves the cacheable prefix.
    return {
      seq,
      message:
        history.type === "assistant"
          ? {
              ...history,
              snapshot: undefined,
              // These were paid by the source Session. Keeping them as child
              // accounting would let later history cleanup refund foreign usage.
              cost: undefined,
              tokens: undefined,
              tokenMeasurement: undefined,
              content: history.content.filter((part) => part.type !== "custom"),
            }
          : history,
    }
  })
  const references = new Set<string>()
  const required = new Set(source.flatMap(({ message }) => {
    if (message.type === "user") return (message.files ?? []).map((file) => file.uri)
    if (message.type !== "assistant") return []
    return message.content.flatMap((part) => {
      if (part.type !== "tool" || part.state.status === "pending") return []
      // These top-level host envelopes are replayed as managed output, unlike
      // attachment-shaped strings quoted inside arbitrary text/report payloads.
      const metadata = isRecord(part.state.structured.$opencode) ? part.state.structured.$opencode : undefined
      const managed = [metadata, metadata?.text, metadata?.output].flatMap((value) =>
        isRecord(value) && value.type === "content-reference" && typeof value.uri === "string" ? [value.uri] : [],
      )
      return [...part.state.content.flatMap((item) => item.type === "file" ? [item.uri] : []),
        ...managed,
        ...(part.state.status === "completed" ? [
          ...(part.state.attachments ?? []).map((file) => file.uri), ...(part.state.outputPaths ?? []),
        ] : [])]
    })
  }).filter((uri) => uri.startsWith(ContentStore.URI_PREFIX)))
  for (const uri of required) references.add(uri)
  visitStrings(encoded, (value) => {
    for (const match of value.matchAll(/attachment:\/\/att_[a-zA-Z0-9_-]+/g)) references.add(match[0])
    return value
  })
  const attachments: Attachment[] = []
  const originalAttachments: Array<typeof AttachmentTable.$inferSelect> = []
  for (const uri of references) {
    // Text from another Session (or an example) is not an attachment grant.
    // locate() also supports this source's verified inherited fork aliases.
    const located = yield* content.locate({ uri, sessionID: input.sourceSessionID })
    if (!located) {
      if (required.has(uri)) return yield* new Conflict({ reason: "attachment" })
      continue
    }
    const original = yield* db
      .select()
      .from(AttachmentTable)
      .where(
        and(
          eq(AttachmentTable.id, located.id),
          eq(AttachmentTable.session_id, input.sourceSessionID),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!original) return yield* new Conflict({ reason: "attachment" })
    const resolved = yield* content.resolve({ uri, sessionID: input.sourceSessionID })
    if (
      !resolved ||
      original.blob_sha256 !== resolved.sha256 ||
      createHash("sha256").update(resolved.bytes).digest("hex") !== resolved.sha256
    )
      return yield* new Conflict({ reason: "attachment" })
    const blob = yield* content.putBlob({ bytes: resolved.bytes, mime: resolved.mime })
    const stored = yield* db
      .select()
      .from(ContentBlobTable)
      .where(eq(ContentBlobTable.sha256, blob.sha256))
      .get()
      .pipe(Effect.orDie)
    if (!stored) return yield* new Conflict({ reason: "attachment" })
    const id = SessionForkAttachmentID.derive({
      sessionID: input.childSessionID,
      uri,
      blobSha256: blob.sha256,
    })
    originalAttachments.push(original)
    attachments.push({
      id,
      messageID: original.message_id ? ids.get(SessionMessage.ID.make(original.message_id)) : undefined,
      mime: resolved.mime,
      filename: resolved.name,
      sizeBytes: blob.sizeBytes,
      sha256: blob.sha256,
      storagePath: stored.storage_path,
      createdAt: Date.now(),
    })
  }
  const entries = yield* Effect.forEach(encoded, ({ seq, message }) =>
    Effect.gen(function* () {
      const id = ids.get(SessionMessage.ID.make(message.id))
      if (!id) return yield* Effect.die("Missing fork message mapping")
      const clean =
        message.type === "synthetic" ? { ...message, id, sessionID: input.childSessionID } : { ...message, id }
      // Retain the parent's serialized attachment references: rewriting them to
      // the child's fork namespace would diverge the first provider request's
      // byte prefix and collapse provider cache hits for managed children.
      // Ownership is proven at resolution time through the derived fork rows.
      return {
        sourceSeq: seq,
        sourceMessageID: SessionMessage.ID.make(message.id),
        message: yield* Schema.decodeUnknownEffect(SessionMessage.Message)(clean).pipe(Effect.orDie),
      }
    }),
  )
  const token = Object.freeze({ childSessionID: input.childSessionID })
  preparedImports.set(token, {
    db,
    childSessionID: input.childSessionID,
    captured,
    context,
    dispatch,
    dispatchDigest,
    entries,
    attachments,
    originalAttachments,
  })
  return token
})

export type Prepared = Effect.Success<ReturnType<typeof prepare>>

/** Finalize the task receipt only after immutable attachment evidence exists.
 * Return a separate private token so an already prepared import is not mutated. */
export const bindDispatch = Effect.fn("SessionForkImport.bindDispatch")(function* (db: DB, token: Prepared, digest: string) {
  const prepared = preparedImports.get(token)
  if (!prepared || prepared.db !== db || !prepared.dispatch || prepared.dispatchDigest !== undefined || !/^[a-f0-9]{64}$/.test(digest))
    return yield* new Conflict({ reason: "prepared" })
  const dispatchDigest = createHash("sha256").update(JSON.stringify({ digest, attachments: prepared.originalAttachments })).digest("hex")
  const bound = Object.freeze({ childSessionID: prepared.childSessionID, dispatchDigest })
  preparedImports.set(bound, { ...prepared, dispatchDigest })
  return bound
})

/** Stable event fence for durable dispatch retries. Only a contiguous suffix of
 * persisted progress belonging to this unfinished assistant may be ignored.
 * Page backwards rather than loading an unbounded event history. */
export const dispatchFence = Effect.fn("SessionForkImport.dispatchFence")(function* (db: DB, input: {
  readonly sourceSessionID: SessionSchema.ID
  readonly throughSeq: number
  readonly dispatch: SessionFork.Dispatch
}) {
  let cursor = input.throughSeq
  while (cursor >= 0) {
    const rows = yield* db.select({ seq: EventTable.seq, type: EventTable.type, data: EventTable.data }).from(EventTable)
      .where(and(eq(EventTable.aggregate_id, input.sourceSessionID), lte(EventTable.seq, cursor)))
      .orderBy(desc(EventTable.seq)).limit(128).all().pipe(Effect.orDie)
    if (!rows.length) return yield* new Conflict({ reason: "changed" })
    for (const event of rows) {
      if (event.seq !== cursor) return yield* new Conflict({ reason: "changed" })
      if (event.type !== EventV2.versionedType(SessionEvent.Tool.Progress.type, 1)) {
        // Session bookkeeping without an assistant (title/metadata appends)
        // does not interrupt this dispatch's drain boundary; a foreign or
        // dispatched assistant mutation does.
        const data = yield* Effect.try({ try: () => EventV2.decodeStoredEventData(event.data),
          catch: () => new Conflict({ reason: "changed" }) })
        if (typeof data.assistantMessageID !== "string") { cursor--; continue }
        return cursor
      }
      const data = yield* Effect.try({ try: () => EventV2.decodeStoredEventData(event.data),
        catch: () => new Conflict({ reason: "changed" }) })
      if (data.assistantMessageID !== input.dispatch.assistantMessageID) return cursor
      cursor--
    }
  }
  return yield* new Conflict({ reason: "changed" })
})

/** Recheck a prepared source after awaited admission hooks. Importing history
 * does not freeze the source epoch, policy or pending input for its caller. */
export const revalidate = Effect.fn("SessionForkImport.revalidate")(function* (db: DB, token: Prepared) {
  const prepared = preparedImports.get(token)
  if (!prepared || prepared.db !== db) return yield* new Conflict({ reason: "prepared" })
  const fence = prepared.dispatch
    ? yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, prepared.captured.sourceSessionID)).get().pipe(Effect.orDie)
    : undefined
  const throughSeq = fence?.seq ?? prepared.captured.throughSeq
  if (throughSeq !== prepared.captured.throughSeq) {
    if (!prepared.dispatch || throughSeq < prepared.captured.throughSeq) return yield* new Conflict({ reason: "changed" })
    const intervening = yield* db.select().from(EventTable).where(and(
      eq(EventTable.aggregate_id, prepared.captured.sourceSessionID),
      gt(EventTable.seq, prepared.captured.throughSeq), lte(EventTable.seq, throughSeq),
    )).all().pipe(Effect.orDie)
    if (intervening.length !== throughSeq - prepared.captured.throughSeq)
      return yield* new Conflict({ reason: "changed" })
    for (const event of intervening) {
      const data = yield* Effect.try({
        try: () => EventV2.decodeStoredEventData(event.data),
        catch: () => new Conflict({ reason: "changed" }),
      })
      // Benign parent-side appends (title generation, metadata bookkeeping)
      // may interleave with an in-flight admission without touching the
      // frozen import basis. Only the dispatched assistant's own events must
      // stay progress-only until the provider stream has fully drained.
      const eventAssistant = typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined
      if (eventAssistant === undefined || eventAssistant !== prepared.dispatch.assistantMessageID) continue
      if (event.type !== EventV2.versionedType(SessionEvent.Tool.Progress.type, 1))
        return yield* new Conflict({ reason: "changed" })
    }
  }
  const current = yield* SessionFork.capture(db, {
    sessionID: prepared.captured.sourceSessionID, throughSeq,
    dispatch: prepared.dispatch,
    context: prepared.context,
  })
  if (!isDeepStrictEqual({ ...current, throughSeq: prepared.captured.throughSeq }, prepared.captured))
    return yield* new Conflict({ reason: "changed" })
  for (const original of prepared.originalAttachments) {
    const current = yield* db.select().from(AttachmentTable).where(eq(AttachmentTable.id, original.id)).get().pipe(Effect.orDie)
    if (!isDeepStrictEqual(current, original)) return yield* new Conflict({ reason: "changed" })
  }
  return current
})

/** Import into a fresh, parented child in the caller's atomic creation scope.
 * No inbox/activity/questions/permissions/read receipts are imported. All
 * dialogue and its epoch are replayable events, not unlogged projection copies. */
export const materialize = Effect.fn("SessionForkImport.materialize")(function* (
  db: DB,
  events: EventV2.Interface,
  token: Prepared,
) {
  const prepared = preparedImports.get(token)
  if (!prepared || prepared.db !== db) return yield* new Conflict({ reason: "prepared" })
  return yield* EventV2.atomic(
    db,
    Effect.gen(function* () {
      const current = yield* revalidate(db, token)
      const child = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, prepared.childSessionID))
        .get()
        .pipe(Effect.orDie)
      if (
        !child ||
        child.parent_id !== current.sourceSessionID ||
        child.time_archived !== null ||
        child.revert !== null ||
        // Only native dispatch initializes a fresh child epoch. Other imports
        // inherit the source epoch and must retain its agent identity.
        (!prepared.dispatch && child.agent !== current.epoch.agent)
      )
        return yield* new Conflict({ reason: "child" })
      for (const table of [SessionMessageTable, SessionInputTable, SessionActivityTable, SessionContextEpochTable]) {
        const existing = yield* db
          .select({ sessionID: table.session_id })
          .from(table)
          .where(eq(table.session_id, prepared.childSessionID))
          .get()
          .pipe(Effect.orDie)
        if (existing) return yield* new Conflict({ reason: "child" })
      }
      if (prepared.attachments.length > 0)
        yield* events.publish(SessionForkEvent.AttachmentsImported, {
          sessionID: child.id,
          attachments: prepared.attachments,
        })
      let baselineSeq = -1
      let historyThroughSeq = -1
      for (const entry of prepared.entries) {
        const imported = yield* events.publish(SessionForkEvent.MessageImported, {
          sessionID: child.id,
          sourceSessionID: current.sourceSessionID,
          sourceMessageID: entry.sourceMessageID,
          timestamp: yield* DateTime.now,
          message: entry.message,
        })
        if (imported.seq === undefined) return yield* Effect.die("Missing imported message sequence")
        historyThroughSeq = imported.seq
        if (entry.sourceSeq <= current.epoch.baseline_seq) baselineSeq = imported.seq
      }
      const boundary = prepared.dispatch
        ? yield* events.publish(SessionForkEvent.HistoryBoundaryImported, {
            sessionID: child.id,
            sourceSessionID: current.sourceSessionID,
            throughSeq: historyThroughSeq,
            dispatchDigest: prepared.dispatchDigest,
          })
        : yield* events.publish(SessionForkEvent.EpochImported, {
            sessionID: child.id,
            sourceSessionID: current.sourceSessionID,
            throughSeq: current.throughSeq,
            baseline: current.epoch.baseline,
            baselineSeq,
            agent: current.epoch.agent,
            snapshot: current.epoch.snapshot,
          })
      return { childSessionID: child.id, throughSeq: boundary.seq, messages: prepared.entries.length }
    }),
  )
})

function visitStrings(value: unknown, transform: (value: string) => string): unknown {
  if (typeof value === "string") return transform(value)
  if (Array.isArray(value)) return value.map((item) => visitStrings(item, transform))
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visitStrings(item, transform)]))
  return value
}
