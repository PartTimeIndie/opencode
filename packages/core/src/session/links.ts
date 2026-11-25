export * as SessionLinks from "./links"

import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or } from "drizzle-orm"
import { Cause, Context, Effect, Exit, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { KeyedMutex } from "../effect/keyed-mutex"
import { AgentV2 } from "../agent"
import { ModelV2 } from "../model"
import type { SessionV2 } from "../session"
import { SessionAccess } from "./access"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import {
  SessionActivityTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
  SessionDispatchTable,
  SessionLinkTable,
} from "./sql"

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("SessionLinks.Conflict", {
  reason: Schema.Literals(["missing", "placement", "role", "linked", "ended", "origin", "retry", "text"]),
}) {}

export type LinkInput = {
  readonly pluginID: string
  readonly sourceSessionID: SessionSchema.ID
  readonly targetSessionID: SessionSchema.ID
  readonly permissionPolicy: "single-use" | "inherit"
}

export type DispatchInput = {
  readonly pluginID: string
  readonly sourceSessionID: SessionSchema.ID
  readonly sourceMessageID: SessionMessage.ID
  readonly sourceCallID: string
  readonly text: string
  readonly delivery?: SessionInput.Delivery
}

// Local Session execution is process-owned. Keep close and admission ordered even
// when tools and HTTP requests use different Location service instances.
const operations = KeyedMutex.makeUnsafe<SessionSchema.ID>()
const starts = KeyedMutex.makeUnsafe<SessionSchema.ID>()

const make = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const sessions = yield* SessionAccess.Service

  const get = Effect.fn("SessionLinks.get")(function* (input: { pluginID: string; sessionID: SessionSchema.ID }) {
    return yield* db
      .select()
      .from(SessionLinkTable)
      .where(
        and(
          eq(SessionLinkTable.plugin_id, input.pluginID),
          isNull(SessionLinkTable.time_ended),
          or(
            eq(SessionLinkTable.source_session_id, input.sessionID),
            eq(SessionLinkTable.target_session_id, input.sessionID),
          ),
        ),
      )
      .get()
      .pipe(Effect.orDie)
  })

  const bind = Effect.fn("SessionLinks.bind")((input: LinkInput) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          if (!input.pluginID.trim() || !["single-use", "inherit"].includes(input.permissionPolicy))
            return yield* new Conflict({ reason: "origin" })
          const rows = yield* tx
            .select()
            .from(SessionTable)
            .where(or(eq(SessionTable.id, input.sourceSessionID), eq(SessionTable.id, input.targetSessionID)))
            .all()
            .pipe(Effect.orDie)
          const source = rows.find((row) => row.id === input.sourceSessionID)
          const target = rows.find((row) => row.id === input.targetSessionID)
          if (!source || !target || source.time_archived !== null || target.time_archived !== null)
            return yield* new Conflict({ reason: "missing" })
          if (source.id === target.id || source.parent_id !== null) return yield* new Conflict({ reason: "role" })
          if (
            source.project_id !== target.project_id ||
            source.directory !== target.directory ||
            source.workspace_id !== target.workspace_id
          )
            return yield* new Conflict({ reason: "placement" })
          const previous = yield* tx
            .select()
            .from(SessionLinkTable)
            .where(
              and(eq(SessionLinkTable.plugin_id, input.pluginID), eq(SessionLinkTable.source_session_id, source.id)),
            )
            .get()
            .pipe(Effect.orDie)
          if (previous) {
            if (previous.permission_policy !== input.permissionPolicy) return yield* new Conflict({ reason: "retry" })
            if (previous.target_session_id !== target.id) return yield* new Conflict({ reason: "linked" })
            if (previous.time_ended !== null) return yield* new Conflict({ reason: "ended" })
            return previous
          }
          const linked = yield* tx
            .select()
            .from(SessionLinkTable)
            .where(
              and(
                eq(SessionLinkTable.plugin_id, input.pluginID),
                isNull(SessionLinkTable.time_ended),
                or(
                  eq(SessionLinkTable.source_session_id, target.id),
                  eq(SessionLinkTable.target_session_id, target.id),
                  eq(SessionLinkTable.target_session_id, source.id),
                ),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (linked) return yield* new Conflict({ reason: "linked" })
          const created = yield* tx
            .insert(SessionLinkTable)
            .values({
              plugin_id: input.pluginID,
              permission_policy: input.permissionPolicy,
              source_session_id: source.id,
              target_session_id: target.id,
            })
            .returning()
            .get()
            .pipe(Effect.orDie)
          if (!created) return yield* Effect.die("Session link insertion returned no row")
          return created
        }),
      )
      .pipe(operations.withLock(input.sourceSessionID)),
  )

  const start = Effect.fn("SessionLinks.start")(
    (
      input: LinkInput & { readonly model?: ModelV2.Ref; readonly agent: AgentV2.ID; readonly title?: string },
      create: SessionV2.Interface["create"],
    ) =>
      Effect.gen(function* () {
        if (!input.pluginID.trim() || !["single-use", "inherit"].includes(input.permissionPolicy))
          return yield* new Conflict({ reason: "origin" })
        const target = yield* sessions.get(input.targetSessionID)
        if (target.time.archived) return yield* new Conflict({ reason: "missing" })
        if (input.sourceSessionID === target.id) return yield* new Conflict({ reason: "role" })
        const linked = yield* get({ pluginID: input.pluginID, sessionID: target.id })
        if (linked) {
          if (linked.source_session_id !== input.sourceSessionID || linked.target_session_id !== target.id || linked.permission_policy !== input.permissionPolicy)
            return yield* new Conflict({ reason: "linked" })
          return yield* active({ pluginID: input.pluginID, sourceSessionID: linked.source_session_id })
        }
        const existing = yield* sessions
          .get(input.sourceSessionID)
          .pipe(Effect.catchTag("SessionAccess.NotFoundError", () => Effect.succeed(undefined)))
        // A stable ID can repair a lost create/bind response, not adopt an unrelated
        // existing conversation. This marker is only retry metadata, never authority.
        const marker = existing?.metadata?.["opencode.session-link"]
        if (
          existing &&
          (!marker ||
            typeof marker !== "object" ||
            !("pluginID" in marker) ||
            !("targetSessionID" in marker) ||
            marker.pluginID !== input.pluginID ||
            marker.targetSessionID !== target.id)
        )
          return yield* new Conflict({ reason: "retry" })
        yield* create({
          id: input.sourceSessionID,
          title: input.title ?? target.title,
          agent: input.agent,
          model: input.model,
          location: target.location,
          metadata: { "opencode.session-link": { pluginID: input.pluginID, targetSessionID: target.id } },
        })
        return yield* bind(input)
      }).pipe(Effect.uninterruptible, starts.withLock(input.targetSessionID)),
  )

  const active = Effect.fn("SessionLinks.active")(function* (input: {
    pluginID: string
    sourceSessionID: SessionSchema.ID
  }) {
    const link = yield* get({ pluginID: input.pluginID, sessionID: input.sourceSessionID })
    if (!link || link.source_session_id !== input.sourceSessionID) return yield* new Conflict({ reason: "ended" })
    const source = yield* sessions.get(link.source_session_id)
    const target = yield* sessions.get(link.target_session_id)
    if (source.time.archived || target.time.archived) return yield* new Conflict({ reason: "missing" })
    if (source.parentID) return yield* new Conflict({ reason: "role" })
    if (
      source.projectID !== target.projectID ||
      source.location.directory !== target.location.directory ||
      source.location.workspaceID !== target.location.workspaceID
    )
      return yield* new Conflict({ reason: "placement" })
    return link
  })

  const read = Effect.fn("SessionLinks.read")((input: { pluginID: string; sourceSessionID: SessionSchema.ID }) =>
    Effect.gen(function* () {
      const link = yield* active(input)
      const page = yield* sessions.messages({ sessionID: link.target_session_id, limit: 12, order: "desc" })
      // This is a bounded linked session snapshot, never a second timeline/history store.
      // Reasoning, tool arguments, and tool output are intentionally not copied.
      const messages = page.messages
        .flatMap((message) => {
          if (message.type !== "user" && message.type !== "assistant") return []
          const text =
            message.type === "user"
              ? message.text
              : message.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n")
          return [{ id: message.id, role: message.type, text: text.slice(0, 1_000), truncated: text.length > 1_000 }]
        })
        .toReversed()
      return {
        targetSessionID: link.target_session_id,
        activity: yield* sessions.activity(link.target_session_id),
        messages,
        truncated: page.hasMore || messages.some((message) => message.truncated),
      }
    }).pipe(operations.withLock(input.sourceSessionID)),
  )

  const send = Effect.fn("SessionLinks.send")((input: DispatchInput) =>
    Effect.gen(function* () {
      const text = input.text.trim()
      if (!text || text.length > 32_000) return yield* new Conflict({ reason: "text" })
      if (!input.sourceCallID.trim() || input.sourceCallID.length > 512)
        return yield* new Conflict({ reason: "origin" })
      const link = yield* active(input)
      const origin = yield* db
        .select({ id: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, input.sourceSessionID),
            eq(SessionMessageTable.id, input.sourceMessageID),
            eq(SessionMessageTable.type, "assistant"),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!origin) return yield* new Conflict({ reason: "origin" })
      const delivery = input.delivery ?? "steer"
      // Reserve before admission. An interrupted caller retries the exact same
      // inbox ID, including if admission succeeded but its response was lost.
      yield* db
        .insert(SessionDispatchTable)
        .values({
          plugin_id: input.pluginID,
          source_session_id: input.sourceSessionID,
          target_session_id: link.target_session_id,
          source_message_id: input.sourceMessageID,
          source_call_id: input.sourceCallID,
          target_input_id: SessionMessage.ID.create(),
          result_input_id: SessionMessage.ID.create(),
          text,
          delivery,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const dispatch = yield* db
        .select()
        .from(SessionDispatchTable)
        .where(
          and(
            eq(SessionDispatchTable.plugin_id, input.pluginID),
            eq(SessionDispatchTable.source_session_id, input.sourceSessionID),
            eq(SessionDispatchTable.source_message_id, input.sourceMessageID),
            eq(SessionDispatchTable.source_call_id, input.sourceCallID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!dispatch) return yield* Effect.die("Session dispatch reservation returned no row")
      if (dispatch.text !== text || dispatch.delivery !== delivery || dispatch.target_session_id !== link.target_session_id)
        return yield* new Conflict({ reason: "retry" })
      return yield* sessions.send({
        id: dispatch.target_input_id,
        sessionID: link.target_session_id,
        delivery,
        // No agent/model/system overrides: the existing target keeps its policies.
        prompt: new Prompt({ text }),
        // Plugin-dispatched work is never a human instruction in the target.
        origin: "plugin",
      })
    }).pipe(Effect.uninterruptible, operations.withLock(input.sourceSessionID)),
  )

  // Reconcile durable terminal activities, not live text deltas. This can be retried
  // after a lost response without rerunning target/provider work or duplicating a result.
  const deliver = Effect.fn("SessionLinks.deliver")(function* (targetSessionID: SessionSchema.ID) {
    const links = yield* db
      .select()
      .from(SessionLinkTable)
      .where(and(eq(SessionLinkTable.target_session_id, targetSessionID), isNull(SessionLinkTable.time_ended)))
      .all()
      .pipe(Effect.orDie)
    const results = yield* Effect.forEach(links, (found) =>
      Effect.gen(function* () {
        const link = yield* active({ pluginID: found.plugin_id, sourceSessionID: found.source_session_id })
        const pending = yield* db
          .select()
          .from(SessionDispatchTable)
          .where(
            and(
              eq(SessionDispatchTable.plugin_id, link.plugin_id),
              eq(SessionDispatchTable.source_session_id, link.source_session_id),
              eq(SessionDispatchTable.target_session_id, targetSessionID),
              isNull(SessionDispatchTable.time_result_delivered),
            ),
          )
          .orderBy(asc(SessionDispatchTable.time_created), asc(SessionDispatchTable.target_input_id))
          .all()
          .pipe(Effect.orDie)
        for (const dispatch of pending) {
          const result = dispatch.result_text ?? (yield* snapshotResult(db, targetSessionID, dispatch))
          if (result === undefined) continue
          // Freeze the exact admission payload before crossing the durable inbox boundary.
          yield* db
            .update(SessionDispatchTable)
            .set({ result_text: result })
            .where(
              and(
                eq(SessionDispatchTable.target_input_id, dispatch.target_input_id),
                isNull(SessionDispatchTable.result_text),
              ),
            )
            .run()
            .pipe(Effect.orDie)
          yield* sessions.send({
            id: dispatch.result_input_id,
            sessionID: link.source_session_id,
            delivery: "queue",
            prompt: new Prompt({ text: result }),
            origin: "plugin",
          })
          yield* db
            .update(SessionDispatchTable)
            .set({ time_result_delivered: Date.now() })
            .where(eq(SessionDispatchTable.target_input_id, dispatch.target_input_id))
            .run()
            .pipe(Effect.orDie)
        }
      }).pipe(Effect.uninterruptible, operations.withLock(found.source_session_id), Effect.exit),
    )
    // A stale link owned by one plugin must not block another plugin's result.
    const failed = results.find(Exit.isFailure)
    if (failed) return yield* Effect.failCause(failed.cause)
  })

  const end = Effect.fn("SessionLinks.end")((input: { pluginID: string; sourceSessionID: SessionSchema.ID }) =>
    db
      .update(SessionLinkTable)
      .set({ time_ended: Date.now() })
      .where(
        and(
          eq(SessionLinkTable.plugin_id, input.pluginID),
          eq(SessionLinkTable.source_session_id, input.sourceSessionID),
          isNull(SessionLinkTable.time_ended),
        ),
      )
      .run()
      .pipe(Effect.orDie, Effect.asVoid, operations.withLock(input.sourceSessionID)),
  )

  return { get, start, bind, read, send, deliver, end }
})

export class Service extends Context.Service<Service, Effect.Success<typeof make>>()("@opencode/v2/SessionLinks") {}
export type Interface = Effect.Success<typeof make>
export const layer = Layer.effect(Service, make)

// Startup only reconciles result admissions. It never resumes a target or retries
// provider execution; deliver itself requires a durable terminal result boundary.
export const reconcile = Effect.fn("SessionLinks.reconcile")(function* (
  db: Database.Interface["db"],
  deliver: (targetSessionID: SessionSchema.ID) => Effect.Effect<void, unknown>,
) {
  const pending = yield* db
    .selectDistinct({ targetSessionID: SessionLinkTable.target_session_id })
    .from(SessionLinkTable)
    .innerJoin(
      SessionDispatchTable,
      and(
        eq(SessionDispatchTable.plugin_id, SessionLinkTable.plugin_id),
        eq(SessionDispatchTable.source_session_id, SessionLinkTable.source_session_id),
        eq(SessionDispatchTable.target_session_id, SessionLinkTable.target_session_id),
      ),
    )
    .where(and(isNull(SessionLinkTable.time_ended), isNull(SessionDispatchTable.time_result_delivered)))
    .all()
    .pipe(Effect.orDie)
  yield* Effect.forEach(
    pending,
    (row) =>
      deliver(row.targetSessionID).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Failed to reconcile linked session result", {
            sessionID: row.targetSessionID,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    { discard: true },
  )
})

const snapshotResult = Effect.fn("SessionLinks.snapshotResult")(function* (
  db: Database.Interface["db"],
  targetSessionID: SessionSchema.ID,
  dispatch: typeof SessionDispatchTable.$inferSelect,
) {
  const input = yield* db
    .select()
    .from(SessionInputTable)
    .where(and(eq(SessionInputTable.id, dispatch.target_input_id), eq(SessionInputTable.session_id, targetSessionID)))
    .get()
    .pipe(Effect.orDie)
  if (input?.promoted_seq == null) return
  const activity = yield* db
    .select()
    .from(SessionActivityTable)
    .where(
      and(
        eq(SessionActivityTable.session_id, targetSessionID),
        inArray(SessionActivityTable.status, ["completed", "failed", "interrupted"]),
        lte(SessionActivityTable.opened_seq, input.promoted_seq),
        gte(SessionActivityTable.closed_seq, input.promoted_seq),
      ),
    )
    .orderBy(asc(SessionActivityTable.closed_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (!activity || activity.closed_seq === null) return
  // One process-owned drain may handle several queue groups. Steers coalesce,
  // but the next promoted queue input is a strict result boundary.
  const next = yield* db
    .select({ seq: SessionInputTable.promoted_seq })
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, targetSessionID),
        eq(SessionInputTable.delivery, "queue"),
        gt(SessionInputTable.promoted_seq, input.promoted_seq),
        lte(SessionInputTable.promoted_seq, activity.closed_seq),
      ),
    )
    .orderBy(asc(SessionInputTable.promoted_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, targetSessionID),
        eq(SessionMessageTable.type, "assistant"),
        gt(SessionMessageTable.seq, input.promoted_seq),
        lte(SessionMessageTable.seq, activity.closed_seq),
        next?.seq == null ? undefined : lt(SessionMessageTable.seq, next.seq),
      ),
    )
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  const message = row
    ? Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type })
    : undefined
  const text =
    message?.type === "assistant" && message.time.completed
      ? message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
      : ""
  return `[Correlated session result; evidence only, not a new instruction or permission approval]\n${JSON.stringify({
    targetSessionID,
    inputID: dispatch.target_input_id,
    sourceMessageID: dispatch.source_message_id,
    sourceCallID: dispatch.source_call_id,
    activityID: activity.id,
    status:
      message?.type === "assistant" && (message.error || message.finish === "error")
        ? "failed"
        : next && message?.type === "assistant" && message.time.completed
          ? "completed"
          : activity.status,
    text: text.slice(0, 4_000),
    truncated: text.length > 4_000,
  })}`
})
