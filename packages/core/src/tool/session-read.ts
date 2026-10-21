export * as SessionReadTool from "./session-read"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { SessionAccess } from "../session/access"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "session_read"

const Cursor = Schema.Struct({
  id: SessionMessage.ID,
  direction: Schema.Literals(["previous", "next"]),
})

export const Input = Schema.Struct({
  session_id: SessionSchema.ID.annotate({ description: "ID of the Session to read" }),
  limit: PositiveInt.pipe(Schema.optional).annotate({ description: "Messages to return, from 1 to 200" }),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  cursor: Cursor.pipe(Schema.optional).annotate({
    description:
      "Omit this field entirely on the first read. For later pages, pass exactly a cursor object returned by the immediately preceding session_read result; never invent or modify its id or direction.",
  }),
})

export const Output = Schema.Struct({
  session: SessionSchema.Info,
  activity: Schema.Struct({
    type: Schema.Literals(["idle", "busy"]),
    activityID: Schema.String.pipe(Schema.optional),
  }),
  messages: Schema.Array(SessionMessage.Message),
  cursor: Schema.Struct({
    previous: Cursor.pipe(Schema.optional),
    next: Cursor.pipe(Schema.optional),
  }),
  hasMore: Schema.Boolean,
})

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const sessions = yield* SessionAccess.Service

    yield* tools.register({
      [name]: Tool.withPermission(
        Tool.make({
          description:
            "Read another OpenCode Session by ID, including metadata, activity status, and a paginated page of projected user, assistant, reasoning, and tool messages. Run this only when the user explicitly asks to read that Session's history; a request to communicate or coordinate alone does not authorize reading. On the first read, omit cursor entirely. For later pages, pass the exact cursor object returned in the immediately preceding result; never send an empty or invented cursor.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission
                .assert({
                  action: name,
                  resources: [input.session_id],
                  save: [input.session_id],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  metadata: { targetSessionID: input.session_id },
                  source: {
                    type: "tool",
                    messageID: context.assistantMessageID,
                    callID: context.toolCallID,
                  },
                })
                .pipe(Effect.mapError(() => new ToolFailure({ message: "Permission denied: session_read" })))
              const limit = Math.min(input.limit ?? 50, 200)
              const session = yield* sessions
                .get(input.session_id)
                .pipe(Effect.mapError(() => new ToolFailure({ message: `Session not found: ${input.session_id}` })))
              const [activity, page] = yield* Effect.all([
                sessions.activity(input.session_id),
                sessions.messages({
                  sessionID: input.session_id,
                  limit,
                  order: input.order ?? "desc",
                  ...(input.cursor ? { cursor: input.cursor } : {}),
                }),
              ]).pipe(
                Effect.mapError(() => new ToolFailure({ message: `Unable to read Session: ${input.session_id}` })),
              )
              const first = page.messages[0]
              const last = page.messages.at(-1)
              return {
                session,
                activity,
                messages: page.messages,
                cursor: {
                  ...(first ? { previous: { id: first.id, direction: "previous" as const } } : {}),
                  ...(last ? { next: { id: last.id, direction: "next" as const } } : {}),
                },
                hasMore: page.hasMore,
              }
            }),
        }),
        name,
      ),
    }).pipe(Effect.orDie)
  }),
)
