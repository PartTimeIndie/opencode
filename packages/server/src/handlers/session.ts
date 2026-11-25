import { SessionV2 } from "@opencode-ai/core/session"
import type { SummaryFailed } from "@opencode-ai/core/session/compaction"
import type { MessageDecodeError } from "@opencode-ai/core/session/error"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionPlanDocument } from "@opencode-ai/core/session/plan-document"
import { Cause, Clock, DateTime, Effect, Option, Schema } from "effect"
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
import { SessionActivity } from "@opencode-ai/core/session/activity"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { BashTool } from "@opencode-ai/core/tool/bash"
import { AgentV2 } from "@opencode-ai/core/agent"
import { ModelV2 } from "@opencode-ai/core/model"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillPolicy } from "@opencode-ai/core/skill/policy"
import { Config } from "@opencode-ai/core/config"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SkillTool } from "@opencode-ai/core/tool/skill"
import { CommandV2 } from "@opencode-ai/core/command"
import { PluginBoot } from "@opencode-ai/core/plugin/boot"
import { parseSessionGoalControl, sessionGoalMetadataPatch } from "../session-goal"
import { CommandPlugin } from "../command-plugin"
import { QuestionV2 } from "@opencode-ai/core/question"
import { AgentSwitchTool } from "@opencode-ai/core/tool/agent-switch"
import { SessionSkillSelection } from "@opencode-ai/core/session/skill-selection"
import { ConfigSkillInvocation } from "@opencode-ai/core/config/skill-invocation"
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

