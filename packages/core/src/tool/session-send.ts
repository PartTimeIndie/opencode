export * as SessionSendTool from "./session-send"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { PermissionV2 } from "../permission"
import { SessionAccess } from "../session/access"
import { SessionInput } from "../session/input"
import { SessionMessage } from "../session/message"
import { Prompt } from "../session/prompt"
import { SessionSchema } from "../session/schema"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "session_send"

export const Input = Schema.Struct({
  session_id: SessionSchema.ID.annotate({ description: "ID of the Session that should receive the message" }),
  message: Schema.String.annotate({ description: "Message to send" }),
  delivery: SessionInput.Delivery.pipe(Schema.optional).annotate({
    description: "steer joins the active activity at its next safe turn; queue starts a future activity",
  }),
})

export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
  delivery: SessionInput.Delivery,
  admittedSeq: Schema.Number,
  text: Schema.String,
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
            "Send a durable message to another existing OpenCode Session by its exact ID; never invent or guess a Session ID. When the user asks agents to talk, coordinate, or update each other, this is the tool to use. Delivery defaults to steer and joins an active Session at its next safe turn; queue starts a future activity. Answer a received cross-session message by sending back to the Session ID in its provenance header. Admission only confirms durable receipt, not a completed answer; never spawn a Session or read another chat as a fallback.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const message = input.message.trim()
              if (!message) return yield* new ToolFailure({ message: "session_send requires a non-empty message" })
              if (input.session_id === context.sessionID)
                return yield* new ToolFailure({ message: "session_send cannot target the current Session" })
              const delivery = input.delivery ?? "steer"
              yield* permission
                .assert({
                  action: name,
                  resources: [input.session_id],
                  save: [input.session_id],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  metadata: { targetSessionID: input.session_id, delivery },
                  source: {
                    type: "tool",
                    messageID: context.assistantMessageID,
                    callID: context.toolCallID,
                  },
                })
                .pipe(Effect.mapError(() => new ToolFailure({ message: "Permission denied: session_send" })))
              const admitted = yield* sessions
                .send({
                  sessionID: input.session_id,
                  prompt: new Prompt({ text: `[Cross-session message from ${context.sessionID}]\n\n${message}` }),
                  delivery,
                })
                .pipe(
                  Effect.mapError((error) =>
                    new ToolFailure({
                      message:
                        error._tag === "SessionAccess.NotFoundError"
                          ? `Session not found: ${input.session_id}`
                          : `Unable to send to Session ${input.session_id}: ${error._tag}`,
                    }),
                  ),
                )
              return {
                sessionID: input.session_id,
                messageID: admitted.id,
                delivery,
                admittedSeq: admitted.admittedSeq,
                text: `Sent ${delivery} message to Session ${input.session_id}.`,
              }
            }),
        }),
        name,
      ),
    }).pipe(Effect.orDie)
  }),
)
