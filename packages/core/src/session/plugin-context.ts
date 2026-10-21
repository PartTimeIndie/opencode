export * as SessionPluginContext from "./plugin-context"

import { createHash } from "node:crypto"
import { and, asc, count, desc, eq, gte, inArray, lte } from "drizzle-orm"
import { DateTime, Effect, Option, Schema } from "effect"
import { Database } from "../database/database"
import { QuestionV2 } from "../question"
import { QuestionTable } from "../question/sql"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionTodo } from "./todo"
import { SessionActivityTable, SessionMessageTable, SessionTable } from "./sql"

export const DEFAULT_MESSAGE_LIMIT = 80
export const MAX_MESSAGE_LIMIT = 200
export const DEFAULT_TEXT_CHARS = 24_000
export const MAX_TEXT_CHARS = 48_000
export const MAX_PENDING_ENTRIES = 32
// Canonical session todos are the authoritative task list; keep the bounded
// projection small and independent of the message text budget.
export const MAX_TODO_ENTRIES = 32
export const MAX_TODO_CONTENT_CHARS = 200

const Label = Schema.Struct({ label: Schema.String, description: Schema.optional(Schema.String) })
export const Message = Schema.Struct({
  id: Schema.String, role: Schema.Literals(["user", "assistant"]), text: Schema.String,
  createdAt: Schema.Number, complete: Schema.Boolean,
})
export const Question = Schema.Struct({
  id: Schema.String, revision: Schema.Number,
  items: Schema.Array(Schema.Struct({
    type: Schema.optional(Schema.String), text: Schema.String, context: Schema.String,
    options: Schema.Array(Label), fields: Schema.Array(Label),
  })),
})
export const Permission = Schema.Struct({
  id: Schema.String, sessionID: Schema.String, action: Schema.String, resources: Schema.Array(Schema.String),
})
export type PluginContextPermission = typeof Permission.Type
export const Todo = Schema.Struct({
  content: Schema.String,
  // Canonical SessionTodo status: pending, in_progress, completed, cancelled.
  status: Schema.String,
  priority: Schema.optional(Schema.String),
})
export const Todos = Schema.Struct({
  items: Schema.Array(Todo),
  total: Schema.Number,
  truncated: Schema.Boolean,
  // SHA-256 over the UNBOUNDED canonical todo rows (status, priority, content,
  // position order) computed before the transfer caps, so the context
  // fingerprint stays sensitive to changes the capped item list cannot show.
  // A one-way digest exposes no todo contents.
  digest: Schema.String,
})
export const Info = Schema.Struct({
  version: Schema.Literal(1), capturedAt: Schema.Number, fingerprint: Schema.String,
  session: Schema.Struct({ id: Schema.String, directory: Schema.String, title: Schema.String }),
  activity: Schema.Struct({
    id: Schema.optional(Schema.String),
    status: Schema.Literals(["running", "recovering", "completed", "failed", "interrupted", "unknown"]),
    working: Schema.Boolean, openedSeq: Schema.optional(Schema.Number), closedSeq: Schema.optional(Schema.Number),
  }),
  selection: Schema.Literals(["activity", "latest-user-turn"]), boundaryComplete: Schema.Boolean,
  messages: Schema.Array(Message),
  pending: Schema.Struct({
    questions: Schema.Array(Question), permissions: Schema.Array(Permission),
    controls: Schema.Array(Schema.Struct({ id: Schema.String, revision: Schema.Number, title: Schema.String, actions: Schema.Array(Schema.String) })),
  }),
  todos: Schema.optional(Todos),
  totals: Schema.Struct({ messages: Schema.Number, textChars: Schema.Number, questions: Schema.Number, controls: Schema.Number, permissions: Schema.Number }),
  truncated: Schema.Struct({ messages: Schema.Boolean, text: Schema.Boolean, pending: Schema.Boolean }),
})
export type Info = typeof Info.Type
export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionPluginContext.NotFoundError", { sessionID: Schema.String }) {}

