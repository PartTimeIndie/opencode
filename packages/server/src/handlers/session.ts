import { SessionV2 } from "@opencode-ai/core/session"
import type { SummaryFailed } from "@opencode-ai/core/session/compaction"
import type { MessageDecodeError } from "@opencode-ai/core/session/error"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionPlanDocument } from "@opencode-ai/core/session/plan-document"
import { Cause, Clock, DateTime, Effect, Schema } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { SessionsCursor } from "../groups/session"
import {
  ConflictError,
  InvalidRequestError,
  InvalidCursorError,
  MessageNotFoundError,
  SessionNotFoundError,
  ServiceUnavailableError,
  UnknownError,
} from "../errors"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionFailure } from "@opencode-ai/core/session/failure"
import { SessionActivity } from "@opencode-ai/core/session/activity"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { BashTool } from "@opencode-ai/core/tool/bash"
import { TaskTool } from "@opencode-ai/core/tool/task"
import { AgentV2 } from "@opencode-ai/core/agent"
import { ModelV2 } from "@opencode-ai/core/model"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillTool } from "@opencode-ai/core/tool/skill"
import { CommandV2 } from "@opencode-ai/core/command"
import { PluginBoot } from "@opencode-ai/core/plugin/boot"
import { parseSessionGoalControl, sessionGoalMetadataPatch } from "../session-goal"
import { CommandPlugin } from "../command-plugin"
import { QuestionV2 } from "@opencode-ai/core/question"
import { AgentSwitchTool } from "@opencode-ai/core/tool/agent-switch"
import { exec } from "child_process"

