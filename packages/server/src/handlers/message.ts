import { SessionMessage } from "@opencode-ai/core/session/message"
import { CrashActivity } from "@opencode-ai/core/observability/crash-activity"
import { SessionV2 } from "@opencode-ai/core/session"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { InvalidCursorError, MessageNotFoundError, SessionNotFoundError, UnknownError } from "../errors"

const DefaultMessagesLimit = 50

const Cursor = Schema.Struct({
  id: SessionMessage.ID,
  order: Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")]),
  direction: Schema.Union([Schema.Literal("previous"), Schema.Literal("next")]),
})

const decodeCursor = Schema.decodeUnknownSync(Cursor)

const cursor = {
  encode(message: SessionMessage.Message, order: "asc" | "desc", direction: "previous" | "next") {
    return Buffer.from(JSON.stringify({ id: message.id, order, direction })).toString("base64url")
  },
  decode(input: string) {
    return decodeCursor(JSON.parse(Buffer.from(input, "base64url").toString("utf8")))
  },
}

export const MessageHandler = HttpApiBuilder.group(Api, "server.message", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service

    return handlers.handle(
      "session.messages",
      Effect.fn(function* (ctx) {
        const trace = { kind: "session-stage", sessionID: ctx.params.sessionID } as const
        const encodedCursor = ctx.query.cursor
        if (encodedCursor && ctx.query.order !== undefined)
          return yield* new InvalidCursorError({ message: "Cursor cannot be combined with order" })
        if (encodedCursor && ctx.query.anchor)
          return yield* new InvalidCursorError({ message: "Cursor cannot be combined with anchor" })
        const decoded = yield* Effect.try({
          try: () => encodedCursor
            ? CrashActivity.trackSync({ ...trace, name: "http.cursor-decode" }, () => cursor.decode(encodedCursor))
            : undefined,
          catch: () => new InvalidCursorError({ message: "Invalid cursor" }),
        })
        const order = decoded?.order ?? ctx.query.order ?? "desc"
        const limit = ctx.query.limit ?? DefaultMessagesLimit
        const page = yield* CrashActivity.track({ ...trace, name: "http.message-page" }, Effect.gen(function* () {
          if (!ctx.query.anchor)
            return directionalPage(
              yield* session.messages({
                sessionID: ctx.params.sessionID,
                limit: limit + 1,
                order,
                cursor: decoded ? { id: decoded.id, direction: decoded.direction } : undefined,
              }),
              limit,
              decoded?.direction,
            )
          yield* session.get(ctx.params.sessionID)
          const anchor = yield* session.message({ sessionID: ctx.params.sessionID, messageID: ctx.query.anchor })
          if (!anchor)
            return yield* new MessageNotFoundError({
              sessionID: ctx.params.sessionID,
              messageID: ctx.query.anchor,
              message: `Message not found: ${ctx.query.anchor}`,
            })
          const anchorMode = ctx.query.anchorMode ?? "around"
          if (anchorMode !== "around")
            return directionalPage(
              yield* session.messages({
                sessionID: ctx.params.sessionID,
                limit: limit + 1,
                order,
                cursor: { id: anchor.id, direction: anchorMode },
              }),
              limit,
              anchorMode,
            )
          const previous = yield* session.messages({
            sessionID: ctx.params.sessionID,
            limit,
            order,
            cursor: { id: anchor.id, direction: "previous" },
          })
          const next = yield* session.messages({
            sessionID: ctx.params.sessionID,
            limit,
            order,
            cursor: { id: anchor.id, direction: "next" },
          })
          const previousTarget = Math.min(Math.floor((limit - 1) / 2), previous.length)
          const nextTarget = Math.min(limit - 1 - previousTarget, next.length)
          const previousCount = Math.min(limit - 1 - nextTarget, previous.length)
          return {
            messages: [...previous.slice(previous.length - previousCount), anchor, ...next.slice(0, nextTarget)],
            hasPrevious: previous.length > previousCount,
            hasNext: next.length > nextTarget,
          }
        })).pipe(
          Effect.catchTag("Session.NotFoundError", (error) =>
            Effect.fail(
              new SessionNotFoundError({
                sessionID: error.sessionID,
                message: `Session not found: ${error.sessionID}`,
              }),
            ),
          ),
          Effect.catchTag("Session.MessageDecodeError", (error) => {
            const ref = `err_${crypto.randomUUID().slice(0, 8)}`
            return Effect.logError("failed to decode session message").pipe(
              Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
              Effect.andThen(
                Effect.fail(
                  new UnknownError({
                    message: "Unexpected server error. Check server logs for details.",
                    ref,
                  }),
                ),
              ),
            )
          }),
        )
        const first = page.messages[0]
        const last = page.messages.at(-1)
        const contextAnchor = order === "asc" ? first : last
        const context = contextAnchor
          ? yield* CrashActivity.track({ ...trace, name: "http.message-context" },
              session.messageContext({ sessionID: ctx.params.sessionID, before: contextAnchor.id }))
              .pipe(
                Effect.catchTag("Session.MessageDecodeError", (error) => {
                  const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                  return Effect.logError("failed to decode session message context").pipe(
                    Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
                    Effect.andThen(
                      Effect.fail(
                        new UnknownError({
                          message: "Unexpected server error. Check server logs for details.",
                          ref,
                        }),
                      ),
                    ),
                  )
                }),
              )
          : []
        return CrashActivity.trackSync({ ...trace, name: "http.public-projection" }, () => ({
          data: page.messages.map(SessionMessage.projectForPublicRead),
          context: (isUserLike(contextAnchor) ? context.filter((message) => !isUserLike(message)) : context).map(
            SessionMessage.projectForPublicRead,
          ),
          cursor: {
            previous: first && page.hasPrevious ? cursor.encode(first, order, "previous") : undefined,
            next: last && page.hasNext ? cursor.encode(last, order, "next") : undefined,
          },
        }))
      }),
    )
  }),
)

function directionalPage(
  messages: SessionMessage.Message[],
  limit: number,
  direction?: "previous" | "next",
) {
  const data = messages.slice(0, limit)
  const hasMore = messages.length > limit
  if (direction === "previous") return { messages: data, hasPrevious: hasMore, hasNext: data.length > 0 }
  if (direction === "next") return { messages: data, hasPrevious: data.length > 0, hasNext: hasMore }
  return { messages: data, hasPrevious: false, hasNext: hasMore }
}

function isUserLike(message?: SessionMessage.Message) {
  return message?.type === "user" || message?.type === "compaction" || message?.type === "synthetic" || message?.type === "shell"
}