// Only SELECTs: QuestionV2.list() reconciles orphans and MUST NOT be used by this read API.
export const read = Effect.fn("SessionPluginContext.read")(function* (input: {
  db: Database.Interface["db"]; sessionID: SessionSchema.ID; limit?: number; maxTextChars?: number;
  permissions?: ReadonlyArray<PluginContextPermission>; now?: number;
}) {
  const db = input.db
  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT))
  const budget = { remaining: Math.max(1, Math.min(input.maxTextChars ?? DEFAULT_TEXT_CHARS, MAX_TEXT_CHARS)), truncated: false }
  const session = yield* db.select().from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get().pipe(Effect.orDie)
  if (!session) return yield* new NotFoundError({ sessionID: input.sessionID })
  const activity = yield* db.select().from(SessionActivityTable).where(eq(SessionActivityTable.session_id, input.sessionID))
    .orderBy(desc(SessionActivityTable.time_created), desc(SessionActivityTable.id)).limit(1).get().pipe(Effect.orDie)
  const status = Schema.decodeUnknownOption(Info.fields.activity.fields.status)(activity?.status ?? "unknown")
  const activityInfo: Info["activity"] = {
    ...(activity ? { id: activity.id } : {}), status: Option.getOrElse(status, () => "unknown" as const),
    working: !!activity && ["running", "recovering"].includes(activity.status) && (activity.lease_until ?? 0) > (input.now ?? Date.now()),
    ...(activity?.opened_seq != null ? { openedSeq: activity.opened_seq } : {}),
    ...(activity?.closed_seq != null ? { closedSeq: activity.closed_seq } : {}),
  }
  // Include the triggering user prompt BEFORE activity.started; an opened_seq-only window loses it.
  const anchor = yield* db.select().from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.type, "user"),
      activity?.opened_seq != null ? lte(SessionMessageTable.seq, activity.opened_seq) : undefined))
    .orderBy(desc(SessionMessageTable.seq)).limit(1).get().pipe(Effect.orDie)
  const window = and(eq(SessionMessageTable.session_id, input.sessionID),
    inArray(SessionMessageTable.type, ["user", "assistant"]), anchor ? gte(SessionMessageTable.seq, anchor.seq) : undefined)
  const rows = yield* db.select().from(SessionMessageTable).where(window).orderBy(desc(SessionMessageTable.seq)).limit(limit + 1).all().pipe(Effect.orDie)
  const messageCount = yield* db.select({ total: count() }).from(SessionMessageTable).where(window).get().pipe(Effect.orDie)
  const selected = rows.slice(0, limit)
  if (anchor && limit > 1 && !selected.some((row) => row.id === anchor.id)) selected.splice(selected.length - 1, 1, anchor)

  const pendingWhere = and(eq(QuestionTable.session_id, input.sessionID), eq(QuestionTable.state, "active"), inArray(QuestionTable.mode, ["blocking", "interactive"]))
  const questionCounts = yield* db.select({ mode: QuestionTable.mode, total: count() }).from(QuestionTable).where(pendingWhere).groupBy(QuestionTable.mode).all().pipe(Effect.orDie)
  const requests = yield* db.select().from(QuestionTable).where(pendingWhere).orderBy(asc(QuestionTable.seq)).limit(MAX_PENDING_ENTRIES + 1).all().pipe(Effect.orDie)
  const pending: { questions: Array<Info["pending"]["questions"][number]>; controls: Array<Info["pending"]["controls"][number]>; permissions: Array<PluginContextPermission> } = { questions: [], controls: [], permissions: [] }
  const pendingState = { truncated: requests.length > MAX_PENDING_ENTRIES }
  const take = (value: string | undefined) => takeText(value ?? "", budget)
  requests.slice(0, MAX_PENDING_ENTRIES).forEach((row) => {
    const parsed = Schema.decodeUnknownOption(QuestionV2.Request)(row.request)
    if (Option.isNone(parsed)) { pendingState.truncated = true; return }
    const request = parsed.value
    if (request.mode === "blocking") {
      if (request.questions.length > 32) pendingState.truncated = true
      pending.questions.push({ id: row.id, revision: row.revision, items: request.questions.slice(0, 32).map((question) => ({
        ...(question.type ? { type: question.type } : {}), text: take(question.question),
        context: take(visibleQuestionContext(question)),
        options: (question.options ?? []).slice(0, 32).map((option) => ({ label: take(option.label), ...(option.description ? { description: take(option.description) } : {}) })),
        fields: (question.form?.fields ?? []).filter((field) => field.type !== "hidden" && field.label).slice(0, 32)
          .map((field) => ({ label: take(field.label), ...(field.description ? { description: take(field.description) } : {}) })),
      })) })
      return
    }
    if (request.mode === "interactive") pending.controls.push({
      id: row.id, revision: row.revision, title: take(request.surface.title),
      actions: request.surface.controls.slice(0, 32).map((control) => take(control.label)),
    })
  })
  const allPermissions = (input.permissions ?? []).filter((item) => item.sessionID === input.sessionID)
  const permissionLimit = Math.max(0, MAX_PENDING_ENTRIES - pending.questions.length - pending.controls.length)
  allPermissions.slice(0, permissionLimit).forEach((item) => pending.permissions.push({
    id: item.id, sessionID: item.sessionID, action: take(item.action), resources: item.resources.slice(0, 32).map(take),
  }))
  if (allPermissions.length > permissionLimit) pendingState.truncated = true

  // Canonical read-only todo projection through the SessionTodo reader; the
  // authoritative task list, bounded independently of the message text budget.
  const todoRows = yield* SessionTodo.load(db, input.sessionID)
  // Sensitivity before truncation: the digest covers every canonical row, so
  // changes beyond the 32-entry/200-char transfer caps still invalidate the
  // context fingerprint.
  const todoDigest = createHash("sha256")
    .update(todoRows.map((todo) => `${todo.status}\u0000${todo.priority ?? ""}\u0000${todo.content}`).join("\u0001"))
    .digest("hex")
  const todos: Info["todos"] = {
    digest: todoDigest,
    items: todoRows.slice(0, MAX_TODO_ENTRIES).map((todo) => ({
      content: todo.content.slice(0, MAX_TODO_CONTENT_CHARS),
      status: todo.status,
      ...(todo.priority ? { priority: todo.priority } : {}),
    })),
    total: todoRows.length,
    truncated: todoRows.length > MAX_TODO_ENTRIES,
  }

  const messages = selected.flatMap(projectMessage).sort((a, b) => a.seq - b.seq)
  // Spend the remaining text budget on newest result first, then restore chronological order.
  const bounded = messages.toReversed().map((message) => ({
    id: message.id, role: message.role, text: take(message.text), createdAt: message.createdAt, complete: message.complete,
  })).filter((message) => message.text).toReversed()
  const totalQuestions = questionCounts.find((row) => row.mode === "blocking")?.total ?? 0
  const totalControls = questionCounts.find((row) => row.mode === "interactive")?.total ?? 0
  const context = {
    version: 1 as const, session: { id: session.id, directory: session.directory, title: session.title }, activity: activityInfo,
    selection: activity?.opened_seq != null && anchor ? "activity" as const : "latest-user-turn" as const,
    boundaryComplete: !!anchor || (messageCount?.total ?? 0) === 0,
    messages: bounded, pending, todos,
    totals: { messages: messageCount?.total ?? 0, textChars: bounded.reduce((sum, message) => sum + message.text.length, 0), questions: totalQuestions, controls: totalControls, permissions: allPermissions.length },
    truncated: { messages: rows.length > limit || bounded.length < selected.length, text: budget.truncated, pending: pendingState.truncated },
  }
  return { ...context, capturedAt: input.now ?? Date.now(), fingerprint: createHash("sha256").update(JSON.stringify(context)).digest("hex") } satisfies Info
})