const DefaultSessionsLimit = 50
const shellRegex = /!`([^`]+)`/g
const commandOutputLimit = 200_000
const commandTimeout = 30_000

function shellSettlementText(settlement: ToolRegistry.Settlement) {
  const content: NonNullable<ToolRegistry.Settlement["output"]>["content"] =
    settlement.output?.content ?? (settlement.result.type === "content" ? settlement.result.value : [])
  const text = content.flatMap((item) => (item.type === "text" ? [item.text] : [`[file] ${item.name ?? item.uri}`]))
  if (text.length > 0) return text.join("\n")
  if (settlement.result.type === "error" || settlement.result.type === "text") return String(settlement.result.value)
  return JSON.stringify(settlement.result.value) ?? String(settlement.result.value)
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value }
}

function message(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function toolOutputFromResultValue(result: ToolRegistry.Settlement["result"]) {
  switch (result.type) {
    case "json":
      return { structured: result.value, content: [] }
    case "text":
      return { structured: {}, content: [{ type: "text" as const, text: message(result.value) }] }
    case "content":
      return { structured: {}, content: result.value }
    case "error":
      return undefined
  }
}

function modelString(model: ModelV2.Ref) {
  return `${model.providerID}/${model.id}`
}

function contentStoreFailure(error: {
  readonly operation: "decode" | "read" | "write" | "database" | "integrity" | "limit"
  readonly resource: string
}) {
  return Effect.fail(
    error.operation === "decode" || error.operation === "read" || error.operation === "limit"
      ? new InvalidRequestError({
          field: "prompt.files",
          kind: "attachment_unreadable",
          message: `Attachment could not be read: ${error.resource}`,
        })
      : new UnknownError({
          message: "Attachment could not be stored durably.",
        }),
  )
}

function zeroUsage() {
  return {
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

/** Model-switch preflight can compact too; both endpoints need the same errors. */
export function sessionCompactionFailure(
  error: SummaryFailed | MessageDecodeError,
): Effect.Effect<never, ServiceUnavailableError | UnknownError> {
  if (error._tag === "SessionCompactionSummaryFailed")
    return Effect.fail(new ServiceUnavailableError({ message: error.reason, service: "session-compaction" }))
  const ref = `err_${crypto.randomUUID().slice(0, 8)}`
  return Effect.logError("failed to decode session message during compaction").pipe(
    Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
    Effect.andThen(
      Effect.fail(new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref })),
    ),
  )
}

const skillContent = Effect.fn("SessionHandler.skillContent")(function* (input: {
  name: string
  skills: SkillV2.Info[]
}) {
  const selected = input.skills.find((skill) => skill.name === input.name)
  if (!selected)
    return yield* new InvalidRequestError({
      field: "skill",
      kind: "skill_not_found",
      message: `Skill not found: ${input.name}`,
    })
  return SkillTool.toModelOutput(selected, [])
})

const expandCommandShell = Effect.fn("SessionHandler.expandCommandShell")(function* (input: {
  template: string
  directory: string
}) {
  const matches = Array.from(input.template.matchAll(shellRegex))
  if (matches.length === 0) return input.template.trim()
  const results = yield* Effect.forEach(
    matches,
    ([, command]) => Effect.promise(() => shellOutput(command, input.directory)),
    { concurrency: 1 },
  )
  let index = 0
  return input.template.replace(shellRegex, () => results[index++] ?? "").trim()
})

function shellOutput(command: string, cwd: string) {
  return new Promise<string>((resolve) => {
    exec(command, { cwd, timeout: commandTimeout, maxBuffer: commandOutputLimit }, (_error, stdout, stderr) => {
      resolve(stdout || stderr || "")
    })
  })
}

export const loadSessionCommand = Effect.fn("SessionHandler.loadSessionCommand")(function* (input: {
  readonly command: string
  readonly location: SessionV2.Info["location"]
}) {
  const locations = yield* LocationServiceMap
  return yield* Effect.gen(function* () {
    const first = yield* CommandV2.Service.use((commands) => commands.get(input.command))
    if (first) return first
    yield* PluginBoot.Service.use((boot) => boot.wait({ mcpCommands: true }))
    yield* PluginBoot.Service.use((boot) => boot.refreshMcpCommands())
    return yield* CommandV2.Service.use((commands) => commands.get(input.command))
  }).pipe(Effect.provide(locations.get(input.location)))
})

export const SessionHandler = HttpApiBuilder.group(Api, "server.session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const activity = yield* SessionActivity.Service
    const execution = yield* SessionExecution.Service
    const events = yield* EventV2.Service
    const commandPlugin = yield* CommandPlugin.Service
    const locations = yield* LocationServiceMap
    const db = (yield* Database.Service).db

    const runSubtaskCommand = Effect.fn("SessionHandler.runSubtaskCommand")(function* (input: {
      readonly sessionID: SessionV2.ID
      readonly messageID?: SessionMessage.ID
      readonly location: SessionV2.Info["location"]
      readonly prompt: string
      readonly command: CommandV2.Info
      readonly commandName: string
      readonly agent?: AgentV2.ID
      readonly model?: ModelV2.Ref
      readonly files?: ReadonlyArray<typeof SessionEvent.FileAttachment.Type>
      readonly delivery?: SessionInput.Delivery
      readonly resume?: boolean
    }) {
      if (input.delivery === "queue" && input.resume !== false) {
        return yield* new InvalidRequestError({
          field: "delivery",
          kind: "unsupported_subtask_delivery",
          message: `Queued subtask commands are not supported by the V2 command endpoint yet: "${input.commandName}".`,
        })
      }

      const taskAgent = AgentV2.ID.make(input.command.agent ?? input.agent ?? "build")
      const taskModel = input.command.model ?? input.model
      if (input.resume !== false && !taskModel) {
        return yield* new InvalidRequestError({
          field: "model",
          kind: "model_required",
          message: `Subtask command requires a model: "${input.commandName}".`,
        })
      }

      const admitted = yield* session
        .prompt({
          sessionID: input.sessionID,
          id: input.messageID,
          prompt: { text: input.prompt, ...(input.files === undefined ? {} : { files: input.files }) },
          agent: input.agent,
          model: input.model,
          delivery: input.delivery,
          resume: false,
        })
        .pipe(
          Effect.catchTag("Session.NotFoundError", (error) =>
            Effect.fail(
              new SessionNotFoundError({
                sessionID: error.sessionID,
                message: `Session not found: ${error.sessionID}`,
              }),
            ),
          ),
          Effect.catchTag("Session.PromptConflictError", (error) =>
            Effect.fail(
              new ConflictError({
                message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                resource: error.messageID,
              }),
            ),
          ),
          Effect.catchTag("SessionBusyError", (error) =>
            Effect.fail(
              new ConflictError({
                message: `Session is busy: ${error.sessionID}`,
                resource: error.sessionID,
              }),
            ),
          ),
          Effect.catchTag("Session.RollbackBlockedError", (error) =>
            Effect.fail(new ConflictError({
              message: "Rollback is blocked. Resolve the file conflict or explicitly keep files before sending.",
              resource: error.sessionID,
            })),
          ),
          Effect.catchTag("ContentStore.StorageError", contentStoreFailure),
        )
      if (input.resume === false) return admitted
      if (!taskModel) {
        return yield* new InvalidRequestError({
          field: "model",
          kind: "model_required",
          message: `Subtask command requires a model: "${input.commandName}".`,
        })
      }

      yield* SessionInput.promoteSteers(db, events, input.sessionID, admitted.admittedSeq)
      const assistantMessageID = SessionMessage.ID.create()
      const callID = crypto.randomUUID()
      const taskInput = {
        description: input.command.description ?? input.commandName,
        prompt: input.prompt,
        subagent_type: taskAgent,
        model: modelString(taskModel),
        ...(taskModel.variant === undefined ? {} : { variant: taskModel.variant }),
        command: input.commandName,
      }
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: input.sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: taskAgent,
        model: taskModel,
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID: input.sessionID,
        assistantMessageID,
        callID,
        name: TaskTool.name,
        timestamp: yield* DateTime.now,
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID: input.sessionID,
        assistantMessageID,
        callID,
        text: JSON.stringify(taskInput),
        timestamp: yield* DateTime.now,
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID: input.sessionID,
        assistantMessageID,
        callID,
        tool: TaskTool.name,
        input: taskInput,
        provider: { executed: false },
        timestamp: yield* DateTime.now,
      })
      const exit = yield* ToolRegistry.Service.use((registry) =>
        registry.materialize().pipe(
          Effect.flatMap((materialization) =>
            materialization.settle({
              sessionID: input.sessionID,
              agent: taskAgent,
              assistantMessageID,
              call: {
                type: "tool-call",
                id: callID,
                name: TaskTool.name,
                input: taskInput,
              },
            }),
          ),
        ),
      ).pipe(Effect.provide(locations.get(input.location)), Effect.exit)
      if (exit._tag === "Success" && exit.value.result.type !== "error") {
        const output = exit.value.output ?? toolOutputFromResultValue(exit.value.result)
        yield* events.publish(SessionEvent.Tool.Success, {
          sessionID: input.sessionID,
          assistantMessageID,
          callID,
          structured: record(output?.structured),
          content: output?.content ?? [],
          outputPaths: exit.value.outputPaths ? [...exit.value.outputPaths] : [],
          result: exit.value.result,
          provider: { executed: false },
          timestamp: yield* DateTime.now,
        })
      } else if (exit._tag === "Success") {
        const result = exit._tag === "Success" ? exit.value.result : undefined
        yield* events.publish(SessionEvent.Tool.Failed, {
          sessionID: input.sessionID,
          assistantMessageID,
          callID,
          error: {
            type: "unknown",
            message: result?.type === "error" ? message(result.value) : message(result),
          },
          failure: SessionFailure.make("tool.defect", {
            cause: { raw: result?.type === "error" ? message(result.value) : message(result) },
          }),
          ...(result === undefined ? {} : { result }),
          provider: { executed: false },
          timestamp: yield* DateTime.now,
        })
      } else {
        yield* events.publish(SessionEvent.Tool.Failed, {
          sessionID: input.sessionID,
          assistantMessageID,
          callID,
          error: { type: "unknown", message: Cause.pretty(exit.cause) },
          failure: SessionFailure.make("tool.defect", {
            cause: { raw: Cause.pretty(exit.cause) },
          }),
          provider: { executed: false },
          timestamp: yield* DateTime.now,
        })
      }
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: input.sessionID,
        assistantMessageID,
        finish: "tool-calls",
        ...zeroUsage(),
        timestamp: yield* DateTime.now,
      })
      return admitted
    })

    return handlers
      .handle(
        "session.list",
        Effect.fn(function* (ctx) {
          const query =
            ctx.query.cursor !== undefined
              ? yield* SessionsCursor.parse(ctx.query.cursor).pipe(
                  Effect.mapError(() => new InvalidCursorError({ message: "Invalid cursor" })),
                )
              : ctx.query
          const sessions = yield* session.list({
            ...query,
            workspaceID: query.workspace,
            limit: ctx.query.limit ?? DefaultSessionsLimit,
          })
          const first = sessions[0]
          const last = sessions.at(-1)
          return {
            data: sessions,
            cursor: {
              previous: first
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: first.id,
                      time: DateTime.toEpochMillis(first.time.created),
                      direction: "previous",
                    },
                  })
                : undefined,
              next: last
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: last.id,
                      time: DateTime.toEpochMillis(last.time.created),
                      direction: "next",
                    },
                  })
                : undefined,
            },
          }
        }),
      )
      .handle(
        "session.create",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.create({
              id: ctx.payload.id,
              agent: ctx.payload.agent,
              model: ctx.payload.model,
              location: ctx.payload.location ?? { directory: AbsolutePath.make(process.cwd()) },
            }),
          }
        }),
      )
      .handle(
        "session.get",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.get(ctx.params.sessionID).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.prompt",
        Effect.fn(function* (ctx) {
          const admitted = yield* session
            .prompt({
              sessionID: ctx.params.sessionID,
              id: ctx.payload.id,
              prompt: ctx.payload.prompt,
              agent: ctx.payload.agent,
              model: ctx.payload.model,
              system: ctx.payload.system,
              delivery: ctx.payload.delivery,
              resume: ctx.payload.resume,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.PromptConflictError", (error) =>
                Effect.fail(
                  new ConflictError({
                    message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                    resource: error.messageID,
                  }),
                ),
              ),
              Effect.catchTag("SessionBusyError", (error) =>
                Effect.fail(
                  new ConflictError({
                    message: `Session is busy: ${error.sessionID}`,
                    resource: error.sessionID,
                  }),
                ),
              ),
              Effect.catchTag("Session.RollbackBlockedError", (error) =>
                Effect.fail(new ConflictError({
                  message: "Rollback is blocked. Resolve the file conflict or explicitly keep files before sending.",
                  resource: error.sessionID,
                })),
              ),
              Effect.catchTag("ContentStore.StorageError", contentStoreFailure),
            )
          return {
            data: admitted,
          }
        }),
      )
      .handle(
        "session.metadata",
        Effect.fn(function* (ctx) {
          const data = yield* session.patchMetadata({ sessionID: ctx.params.sessionID, patch: ctx.payload }).pipe(
            Effect.map(() => session.get(ctx.params.sessionID)),
            Effect.flatten,
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return { data }
        }),
      )
      .handle(
        "session.command",
        Effect.fn(function* (ctx) {
          const info = yield* session.get(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          const command = yield* loadSessionCommand({ command: ctx.payload.command, location: info.location })
          if (!command) {
            const available = yield* Effect.gen(function* () {
              yield* PluginBoot.Service.use((boot) => boot.wait({ mcpCommands: true }))
              return yield* CommandV2.Service.use((commands) => commands.list())
            }).pipe(Effect.provide(locations.get(info.location)))
            const hint = available.length ? ` Available commands: ${available.map((item) => item.name).join(", ")}` : ""
            return yield* new InvalidRequestError({
              field: "command",
              kind: "command_not_found",
              message: `Command not found: "${ctx.payload.command}".${hint}`,
            })
          }
          const goalControl =
            command.action === "session-goal" ? parseSessionGoalControl(ctx.payload.arguments ?? "") : undefined
          const goalPatch = goalControl ? sessionGoalMetadataPatch(goalControl) : undefined
          if (goalPatch) {
            yield* session.patchMetadata({ sessionID: ctx.params.sessionID, patch: goalPatch }).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            )
          }
          const resolved = yield* CommandV2.Service.use((commands) =>
            commands.resolve({ name: ctx.payload.command, arguments: ctx.payload.arguments ?? "" }),
          ).pipe(Effect.provide(locations.get(info.location)))
          const expanded = yield* expandCommandShell({
            template: resolved ?? "",
            directory: info.location.directory,
          }).pipe(Effect.provide(locations.get(info.location)))
          const prompt = yield* commandPlugin.transform({
            command: ctx.payload.command,
            sessionID: ctx.params.sessionID,
            arguments: ctx.payload.arguments ?? "",
            text: expanded,
          })
          const commandAgentName = command.agent
          const commandAgent = commandAgentName ? AgentV2.ID.make(commandAgentName) : ctx.payload.agent
          const commandModel =
            command.model ??
            ctx.payload.model ??
            (commandAgentName && commandAgentName !== info.agent
              ? yield* AgentV2.Service.use((agents) => agents.get(AgentV2.ID.make(commandAgentName))).pipe(
                  Effect.provide(locations.get(info.location)),
                  Effect.map((agent) => agent?.model),
                )
              : undefined) ??
            info.model
          if (command.subtask === true) {
            const admitted = yield* runSubtaskCommand({
              sessionID: ctx.params.sessionID,
              messageID: ctx.payload.id,
              location: info.location,
              prompt,
              command,
              commandName: ctx.payload.command,
              agent: ctx.payload.agent,
              model: commandModel,
              files: ctx.payload.files,
              delivery: ctx.payload.delivery,
              resume: ctx.payload.resume,
            })
            return { data: admitted }
          }
          const admitted = yield* session
            .prompt({
              sessionID: ctx.params.sessionID,
              id: ctx.payload.id,
              prompt: { text: prompt, ...(ctx.payload.files === undefined ? {} : { files: ctx.payload.files }) },
              agent: commandAgent,
              model: commandModel,
              delivery: ctx.payload.delivery,
              resume: ctx.payload.resume,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.PromptConflictError", (error) =>
                Effect.fail(
                  new ConflictError({
                    message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                    resource: error.messageID,
                  }),
                ),
              ),
              Effect.catchTag("SessionBusyError", (error) =>
                Effect.fail(
                  new ConflictError({
                    message: `Session is busy: ${error.sessionID}`,
                    resource: error.sessionID,
                  }),
                ),
              ),
              Effect.catchTag("Session.RollbackBlockedError", (error) =>
                Effect.fail(new ConflictError({
                  message: "Rollback is blocked. Resolve the file conflict or explicitly keep files before sending.",
                  resource: error.sessionID,
                })),
              ),
              Effect.catchTag("ContentStore.StorageError", contentStoreFailure),
            )
          return { data: admitted }
        }),
      )
      .handle(
        "session.synthetic",
        Effect.fn(function* (ctx) {
          yield* session
            .synthetic({
              sessionID: ctx.params.sessionID,
              id: ctx.payload.id,
              text: ctx.payload.text,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
            )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.resume",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          yield* execution.resumeOrJoin(ctx.params.sessionID).pipe(Effect.ignore, Effect.forkDetach)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.interrupt",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          // Provider/tool fibers can defer interruption while they unwind. Do not
          // keep the HTTP request (and the renderer's Stop action) blocked on that
          // cleanup; the activity terminalizer will publish the final state.
          yield* session.interrupt(ctx.params.sessionID).pipe(Effect.forkDetach)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.rollback",
        Effect.fn(function* (ctx) {
          const data = yield* session
            .rollback({
              sessionID: ctx.params.sessionID,
              messageID: ctx.payload.messageID,
              partID: ctx.payload.partID,
              files: ctx.payload.files,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.RollbackTargetError", (error) =>
                Effect.gen(function* () {
                  if (error.reason === "message")
                    return yield* new MessageNotFoundError({
                      sessionID: error.sessionID,
                      messageID: error.messageID,
                      message: `Rollback message not found: ${error.messageID}`,
                    })
                  return yield* new ConflictError({
                    resource: error.partID,
                    message: `Rollback part not found on message ${error.messageID}: ${error.partID}`,
                  })
                }),
              ),
              Effect.catchTag("Session.RollbackBlockedError", (error) =>
                Effect.fail(new ConflictError({
                  resource: error.sessionID,
                  message: "Checkpoint transition has a file conflict. The previous rollback remains applied.",
                })),
              ),
            )
          return { data }
        }),
      )
      .handle(
        "session.switchAgent",
        Effect.fn(function* (ctx) {
          yield* session
            .switchAgent({
              sessionID: ctx.params.sessionID,
              agent: ctx.payload.agent,
              model: ctx.payload.model,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
            )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.switchModel",
        Effect.fn(function* (ctx) {
          yield* session.switchModel({ sessionID: ctx.params.sessionID, model: ctx.payload.model }).pipe(
            Effect.catchTag("SessionCompactionSummaryFailed", sessionCompactionFailure),
            Effect.catchTag("Session.MessageDecodeError", sessionCompactionFailure),
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.heldInputs",
        Effect.fn(function* (ctx) {
          const data = yield* session.heldInputs(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return { data }
        }),
      )
      .handle(
        "session.releaseInput",
        Effect.fn(function* (ctx) {
          const data = yield* session
            .releaseInput({
              sessionID: ctx.params.sessionID,
              inputID: ctx.params.inputID,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
            )
          return { data: data ?? null }
        }),
      )
      .handle(
        "session.switchAgentAndPrompt",
        Effect.fn(function* (ctx) {
          const current = yield* session.get(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          const questions = <A, E, R>(use: (service: QuestionV2.Interface) => Effect.Effect<A, E, R>) =>
            QuestionV2.Service.use(use).pipe(Effect.provide(locations.get(current.location)))
          const request = yield* questions((service) =>
            service.get(
              QuestionV2.ID.make(ctx.payload.confirmation.requestID),
              SessionV2.ID.make(ctx.params.sessionID),
            ),
          )
          const planDocument = request?.tool?.purpose === "daily_review_implementation"
            ? yield* SessionPlanDocument.Service.use((service) => service.read(current.id)).pipe(
                Effect.provide(locations.get(current.location)),
                Effect.catchTag("SessionPlanDocument.NotFoundError", () => Effect.succeed(undefined)),
              )
            : undefined
          const confirmed = AgentSwitchTool.confirmation(request, {
            sessionID: ctx.params.sessionID,
            revision: ctx.payload.confirmation.revision,
            actionID: ctx.payload.confirmation.actionID,
            agent: ctx.payload.agent,
            prompt: ctx.payload.prompt.text,
            confirmationToken: ctx.payload.confirmation.token,
            planDocument,
          })
          if (!confirmed)
            return yield* new InvalidRequestError({
              field: "confirmation",
              kind: "invalid_agent_handoff",
              message: "Agent handoff confirmation does not match an active switch_agent request.",
            })

          const claim = yield* questions((service) =>
            service.beginActionInvocation({
              id: ctx.payload.confirmation.invocationID,
              target: { kind: "request", id: confirmed.request.id, revision: confirmed.request.revision },
              actionID: confirmed.action.id,
              source: confirmed.tool.name,
              values: ctx.payload.model ? { model: ctx.payload.model } : {},
            }),
          ).pipe(
            Effect.mapError(
              (error) =>
                new InvalidRequestError({
                  field: "confirmation",
                  kind: "invalid_agent_handoff",
                  message: `Unable to claim agent handoff confirmation: ${message(error)}`,
                }),
            ),
          )
          if (!claim.claimed) {
            if (claim.invocation.state === "completed")
              return {
                data: yield* Schema.decodeUnknownEffect(SessionInput.Admitted)(claim.invocation.result).pipe(
                  Effect.mapError(
                    () =>
                      new InvalidRequestError({
                        field: "confirmation.invocationID",
                        kind: "invalid_agent_handoff",
                        message: "Completed handoff invocation has no reusable admitted prompt result.",
                      }),
                  ),
                ),
              }
            return yield* new InvalidRequestError({
              field: "confirmation.invocationID",
              kind: "invalid_agent_handoff",
              message: `Agent handoff invocation is ${claim.invocation.state}.`,
            })
          }

          const data = yield* session
            .switchAgentAndPrompt({
              sessionID: ctx.params.sessionID,
              agent: AgentV2.ID.make(confirmed.step.agent),
              model: ctx.payload.model,
              prompt: ctx.payload.prompt,
            })
            .pipe(
              Effect.tapError((error) =>
                questions((service) =>
                  service.failActionInvocation(ctx.payload.confirmation.invocationID, message(error)),
                ).pipe(Effect.ignore),
              ),
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.mapError((error) =>
                error instanceof SessionNotFoundError
                  ? error
                  : new InvalidRequestError({
                      message: `Unable to switch agent and submit prompt: ${message(error)}`,
                    }),
              ),
            )
          const invocationResult = yield* Schema.encodeEffect(SessionInput.Admitted)(data).pipe(
            Effect.mapError(
              (error) =>
                new InvalidRequestError({
                  field: "confirmation.invocationID",
                  kind: "invalid_agent_handoff",
                  message: `Unable to encode agent handoff result: ${message(error)}`,
                }),
            ),
          )
          const completed = yield* questions((service) =>
            service.completeActionInvocation(ctx.payload.confirmation.invocationID, invocationResult),
          ).pipe(
            Effect.mapError(
              (error) =>
                new InvalidRequestError({
                  field: "confirmation.invocationID",
                  kind: "invalid_agent_handoff",
                  message: `Unable to complete agent handoff confirmation: ${message(error)}`,
                }),
            ),
          )
          return {
            data: yield* Schema.decodeUnknownEffect(SessionInput.Admitted)(completed.result).pipe(
              Effect.mapError(
                () =>
                  new InvalidRequestError({
                    field: "confirmation.invocationID",
                    kind: "invalid_agent_handoff",
                    message: "Completed handoff invocation has no reusable admitted prompt result.",
                  }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.shell",
        Effect.fn(function* (ctx) {
          const info = yield* session.get(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          const messageID = SessionMessage.ID.create()
          const callID = crypto.randomUUID()
          yield* events.publish(SessionEvent.Shell.Started, {
            sessionID: ctx.params.sessionID,
            messageID,
            callID,
            command: ctx.payload.command,
            timestamp: yield* DateTime.now,
          })
          const exit = yield* ToolRegistry.Service.use((registry) =>
            registry.materialize().pipe(
              Effect.flatMap((materialization) =>
                materialization.settle({
                  sessionID: ctx.params.sessionID,
                  agent: ctx.payload.agent ?? info.agent ?? AgentV2.ID.make("build"),
                  assistantMessageID: messageID,
                  call: {
                    type: "tool-call",
                    id: callID,
                    name: BashTool.name,
                    input: { command: ctx.payload.command },
                  },
                }),
              ),
            ),
          ).pipe(Effect.provide(locations.get(info.location)), Effect.exit)
          yield* events.publish(SessionEvent.Shell.Ended, {
            sessionID: ctx.params.sessionID,
            callID,
            output: exit._tag === "Success" ? shellSettlementText(exit.value) : Cause.pretty(exit.cause),
            timestamp: yield* DateTime.now,
          })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.skill",
        Effect.fn(function* (ctx) {
          const info = yield* session.get(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          const text = yield* SkillV2.Service.use((skill) => skill.list()).pipe(
            Effect.provide(locations.get(info.location)),
            Effect.flatMap((skills) => skillContent({ name: ctx.payload.skill, skills })),
          )
          yield* events.publish(SessionEvent.Synthetic, {
            sessionID: ctx.params.sessionID,
            messageID: SessionMessage.ID.create(),
            text,
            timestamp: yield* DateTime.now,
          })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.compact",
        Effect.fn(function* (ctx) {
          yield* session.compact({ sessionID: ctx.params.sessionID }).pipe(
            Effect.catchTag("SessionCompactionSummaryFailed", sessionCompactionFailure),
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.MessageDecodeError", sessionCompactionFailure),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.activity",
        Effect.fn(function* (ctx) {
          const info = yield* session.get(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          const now = yield* Clock.currentTimeMillis
          const activities = yield* activity.listForSession(ctx.params.sessionID)
          const latest = activities.toSorted((a, b) => a.timeCreated - b.timeCreated || a.id.localeCompare(b.id)).at(-1)
          const active = activities.findLast(
            (activity) =>
              (activity.status === "running" || activity.status === "recovering") &&
              activity.leaseUntil !== undefined &&
              activity.leaseUntil > now,
          )
          if (active)
            return {
              data: { type: "busy" as const, activityID: active.id, activityStatus: active.status },
            }

          const waiting = yield* QuestionV2.Service.use((questions) =>
            Effect.gen(function* () {
              const request = (yield* questions.list()).find(
                (candidate) =>
                  candidate.sessionID === ctx.params.sessionID &&
                  candidate.mode === "blocking" &&
                  candidate.detached !== true,
              )
              if (!request) return
              return {
                request,
                target: yield* questions.settlementTarget(request.id, ctx.params.sessionID),
              }
            }),
          ).pipe(Effect.provide(locations.get(info.location)))
          if (!waiting)
            return {
              data: {
                type: "idle" as const,
                ...(latest
                  ? {
                      activityID: latest.id,
                      activityStatus: latest.status,
                      ...(latest.lastError ? { lastError: latest.lastError } : {}),
                    }
                  : {}),
              },
            }

          const waitingActivity = activities.find((activity) => activity.id === waiting.target?.activityID)
          return {
            data: {
              type: "busy" as const,
              ...(waiting.target?.activityID ? { activityID: waiting.target.activityID } : {}),
              ...(waitingActivity ? { activityStatus: waitingActivity.status } : {}),
            },
          }
        }),
      )
      .handle(
        "session.wait",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          yield* execution.wait(ctx.params.sessionID).pipe(Effect.ignore)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.cancelTool",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return { data: { cancelled: yield* execution.cancelTool(ctx.params.sessionID, ctx.params.callID) } }
        }),
      )
      .handle(
        "session.context",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.context(ctx.params.sessionID).pipe(
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
            ),
          }
        }),
      )
  }),
)
