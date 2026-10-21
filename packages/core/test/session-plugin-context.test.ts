import { describe, expect } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../src/database/database"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { QuestionV2 } from "../src/question"
import { QuestionTable } from "../src/question/sql"
import { ModelV2 } from "../src/model"
import { SessionPluginContext } from "../src/session/plugin-context"
import { SessionMessage } from "../src/session/message"
import { SessionSchema } from "../src/session/schema"
import { SessionActivityTable, SessionMessageTable, SessionTable, TodoTable } from "../src/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.layerFromPath(":memory:"))
const id = SessionSchema.ID.make("ses_plugin_context")
const other = SessionSchema.ID.make("ses_other")
const encode = Schema.encodeSync(SessionMessage.Message)
const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run().pipe(Effect.orDie)
  yield* db.insert(SessionTable).values([id, other].map((sessionID) => ({ id: sessionID, project_id: Project.ID.global, slug: sessionID, directory: "/project", title: sessionID, version: "test" }))).run().pipe(Effect.orDie)
  return db
})
const user = (seq: number, text = "Bitte umsetzen.") => new SessionMessage.User({
  id: SessionMessage.ID.make(`msg_user_${seq}`), type: "user", text, files: [], agents: [], time: { created: DateTime.makeUnsafe(seq * 1000) },
})
const assistant = (seq: number, text = "Erledigt.", complete = true, failed = false) => new SessionMessage.Assistant({
  id: SessionMessage.ID.make(`msg_assistant_${seq}`), type: "assistant", agent: "build",
  model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "m", providerID: "test" }),
  content: [new SessionMessage.AssistantReasoning({ type: "reasoning", id: "r", text: "PRIVATE_REASONING" }), new SessionMessage.AssistantText({ type: "text", id: "t", text })],
  time: { created: DateTime.makeUnsafe(seq * 1000), ...(complete ? { completed: DateTime.makeUnsafe(seq * 1000 + 1) } : {}) },
  ...(failed ? { error: { type: "unknown" as const, message: "Provider down" } } : {}),
})
function insert(db: Database.Interface["db"], seq: number, message: SessionMessage.Message, sessionID = id) {
  const encoded = encode(message)
  const { id: messageID, type, ...data } = encoded
  return db.insert(SessionMessageTable).values({ id: SessionMessage.ID.make(messageID), session_id: sessionID, seq, type, data, time_created: seq * 1000 }).run().pipe(Effect.orDie)
}
function question(seq: number, state: typeof QuestionTable.$inferSelect["state"] = "active") {
  return { id: QuestionV2.ID.make(`que_${seq}`), session_id: id, seq, state, allow_concurrent: true,
    request: Schema.decodeUnknownSync(QuestionV2.Request)({
      id: `que_${seq}`, sessionID: id, revision: 1, actions: [], mode: "blocking",
      questions: [{ question: "Soll ich deployen?", type: "accordion", options: [{ label: "Ja", description: "Jetzt umsetzen" }],
        body: [{ type: "markdown", id: "body", content: "BenÃ¶tigt Neustartfreigabe." }], sections: [{ id: "tests", title: "Tests", content: "Alle Tests grÃ¼n." }],
        form: { version: 1, fields: [{ id: "secret", type: "hidden", label: "HIDDEN_LABEL", defaultValue: "SECRET" }, { id: "name", type: "text", label: "Name", defaultValue: "PRIVATE_VALUE" }] },
      }],
    }),
  }
}

