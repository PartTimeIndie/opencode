export * as SessionAccess from "./access"

import { and, asc, desc, eq, gt, inArray, lt } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { ContentStore } from "../content-store"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { Prompt } from "./prompt"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"
import { SessionActivityTable, SessionMessageTable } from "./sql"
import { SessionWakeup } from "./wakeup"

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionAccess.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class RevertActiveError extends Schema.TaggedErrorClass<RevertActiveError>()("SessionAccess.RevertActiveError", {
  sessionID: SessionSchema.ID,
}) {}

export class PromptConflictError extends Schema.TaggedErrorClass<PromptConflictError>()(
  "SessionAccess.PromptConflictError",
  {
    sessionID: SessionSchema.ID,
    messageID: SessionMessage.ID,
  },
) {}

export class InvalidCursorError extends Schema.TaggedErrorClass<InvalidCursorError>()(
  "SessionAccess.InvalidCursorError",
  {
    sessionID: SessionSchema.ID,
    messageID: SessionMessage.ID,
  },
) {}

export type MessageCursor = {
  readonly id: SessionMessage.ID
  readonly direction: "previous" | "next"
}

export type MessagesInput = {
  readonly sessionID: SessionSchema.ID
  readonly limit: number
  readonly order: "asc" | "desc"
  readonly cursor?: MessageCursor
}

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly activity: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<{ readonly type: "idle" | "busy"; readonly activityID?: string }>
  readonly messages: (
    input: MessagesInput,
  ) => Effect.Effect<
    { readonly messages: SessionMessage.Message[]; readonly hasMore: boolean },
    NotFoundError | InvalidCursorError
  >
  readonly send: (input: {
    readonly id?: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: SessionInput.Delivery
    readonly origin?: SessionInput.Origin
  }) => Effect.Effect<
    SessionInput.Admitted,
    NotFoundError | RevertActiveError | PromptConflictError | ContentStore.Error
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionAccess") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const store = yield* SessionStore.Service
    const content = yield* ContentStore.Service
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)

    const get = Effect.fn("SessionAccess.get")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* new NotFoundError({ sessionID })
      return session
    })

    return Service.of({
      get,
      activity: Effect.fn("SessionAccess.activity")(function* (sessionID) {
        const row = yield* db
          .select({ id: SessionActivityTable.id })
          .from(SessionActivityTable)
          .where(
            and(
              eq(SessionActivityTable.session_id, sessionID),
              inArray(SessionActivityTable.status, ["running", "recovering"]),
              gt(SessionActivityTable.lease_until, Date.now()),
            ),
          )
          .orderBy(desc(SessionActivityTable.time_updated))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        return row ? { type: "busy" as const, activityID: row.id } : { type: "idle" as const }
      }),
      messages: Effect.fn("SessionAccess.messages")(function* (input) {
        yield* get(input.sessionID)
        const direction = input.cursor?.direction ?? "next"
        const order = direction === "previous" ? (input.order === "asc" ? "desc" : "asc") : input.order
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
        if (input.cursor && !anchor)
          return yield* new InvalidCursorError({ sessionID: input.sessionID, messageID: input.cursor.id })
        const boundary = anchor
          ? order === "asc"
            ? gt(SessionMessageTable.seq, anchor.seq)
            : lt(SessionMessageTable.seq, anchor.seq)
          : undefined
        const rows = yield* db
          .select()
          .from(SessionMessageTable)
          .where(
            boundary
              ? and(eq(SessionMessageTable.session_id, input.sessionID), boundary)
              : eq(SessionMessageTable.session_id, input.sessionID),
          )
          .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
          .limit(input.limit + 1)
          .all()
          .pipe(Effect.orDie)
        const selected = rows.slice(0, input.limit)
        const messages = yield* Effect.forEach(direction === "previous" ? selected.toReversed() : selected, (row) =>
          decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(Effect.orDie),
        )
        return { messages, hasMore: rows.length > input.limit }
      }),
      send: Effect.fn("SessionAccess.send")(function* (input) {
        const session = yield* get(input.sessionID)
        if (session.revert) return yield* new RevertActiveError({ sessionID: input.sessionID })
        const messageID = input.id ?? SessionMessage.ID.create()
        const existing = input.id === undefined ? undefined : yield* SessionInput.find(db, messageID)
        const prompt =
          existing && SessionInput.equivalent(existing, input)
            ? input.prompt
            : yield* content.normalizePrompt({
                sessionID: input.sessionID,
                messageID,
                prompt: input.prompt,
              })
        const admitted = yield* SessionInput.admit(db, events, {
          id: messageID,
          sessionID: input.sessionID,
          prompt,
          delivery: input.delivery,
          ...(input.origin === undefined ? {} : { origin: input.origin }),
        }).pipe(
          Effect.catchDefect((defect) =>
            defect instanceof SessionInput.LifecycleConflict
              ? new PromptConflictError({ sessionID: input.sessionID, messageID })
              : Effect.die(defect),
          ),
        )
        if (!SessionInput.equivalent(admitted, { sessionID: input.sessionID, prompt, delivery: input.delivery }))
          return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
        yield* SessionWakeup.request(input.sessionID, admitted.admittedSeq)
        return admitted
      }),
    })
  }),
)