function projectMessage(row: typeof SessionMessageTable.$inferSelect): Array<typeof Message.Type & { seq: number }> {
  const message = Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type })
  if (message.type === "user") return [{ seq: row.seq, id: row.id, role: "user" as const, text: message.text, createdAt: row.time_created, complete: true }]
  if (message.type !== "assistant") return []
  const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n\n").trim()
  return text ? [{ seq: row.seq, id: row.id, role: "assistant" as const, text, createdAt: DateTime.toEpochMillis(message.time.created), complete: message.time.completed !== undefined && !message.error && !message.failure }] : []
}

function takeText(value: string, budget: { remaining: number; truncated: boolean }) {
  if (value.length <= budget.remaining) { budget.remaining -= value.length; return value }
  budget.truncated = true
  const result = budget.remaining > 0 ? `${value.slice(0, Math.max(0, budget.remaining - 1))}…` : ""
  budget.remaining = 0
  return result
}

function visibleQuestionContext(question: QuestionV2.Info) {
  const sections = (items: ReadonlyArray<QuestionV2.Section>, depth = 0): string[] => depth > 8 ? [] : items.slice(0, 32).flatMap((item) => [item.title, item.content, ...sections(item.children ?? [], depth + 1)])
  return [
    ...(question.body ?? []).flatMap((block) => block.type === "markdown" ? [block.content] : []),
    ...sections(question.sections ?? []), question.form?.title ?? "", question.form?.description ?? "",
  ].join("\n").slice(0, MAX_TEXT_CHARS)
}