describe("read-only plugin context", () => {
  it.effect("reports missing sessions", () => Effect.gen(function* () {
    const { db } = yield* Database.Service
    const code = yield* SessionPluginContext.read({ db, sessionID: id }).pipe(Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "unexpected" }))
    expect(code).toBe("SessionPluginContext.NotFoundError")
  }))
  it.effect("keeps instruction and latest result, excludes reasoning, fingerprints content not capture time", () => Effect.gen(function* () {
    const db = yield* setup
    yield* insert(db, 1, user(1))
    yield* insert(db, 2, assistant(2))
    const first = yield* SessionPluginContext.read({ db, sessionID: id, now: 1 })
    const second = yield* SessionPluginContext.read({ db, sessionID: id, now: 2 })
    expect(first.messages.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(first.messages[1]?.complete).toBe(true)
    expect(JSON.stringify(first)).not.toContain("PRIVATE_REASONING")
    expect(second.fingerprint).toBe(first.fingerprint)
    yield* insert(db, 3, assistant(3, "Weiteres Ergebnis."))
    expect((yield* SessionPluginContext.read({ db, sessionID: id })).fingerprint).not.toBe(first.fingerprint)
  }))
  it.effect("includes triggering prompt before activity opening and keeps terminal/unfinished status honest", () => Effect.gen(function* () {
    const db = yield* setup
    yield* insert(db, 1, user(1))
    yield* insert(db, 3, assistant(3, "Zwischenstand.", false))
    yield* insert(db, 4, assistant(4, "Fehler.", true, true))
    yield* db.insert(SessionActivityTable).values({ id: "act_1", session_id: id, kind: "prompt", status: "failed", opened_seq: 2, closed_seq: 5 }).run().pipe(Effect.orDie)
    const context = yield* SessionPluginContext.read({ db, sessionID: id })
    expect(context.selection).toBe("activity")
    expect(context.messages[0]?.role).toBe("user")
    expect(context.activity.status).toBe("failed")
    expect(context.messages.slice(1).every((message) => !message.complete)).toBe(true)
  }))
  it.effect("reads native body/sections/options without hidden fields, default values or repairing state", () => Effect.gen(function* () {
    const db = yield* setup
    yield* db.insert(QuestionTable).values([question(1), question(2, "replied"), question(3, "orphaned"), question(4, "rejected"), question(5, "queued")]).run().pipe(Effect.orDie)
    yield* db.insert(SessionActivityTable).values({ id: "act_expired", session_id: id, kind: "prompt", status: "running", lease_until: 0 }).run().pipe(Effect.orDie)
    const before = yield* db.select().from(QuestionTable).all().pipe(Effect.orDie)
    const context = yield* SessionPluginContext.read({ db, sessionID: id })
    expect(context.pending.questions).toHaveLength(1)
    expect(context.pending.questions[0]?.items[0]?.context).toContain("Neustartfreigabe")
    expect(context.pending.questions[0]?.items[0]?.context).toContain("Alle Tests grÃ¼n")
    expect(context.pending.questions[0]?.items[0]?.fields).toEqual([{ label: "Name" }])
    expect(JSON.stringify(context)).not.toContain("PRIVATE_VALUE")
    expect(JSON.stringify(context)).not.toContain("SECRET")
    expect(JSON.stringify(context)).not.toContain("HIDDEN_LABEL")
    expect(yield* db.select().from(QuestionTable).all().pipe(Effect.orDie)).toEqual(before)
  }))
  it.effect("bounds newest messages and total text including questions", () => Effect.gen(function* () {
    const db = yield* setup
    yield* insert(db, 1, user(1))
    for (let seq = 2; seq < 210; seq++) yield* insert(db, seq, assistant(seq, `Ergebnis ${seq}.`))
    const one = yield* SessionPluginContext.read({ db, sessionID: id, limit: 1 })
    expect(one.messages[0]?.text).toBe("Ergebnis 209.")
    expect(one.truncated.messages).toBe(true)
    const capped = yield* SessionPluginContext.read({ db, sessionID: id, limit: 200 })
    expect(capped.messages).toHaveLength(200)
    expect(capped.messages[0]?.role).toBe("user")
    yield* db.insert(QuestionTable).values(question(1)).run().pipe(Effect.orDie)
    const tiny = yield* SessionPluginContext.read({ db, sessionID: id, maxTextChars: 10 })
    expect(tiny.truncated.text).toBe(true)
    expect(tiny.pending.questions[0]?.items[0]?.text.length).toBeLessThanOrEqual(10)
    expect(tiny.messages).toHaveLength(0)
  }))
  it.effect("filters foreign permissions and caps requests", () => Effect.gen(function* () {
    const db = yield* setup
    yield* db.insert(QuestionTable).values(Array.from({ length: 34 }, (_, index) => question(index + 1))).run().pipe(Effect.orDie)
    const context = yield* SessionPluginContext.read({ db, sessionID: id, permissions: [
      { id: "per_here", sessionID: id, action: "write", resources: ["notes.md"] },
      { id: "per_other", sessionID: other, action: "write", resources: ["PRIVATE_PATH"] },
    ] })
    expect(context.pending.questions).toHaveLength(32)
    expect(context.totals.questions).toBe(34)
    expect(context.totals.permissions).toBe(1)
    expect(context.truncated.pending).toBe(true)
    expect(JSON.stringify(context)).not.toContain("PRIVATE_PATH")
    yield* db.delete(QuestionTable).where(eq(QuestionTable.session_id, id)).run().pipe(Effect.orDie)
    const permission = yield* SessionPluginContext.read({ db, sessionID: id, permissions: [{ id: "per_here", sessionID: id, action: "write", resources: ["notes.md"] }] })
    expect(permission.pending.permissions[0]?.id).toBe("per_here")
  }))
  const setTodos = (db: Database.Interface["db"], todos: Array<{ content: string; status: string; priority: string }>, sessionID = id) =>
    Effect.gen(function* () {
      yield* db.delete(TodoTable).where(eq(TodoTable.session_id, sessionID)).run().pipe(Effect.orDie)
      if (todos.length === 0) return
      yield* db.insert(TodoTable).values(todos.map((todo, position) => ({ session_id: sessionID, content: todo.content, status: todo.status, priority: todo.priority, position }))).run().pipe(Effect.orDie)
    })
  it.effect("todos come from the canonical store even when the answer text omits them, mixed statuses included", () => Effect.gen(function* () {
    const db = yield* setup
    yield* insert(db, 1, user(1))
    yield* insert(db, 2, assistant(2, "Erledigt."))
    yield* setTodos(db, [
      { content: "Regel entfernen", status: "completed", priority: "high" },
      { content: "Bridge bauen", status: "in_progress", priority: "medium" },
      { content: "Deploy vorbereiten", status: "pending", priority: "low" },
      { content: "Alter Ansatz", status: "cancelled", priority: "low" },
      { content: "MysteriÃ¶s", status: "warte_auf_lieferant", priority: "low" },
    ])
    const context = yield* SessionPluginContext.read({ db, sessionID: id })
    expect(context.todos?.total).toBe(5)
    expect(context.todos?.items.map((todo) => todo.status)).toEqual(["completed", "in_progress", "pending", "cancelled", "warte_auf_lieferant"])
    expect(context.todos?.items[0]?.content).toBe("Regel entfernen")
    expect(context.todos?.items[0]?.priority).toBe("high")
    // The assistant answer text is not the todo source; the store is.
    expect(context.messages[1]?.text).not.toContain("Bridge bauen")
    expect(JSON.stringify(context.todos)).toContain("Bridge bauen")
  }))
  it.effect("todos of other sessions never leak into this context", () => Effect.gen(function* () {
    const db = yield* setup
    yield* setTodos(db, [{ content: "Meins", status: "pending", priority: "medium" }])
    yield* setTodos(db, [{ content: "FREMD_TODO_INHALT", status: "pending", priority: "medium" }], other)
    const context = yield* SessionPluginContext.read({ db, sessionID: id })
    expect(context.todos?.items.map((todo) => todo.content)).toEqual(["Meins"])
    expect(JSON.stringify(context)).not.toContain("FREMD_TODO_INHALT")
  }))
  it.effect("an empty todo list is an honest empty list, not a missing one", () => Effect.gen(function* () {
    const db = yield* setup
    yield* insert(db, 1, user(1))
    const context = yield* SessionPluginContext.read({ db, sessionID: id })
    expect(context.todos).toBeDefined()
    expect(context.todos?.items).toEqual([])
    expect(context.todos?.total).toBe(0)
    expect(context.todos?.truncated).toBe(false)
  }))
  it.effect("todos are bounded and report truncation, contents capped", () => Effect.gen(function* () {
    const db = yield* setup
    yield* setTodos(db, Array.from({ length: 34 }, (_, index) => ({ content: `Todo ${index + 1}`, status: "pending", priority: "low" })))
    yield* setTodos(db, [{ content: "x".repeat(500), status: "pending", priority: "low" }])
    const bounded = yield* SessionPluginContext.read({ db, sessionID: id })
    expect(bounded.todos?.items).toHaveLength(1)
    expect(bounded.todos?.items[0]?.content.length).toBeLessThanOrEqual(200)
    yield* setTodos(db, Array.from({ length: 34 }, (_, index) => ({ content: `Todo ${index + 1}`, status: "pending", priority: "low" })))
    const context = yield* SessionPluginContext.read({ db, sessionID: id })
    expect(context.todos?.items).toHaveLength(32)
    expect(context.todos?.total).toBe(34)
    expect(context.todos?.truncated).toBe(true)
  }))
  it.effect("a todo change invalidates the final fingerprint without touching capture time", () => Effect.gen(function* () {
    const db = yield* setup
    yield* insert(db, 1, user(1))
    yield* insert(db, 2, assistant(2))
    yield* setTodos(db, [{ content: "Noch offen", status: "pending", priority: "medium" }])
    const first = yield* SessionPluginContext.read({ db, sessionID: id, now: 1 })
    expect(first.todos?.items[0]?.status).toBe("pending")
    yield* setTodos(db, [{ content: "Noch offen", status: "completed", priority: "medium" }])
    const second = yield* SessionPluginContext.read({ db, sessionID: id, now: 1 })
    expect(second.todos?.items[0]?.status).toBe("completed")
    expect(second.fingerprint).not.toBe(first.fingerprint)
  }))
  it.effect("fingerprint stays sensitive beyond the transfer caps (position-33 repro)", () => Effect.gen(function* () {
    const db = yield* setup
    yield* insert(db, 1, user(1))
    yield* setTodos(db, [
      ...Array.from({ length: 33 }, (_, index) => ({ content: `Todo ${index + 1}`, status: "pending", priority: "low" })),
      { content: `${"x".repeat(220)} base`, status: "pending", priority: "low" },
    ])
    const before = yield* SessionPluginContext.read({ db, sessionID: id, now: 1 })
    expect(before.todos?.items).toHaveLength(32)
    expect(before.todos?.truncated).toBe(true)
    expect(before.todos?.digest).toMatch(/^[0-9a-f]{64}$/)
    // Status flip at position 33 is invisible in the capped item list…
    yield* setTodos(db, [
      ...Array.from({ length: 33 }, (_, index) => ({ content: `Todo ${index + 1}`, status: index === 32 ? "completed" : "pending", priority: "low" })),
      { content: `${"x".repeat(220)} base`, status: "pending", priority: "low" },
    ])
    const afterStatus = yield* SessionPluginContext.read({ db, sessionID: id, now: 1 })
    expect(afterStatus.todos?.items).toHaveLength(32)
    expect(afterStatus.fingerprint).not.toBe(before.fingerprint)
    // …a content suffix beyond the 200-char cap is as well…
    yield* setTodos(db, [
      ...Array.from({ length: 33 }, (_, index) => ({ content: `Todo ${index + 1}`, status: index === 32 ? "completed" : "pending", priority: "low" })),
      { content: `${"x".repeat(220)} base changed`, status: "pending", priority: "low" },
    ])
    const afterContent = yield* SessionPluginContext.read({ db, sessionID: id, now: 1 })
    expect(afterContent.todos?.items[31]?.content.endsWith("changed")).toBe(false)
    expect(afterContent.fingerprint).not.toBe(afterStatus.fingerprint)
    // …and so is a priority change on any out-of-cap row.
    yield* setTodos(db, [
      ...Array.from({ length: 33 }, (_, index) => ({ content: `Todo ${index + 1}`, status: index === 32 ? "completed" : "pending", priority: index === 0 ? "high" : "low" })),
      { content: `${"x".repeat(220)} base changed`, status: "pending", priority: "low" },
    ])
    const afterPriority = yield* SessionPluginContext.read({ db, sessionID: id, now: 1 })
    expect(afterPriority.fingerprint).not.toBe(afterContent.fingerprint)
  }))
  it.effect("an unchanged todo list hashes identically and read never mutates the store", () => Effect.gen(function* () {
    const db = yield* setup
    yield* setTodos(db, Array.from({ length: 34 }, (_, index) => ({ content: `Todo ${index + 1}`, status: "pending", priority: "low" })))
    const beforeRows = yield* db.select().from(TodoTable).all().pipe(Effect.orDie)
    const first = yield* SessionPluginContext.read({ db, sessionID: id, now: 1 })
    const second = yield* SessionPluginContext.read({ db, sessionID: id, now: 2 })
    expect(second.fingerprint).toBe(first.fingerprint)
    expect(first.todos?.digest).toBe(second.todos?.digest)
    const afterRows = yield* db.select().from(TodoTable).all().pipe(Effect.orDie)
    expect(afterRows).toEqual(beforeRows)
  }))
})