function message(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
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

/** A chat-send click admits interactive text, not a renewal receipt. Selection
 * becomes effective only after normal promotion and the consuming gate fence. */
export const admitQuestionChatSend = Effect.fn("SessionHandler.admitQuestionChatSend")(function* (input: {
  readonly session: Pick<SessionV2.Interface, "prompt">
  readonly questions: Pick<QuestionV2.Interface, "get" | "reply">
  readonly sessionID: SessionV2.ID
  readonly requestID: string
  readonly text: string
  readonly id: string
}) {
  const request = yield* input.questions.get(QuestionV2.ID.make(input.requestID), input.sessionID)
  if (!request || request.id !== input.requestID || request.sessionID !== input.sessionID || request.mode !== "blocking" || request.questions.length !== 1)
    return yield* new InvalidRequestError({ field: "requestID", kind: "question_not_found",
      message: "No single pending blocking question matches this chat-send request." })
  const stored = request.questions[0]?.chatSend?.text
  if (!stored?.trim() || stored !== input.text)
    return yield* new InvalidRequestError({ field: "text", kind: "chat_send_mismatch",
      message: "The chat-send text does not match the stored question approval." })
  const admitted = yield* input.session.prompt({ sessionID: input.sessionID, id: SessionMessage.ID.make(input.id),
    prompt: { text: input.text }, delivery: "queue", origin: "interactive", resume: false })
  yield* input.questions.reply({ requestID: request.id, sessionID: input.sessionID, answers: [[input.text]] }).pipe(
    Effect.mapError((error) => new InvalidRequestError({ field: "requestID", kind: "question_settlement_failed",
      message: `Unable to settle the question: ${message(error)}` })),
  )
  return { admitted, selections: [] as string[] }
})

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

// Command templates (including skill bodies) replace the original slash text,
// so declared explicit-tool commands and skill commands keep a leading slash
// marker in the durable prompt. Downstream durable checks recognize the user's
// explicit selection from it (skill consent, capability activation, compaction
// command carry); the marker itself is never authority — host activation still
// requires single-use consent and admission gates still run.
export const explicitCommandPrompt = Effect.fn("SessionHandler.explicitCommandPrompt")(function* (
  command: string,
  text: string,
  source?: "command" | "mcp" | "skill",
) {
  const registry = yield* ToolRegistry.Service
  const marked = (yield* registry.hasExplicitCommand(command)) || source === "skill"
  return marked && !text.trimStart().startsWith(`/${command}`) ? `/${command}\n\n${text}` : text
})

/**
 * Skill commands are an executing entry point: resolving one would otherwise
 * inject skill content into the prompt without any policy check. Command
 * selection is authentic explicit user intent, so it satisfies `manual` and
 * `ask` invocation consent — but never `deny` or configured permission deny
 * rules, and never unreadable skill policy configuration (fail closed).
 */
export const admitSkillCommand = Effect.fn("SessionHandler.admitSkillCommand")(function* (input: {
  readonly skill: string
  readonly sessionID: SessionV2.ID
  readonly location: SessionV2.Info["location"]
  readonly agent: string | undefined
}) {
  const locations = yield* LocationServiceMap
  return yield* Effect.gen(function* () {
    const skills = yield* SkillV2.Service.use((service) => service.list())
    const skill = skills.find((item) => item.name === input.skill)
    // A stale registration must not bypass policy before a command is expanded.
    if (!skill) return yield* new InvalidRequestError({
      message: `Skill not found: ${input.skill}`, field: "skill", kind: "skill_not_found",
    })
    const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
    const entries = config ? yield* config.entries() : []
    const invocation = Config.globalLatest(entries, "skill_invocation")
    const issues = config?.issues ? yield* config.issues() : []
    if (issues.length > 0)
      return yield* Effect.fail(
        new InvalidRequestError({
          message: `Skill "${input.skill}" is blocked: skill policy configuration is unreadable (${issues[0]!.path}: ${issues[0]!.message})`,
          field: "command",
          kind: "skill_policy_unreadable",
        }),
      )
    const agentID = input.agent ? AgentV2.ID.make(input.agent) : undefined
    const agent = agentID ? yield* AgentV2.Service.use((agents) => agents.get(agentID)) : undefined
    const policy = SkillPolicy.resolveForSkill({ skill, global: invocation, agentSkills: agent?.skills })
    const gate = SkillPolicy.admissionGate(policy, { explicitlySelected: true })
    if (gate === "deny")
      return yield* Effect.fail(
        new InvalidRequestError({
          message: `Skill "${input.skill}" is blocked by configuration (invocation: deny)`,
          field: "command",
          kind: "skill_denied",
        }),
      )
    yield* PermissionV2.Service.use((permission) => permission.assert({
      action: "skill", resources: [input.skill], save: [input.skill], sessionID: input.sessionID, agent: agentID,
    })).pipe(Effect.mapError(() => new InvalidRequestError({
      message: `Skill "${input.skill}" is denied by permission rules`, field: "command", kind: "skill_denied",
    })))
    // This is preflight, not input admission. The marked interactive command
    // prompt establishes selection only after durable admission and promotion;
    // never mint an unbound receipt before that input exists.
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
    const database = yield* Database.Service
    const db = database.db

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
      if (!taskModel) {
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
          prompt: {
            text: input.prompt,
            ...(input.files === undefined ? {} : { files: input.files }),
            ...(taskModel === undefined ? {} : {
              subtask: {
                command: input.commandName,
                description: input.command.description ?? input.commandName,
                agent: taskAgent,
                model: taskModel,
              },
            }),
          },
          agent: input.agent,
          model: input.model,
          delivery: input.delivery,
          origin: "interactive",
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

      // The coordinator owns command execution, its activity lease and cancellation.
      // HTTP only admits durable work; it must never borrow or fabricate a runner owner.
      yield* execution.wake(input.sessionID, admitted.admittedSeq).pipe(Effect.ignore)
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
              // The HTTP prompt endpoint is the human composer's admission path.
              origin: "interactive",
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
          if (command.source === "skill") {
            yield* admitSkillCommand({
              skill: ctx.payload.command, sessionID: ctx.params.sessionID, location: info.location,
              agent: command.agent ?? ctx.payload.agent ?? info.agent,
            })
          }
          const resolved = yield* CommandV2.Service.use((commands) =>
            commands.resolve({ name: ctx.payload.command, arguments: ctx.payload.arguments ?? "" }),
          ).pipe(Effect.provide(locations.get(info.location)))
          if (command.source === "skill") {
            const commands = Array.from((resolved ?? "").matchAll(shellRegex), (match) => match[1]).filter((value): value is string => !!value)
            if (commands.length) yield* PermissionV2.Service.use((permission) => permission.assert({
              action: "bash", resources: commands, sessionID: ctx.params.sessionID,
              agent: command.agent ? AgentV2.ID.make(command.agent) : ctx.payload.agent ? AgentV2.ID.make(ctx.payload.agent) : info.agent ? AgentV2.ID.make(info.agent) : undefined,
            })).pipe(
              Effect.provide(locations.get(info.location)),
              Effect.mapError(() => new InvalidRequestError({ message: "Skill shell expansion denied", field: "command", kind: "skill_denied" })),
            )
          }
          const expanded = yield* expandCommandShell({
            template: resolved ?? "",
            directory: info.location.directory,
          }).pipe(Effect.provide(locations.get(info.location)))
          const transformed = yield* commandPlugin.transform({
            command: ctx.payload.command,
            sessionID: ctx.params.sessionID,
            arguments: ctx.payload.arguments ?? "",
            text: expanded,
          })
          const prompt = yield* explicitCommandPrompt(ctx.payload.command, transformed, command.source).pipe(
            Effect.provide(locations.get(info.location)),
          )
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
            if (goalPatch) return yield* new InvalidRequestError({ field: "command", kind: "invalid_command", message: "Goal controls require ordinary command admission" })
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
              origin: "interactive",
              resume: ctx.payload.resume,
              ...(goalPatch ? { metadataPatchOnAdmission: goalPatch } : {}),
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
          yield* admitSkillCommand({
            skill: ctx.payload.skill, sessionID: ctx.params.sessionID, location: info.location, agent: info.agent,
          })
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
        "session.skillSelections",
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
          const scoped = Effect.gen(function* () {
            const skills = yield* SkillV2.Service.use((service) => service.list())
            const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
            const invocation = config ? yield* config.entries() : []
            const memory = ConfigSkillInvocation.resolveSelectionMemory(Config.globalLatest(invocation, "skill_invocation"))
            return yield* SessionSkillSelection.inspect(database.db, { sessionID: ctx.params.sessionID,
              limits: { minutes: memory.minutes, messages: memory.messages }, now: Date.now(),
              names: skills.map((skill) => skill.name), enabled: memory.enabled })
          }).pipe(Effect.provide(locations.get(info.location)))
          return { data: yield* scoped }
        }),
      )
      .handle(
        "session.skillSelectionForget",
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
          const forgetAll = ctx.payload.all === true && ctx.payload.name === undefined
          if ((ctx.payload.all === true) === (ctx.payload.name !== undefined) || ctx.payload.name?.trim() === "")
            return yield* new InvalidRequestError({
              field: "name",
              kind: "invalid_forget_target",
              message: "Provide exactly one skill name or all: true.",
            })
          const scoped = Effect.gen(function* () {
            const result = yield* SessionSkillSelection.forget(database.db, events, {
              sessionID: ctx.params.sessionID,
              ...(forgetAll ? {} : { name: ctx.payload.name }),
              expectedRevision: ctx.payload.expectedRevision,
              operationID: ctx.payload.operationID,
            })
            return {
              revision: result.revision,
              outcome: result._tag === "Forgotten" ? ("forgotten" as const) : (result._tag === "RevisionConflict" ? "revision_conflict" as const : "duplicate_operation" as const),
            }
          }).pipe(Effect.provide(locations.get(info.location)))
          return { data: yield* scoped }
        }),
      )
      .handle(
        "session.chatSend",
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
          const scoped = Effect.gen(function* () {
            const questions = yield* QuestionV2.Service
            return yield* admitQuestionChatSend({ session, questions, sessionID: ctx.params.sessionID, ...ctx.payload })
          }).pipe(Effect.provide(locations.get(info.location)))
          const outcome = yield* scoped.pipe(
            Effect.catchTag("Session.PromptConflictError", (error) =>
              Effect.fail(
                new ConflictError({
                  message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                  resource: error.messageID,
                }),
              ),
            ),
            Effect.catchTag("Session.NotFoundError", (error) => Effect.fail(new SessionNotFoundError({ sessionID: error.sessionID, message: error.message }))),
            Effect.catchTag("SessionBusyError", (error) => Effect.fail(new ConflictError({ message: `Session is busy: ${error.sessionID}`, resource: error.sessionID }))),
            Effect.catchTag("Session.RollbackBlockedError", (error) => Effect.fail(new ConflictError({ message: "Rollback is blocked; resolve the file conflict before sending.", resource: error.sessionID }))),
            Effect.catchTag("ContentStore.StorageError", (error) => Effect.fail(new InvalidRequestError({ field: "prompt", kind: "storage_unavailable", message: `Unable to admit chat-send prompt: ${error.operation}` }))),
          )
          return { data: outcome }
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
          const input = ctx.query.messageID ? yield* SessionInput.find(db, ctx.query.messageID) : undefined
          const boundCompletion = latest?.turnCompletionResult && input?.sessionID === ctx.params.sessionID &&
            input.promotedSeq !== undefined && latest.openedSeq !== undefined && latest.closedSeq !== undefined &&
            input.promotedSeq >= latest.openedSeq && input.promotedSeq <= latest.closedSeq
            ? latest.turnCompletionResult : undefined
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
                      ...(boundCompletion ? { turnCompletionResult: boundCompletion } : {}),
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
