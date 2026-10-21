export * as FileKnowledge from "./file-knowledge"

import { createHash } from "node:crypto"
import { and, desc, eq, gt, lt, lte, max, ne } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { Effect, Schema } from "effect"
import type { Message } from "@opencode-ai/llm"
import type { Database } from "./database/database"
import { FileKnowledgeReceiptTable } from "./file-knowledge.sql"
import { SessionMessageTable } from "./session/sql"
import type { SessionMessage } from "./session/message"
import type { SessionSchema } from "./session/schema"

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("FileKnowledge.StorageError", {}) {
  override get message() {
    return "File knowledge storage failed; file state may be unconfirmed. Inspect and read again before editing."
  }
}

export type Coverage = { ranges: [number, number][]; end?: number }
export type Basis = { sha256: string; coverage: Coverage; receiptID: number; origin: "read" | "write" }
export type Context = {
  sessionID: SessionSchema.ID
  assistantMessageID: SessionMessage.ID
  toolCallID: string
  /** Frozen by the host before this provider request; never supplied by the model. */
  fileKnowledgeCutoff?: number
}
export type ReadInput = {
  sessionID: SessionSchema.ID
  assistantMessageID: SessionMessage.ID
  callID: string
  target: string
  sha256: string
  coverage: Coverage
  output: string
}

export const hash = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex")

export function merge(left: Coverage, right: Coverage): Coverage {
  const ranges: [number, number][] = []
  for (const range of [...left.ranges, ...right.ranges].sort((a, b) => a[0] - b[0])) {
    const previous = ranges.at(-1)
    if (previous && range[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], range[1])
    else ranges.push([...range])
  }
  return { ranges, ...((right.end ?? left.end) === undefined ? {} : { end: right.end ?? left.end }) }
}
export const full = (coverage: Coverage) =>
  coverage.end === 0 ||
  (coverage.end !== undefined && coverage.ranges[0]?.[0] === 1 && coverage.ranges[0][1] >= coverage.end)

export function retainedReads(messages: ReadonlyArray<Message>) {
  return messages.flatMap((message) =>
    message.role !== "tool"
      ? []
      : message.content.flatMap((part) =>
          part.type === "tool-result" &&
          part.name === "read" &&
          part.result.type === "text" &&
          typeof part.result.value === "string"
            ? [{ id: part.id, text: part.result.value }]
            : [],
        ),
  )
}

/** All lookups are indexed metadata queries; no journal/history or blob scan. */
export function make(db: Database.Interface["db"]) {
  const messageSeq = (sessionID: SessionSchema.ID, messageID: SessionMessage.ID) =>
    db
      .select({ seq: SessionMessageTable.seq })
      .from(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.session_id, sessionID),
          eq(SessionMessageTable.id, messageID),
          eq(SessionMessageTable.type, "assistant"),
        ),
      )
      .get()
      .pipe(Effect.mapError(() => new StorageError()))
  const latest = (
    sessionID: SessionSchema.ID,
    target: string,
    cutoff = Number.MAX_SAFE_INTEGER,
    seq = Number.MAX_SAFE_INTEGER,
  ) =>
    db
      .select()
      .from(FileKnowledgeReceiptTable)
      .where(
        and(
          eq(FileKnowledgeReceiptTable.session_id, sessionID),
          eq(FileKnowledgeReceiptTable.target, target),
          ne(FileKnowledgeReceiptTable.origin, "pending_read"),
          lte(FileKnowledgeReceiptTable.id, cutoff),
          lt(FileKnowledgeReceiptTable.message_seq, seq),
        ),
      )
      .orderBy(desc(FileKnowledgeReceiptTable.id))
      .get()
      .pipe(Effect.mapError(() => new StorageError()))

  const recordRead = (input: ReadInput) =>
    Effect.gen(function* () {
      const message = yield* messageSeq(input.sessionID, input.assistantMessageID)
      if (!message) return // Missing/foreign/non-assistant host identity never grants knowledge.
      yield* db
        .insert(FileKnowledgeReceiptTable)
        .values({
          session_id: input.sessionID,
          assistant_message_id: input.assistantMessageID,
          message_seq: message.seq,
          call_id: input.callID,
          target: input.target,
          sha256: input.sha256,
          coverage: input.coverage,
          origin: "pending_read",
          output_sha256: hash(input.output),
        })
        .run()
        .pipe(Effect.mapError(() => new StorageError()))
    })
  const deliver = (sessionID: SessionSchema.ID, outputs: ReadonlyArray<{ id: string; text: string }>) =>
    Effect.gen(function* () {
      // Request preparation is serialized per Session. Activation is append-only and
      // bound to the exact post-bounds/post-plugin output, never a path/model claim.
      for (const output of outputs) {
        const candidates = yield* db
          .select()
          .from(FileKnowledgeReceiptTable)
          .where(
            and(
              eq(FileKnowledgeReceiptTable.session_id, sessionID),
              eq(FileKnowledgeReceiptTable.call_id, output.id),
              eq(FileKnowledgeReceiptTable.origin, "pending_read"),
              eq(FileKnowledgeReceiptTable.output_sha256, hash(output.text)),
            ),
          )
          .orderBy(FileKnowledgeReceiptTable.id)
          .all()
          .pipe(Effect.mapError(() => new StorageError()))
        for (const candidate of candidates) {
          const activated = yield* db
            .select({ id: FileKnowledgeReceiptTable.id })
            .from(FileKnowledgeReceiptTable)
            .where(eq(FileKnowledgeReceiptTable.source_receipt_id, candidate.id))
            .get()
            .pipe(Effect.mapError(() => new StorageError()))
          if (activated) continue
          const previous = yield* latest(sessionID, candidate.target)
          // Activation time is not observation time. Retained or delayed old output
          // must never revive a version predating a later read/write receipt.
          if (previous && candidate.id < (previous.source_receipt_id ?? previous.id)) continue
          const coverage =
            previous?.sha256 === candidate.sha256 ? merge(previous.coverage, candidate.coverage) : candidate.coverage
          yield* db
            .insert(FileKnowledgeReceiptTable)
            .values({ ...candidate, id: undefined, origin: "read", coverage, source_receipt_id: candidate.id })
            .run()
            .pipe(Effect.mapError(() => new StorageError()))
        }
      }
      const row = yield* db
        .select({ id: max(FileKnowledgeReceiptTable.id) })
        .from(FileKnowledgeReceiptTable)
        .where(eq(FileKnowledgeReceiptTable.session_id, sessionID))
        .get()
        .pipe(Effect.mapError(() => new StorageError()))
      return row?.id ?? 0
    })
  const validContext = (context: Context) =>
    Effect.gen(function* () {
      if (
        context.fileKnowledgeCutoff === undefined ||
        !Number.isSafeInteger(context.fileKnowledgeCutoff) ||
        context.fileKnowledgeCutoff < 0
      )
        return false
      return !!(yield* messageSeq(context.sessionID, context.assistantMessageID))
    })
  const basisFor = (context: Context, target: string) =>
    Effect.gen(function* () {
      if (!(yield* validContext(context))) return undefined
      const message = yield* messageSeq(context.sessionID, context.assistantMessageID)
      if (!message) return undefined
      const row = yield* latest(context.sessionID, target, context.fileKnowledgeCutoff, message.seq)
      return row && row.origin !== "pending_read"
        ? ({ sha256: row.sha256, coverage: row.coverage, receiptID: row.id, origin: row.origin } satisfies Basis)
        : undefined
    })
  const fullReadAfter = (context: Context, target: string, sha256: string, after: number) =>
    Effect.gen(function* () {
      if (!(yield* validContext(context))) return false
      const message = yield* messageSeq(context.sessionID, context.assistantMessageID)
      if (!message) return false
      const source = alias(FileKnowledgeReceiptTable, "fresh_read_source")
      // Activated coverage includes earlier knowledge. Recovery may union only the
      // original pages actually read AFTER uncertainty, for this exact version.
      const pages = yield* db
        .select({ coverage: source.coverage })
        .from(FileKnowledgeReceiptTable)
        .innerJoin(source, eq(source.id, FileKnowledgeReceiptTable.source_receipt_id))
        .where(
          and(
            eq(FileKnowledgeReceiptTable.session_id, context.sessionID),
            eq(FileKnowledgeReceiptTable.target, target),
            eq(FileKnowledgeReceiptTable.sha256, sha256),
            eq(FileKnowledgeReceiptTable.origin, "read"),
            lte(FileKnowledgeReceiptTable.id, context.fileKnowledgeCutoff!),
            lt(FileKnowledgeReceiptTable.message_seq, message.seq),
            gt(source.id, after),
          ),
        )
        .all()
        .pipe(Effect.mapError(() => new StorageError()))
      return full(pages.reduce((coverage, page) => merge(coverage, page.coverage), { ranges: [] } as Coverage))
    })
  const recordWrite = (input: Context & { target: string; sha256: string; coverage: Coverage }) =>
    Effect.gen(function* () {
      const message = yield* messageSeq(input.sessionID, input.assistantMessageID)
      if (!message) return
      yield* db
        .insert(FileKnowledgeReceiptTable)
        .values({
          session_id: input.sessionID,
          assistant_message_id: input.assistantMessageID,
          message_seq: message.seq,
          call_id: input.toolCallID,
          target: input.target,
          sha256: input.sha256,
          coverage: input.coverage,
          origin: "write",
        })
        .run()
        .pipe(Effect.mapError(() => new StorageError()))
    })
  return { recordRead, deliver, basisFor, recordWrite, validContext, fullReadAfter }
}
