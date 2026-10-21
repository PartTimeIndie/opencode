export * as SpawnAgentTool from "./spawn-agent"

import { ToolFailure } from "@opencode-ai/llm"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { BackgroundJob } from "../background-job"
import { AgentV2 } from "../agent"
import { ContentStore } from "../content-store"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { PermissionV2 } from "../permission"
import { ProjectV2 } from "../project"
import { SessionV2, admitPrompt, createSession, type CreateInput, type PromptInput } from "../session"
import { SessionMessage } from "../session/message"
import { Prompt } from "../session/prompt"
import { SessionRunner } from "../session/runner"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { SessionAgentPolicy } from "../session/agent-policy"
import { SessionTable } from "../session/sql"
import { PermissionV1 } from "../v1/permission"
import { Tool } from "./tool"
import { ModelPolicy } from "./model-policy"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"

export const name = "spawn_agent"
export const metadataKey = "opencode_spawn_agent"

export const Input = Schema.Struct({
  prompt: Schema.String.annotate({ description: "Prompt text to run in the spawned normal OpenCode session" }),
  title: Schema.String.pipe(Schema.optional).annotate({ description: "Optional title for the spawned session" }),
  model: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Optional model override. Only models configured on the spawning session, its agent, or its Settings model chain are accepted (provider/model format; a bare model id resolves when unambiguous). Unconfigured models are rejected with the allowed list. Defaults to the current model of the spawning session",
  }),
  variant: Schema.String.pipe(Schema.optional).annotate({
    description: "Optional model variant or thinking amount when model is provided",
  }),
})

export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  state: Schema.Literal("running"),
  text: Schema.String,
})

type SessionOps = {
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info, unknown>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, unknown>
  readonly message: (
    sessionID: SessionSchema.ID,
    messageID: SessionMessage.ID,
  ) => Effect.Effect<SessionMessage.Message | undefined, unknown>
  readonly permission: (sessionID: SessionSchema.ID) => Effect.Effect<PermissionV1.Ruleset | undefined, unknown>
  readonly prompt: (input: PromptInput) => Effect.Effect<unknown, unknown>
  readonly run: (sessionID: SessionSchema.ID) => Effect.Effect<void, unknown>
}

const layerWith = <R>(sessionOps: Effect.Effect<SessionOps, never, R>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const tools = yield* Tools.Service
      const permission = yield* PermissionV2.Service
      const agents = yield* AgentV2.Service
      const registry = yield* ToolRegistry.Service
      const background = yield* BackgroundJob.Service
      const sessions = yield* sessionOps

      yield* tools
        .register({
          [name]: Tool.withCapabilities(
            Tool.make({
              description:
                "Start a prompt in a new normal OpenCode session. The new session opens in the app as a visible background tab while the current session remains focused. Only available while the spawn-new-agent skill capability is active; never call this on your own initiative.",
              input: Input,
              output: Output,
              toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
              execute: (input, context) =>
                Effect.gen(function* () {
                  const prompt = input.prompt.trim()
                  if (!prompt) return yield* new ToolFailure({ message: "spawn_agent requires a non-empty prompt" })

                  yield* permission
                    // Creating a new visible normal session is its own
                    // authorization: every spawn needs a fresh host click,
                    // even under full access or a remembered rule.
                    .assert(PermissionV2.singleUse({
                      action: name,
                      resources: ["*"],
                      sessionID: context.sessionID,
                      agent: context.agent,
                      metadata: { prompt },
                      source: {
                        type: "tool",
                        messageID: context.assistantMessageID,
                        callID: context.toolCallID,
                      },
                    }))
                    .pipe(Effect.mapError(() => new ToolFailure({ message: "Permission denied: spawn_agent" })))

                  const parent = yield* sessions
                    .get(context.sessionID)
                    .pipe(
                      Effect.mapError(() => new ToolFailure({ message: `Session not found: ${context.sessionID}` })),
                    )
                  const message = yield* sessions
                    .message(context.sessionID, context.assistantMessageID)
                    .pipe(
                      Effect.mapError(
                        () => new ToolFailure({ message: "Unable to read the current assistant message" }),
                      ),
                    )
                  if (!message || message.type !== "assistant")
                    return yield* new ToolFailure({ message: "spawn_agent must be called from an assistant message" })

                  const inheritedPermission = yield* sessions
                    .permission(context.sessionID)
                    .pipe(
                      Effect.mapError(() => new ToolFailure({ message: "Unable to read current session permissions" })),
                    )
                  const parentAgent = yield* agents
                    .get(context.agent)
                    .pipe(
                      Effect.flatMap((agent) =>
                        agent
                          ? Effect.succeed(agent)
                          : Effect.fail(new ToolFailure({ message: `Parent agent not found: ${context.agent}` })),
                      ),
                    )
                  const parentDelegableTools = yield* registry.materialize(
                    yield* permission
                      .materializationRules({ sessionID: parent.id, agent: parentAgent.id })
                      .pipe(
                        Effect.mapError(
                          () => new ToolFailure({ message: "Unable to resolve current agent permissions" }),
                        ),
                      ),
                    SessionAgentPolicy.delegable(parent.agentPolicy?.tools ?? parentAgent.tools),
                  )
                  const title = input.title?.trim()
                  const modelSelection = ModelPolicy.selectModel({
                    model: input.model,
                    variant: input.variant,
                    agent: parentAgent.model,
                    parent: parent.model ?? message.model,
                    inherit: parent.model ?? message.model,
                  })
                  if (!modelSelection.ok)
                    return yield* new ToolFailure({ message: ModelPolicy.rejectionMessage(modelSelection) })
                  const model = modelSelection.model
                  const metadata = {
                    ...(parent.metadata?.access_control === undefined
                      ? {}
                      : { access_control: parent.metadata.access_control }),
                    [metadataKey]: {
                      sourceSessionID: context.sessionID,
                      sourceMessageID: context.assistantMessageID,
                    },
                  }
                  const child = yield* sessions
                    .create({
                      ...(title ? { title } : {}),
                      agent: context.agent,
                      ...(model === undefined ? {} : { model }),
                      metadata,
                      ...(inheritedPermission ? { permission: inheritedPermission } : {}),
                      agentPolicy: SessionAgentPolicy.derive({
                        parent: parent.agentPolicy,
                        parentSessionID: parent.id,
                        parentAgent,
                        parentDelegableTools: parentDelegableTools.definitions.map((tool) => tool.name),
                        childTools: parentDelegableTools.definitions.map((tool) => tool.name),
                        type: "spawn_agent",
                      }),
                      location: parent.location,
                    })
                    .pipe(
                      Effect.mapError(
                        (error) => new ToolFailure({ message: `Unable to create spawned session: ${String(error)}` }),
                      ),
                    )

                  yield* background.start({
                    id: child.id,
                    type: name,
                    title: title || "Spawned agent",
                    metadata: {
                      background: true,
                      sourceSessionID: context.sessionID,
                      sessionID: child.id,
                      ...(model === undefined ? {} : { model }),
                    },
                    run: sessions
                      .prompt({
                        sessionID: child.id,
                        prompt: new Prompt({ text: prompt }),
                        agent: context.agent,
                        ...(model === undefined ? {} : { model }),
                        resume: false,
                      })
                      .pipe(
                        Effect.flatMap(() => sessions.run(child.id)),
                        Effect.as(`Spawned session ${child.id} completed.`),
                      ),
                  })

                  return {
                    sessionID: child.id,
                    state: "running" as const,
                    text: `Started prompt in new normal session ${child.id}.`,
                  }
                }),
            }),
            ["spawn_agent"],
          ),
        })
        .pipe(Effect.orDie)
    }),
  )

export const layer = layerWith(
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    return {
      create: sessions.create,
      get: sessions.get,
      message: (sessionID, messageID) => sessions.message({ sessionID, messageID }),
      permission: () => Effect.succeed(undefined),
      prompt: sessions.prompt,
      run: sessions.resume,
    }
  }),
)

export const locationLayer = layerWith(
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const store = yield* SessionStore.Service
    const content = yield* ContentStore.Service
    const runner = yield* SessionRunner.Service

    const get = Effect.fn("SpawnAgentTool.location.get")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* new SessionV2.NotFoundError({ sessionID })
      return session
    })

    return {
      create: (input) => createSession({ db, events, projects, store }, input),
      get,
      message: (sessionID, messageID) =>
        store
          .message(messageID)
          .pipe(Effect.map((entry) => (entry?.sessionID === sessionID ? entry.message : undefined))),
      permission: (sessionID) =>
        db
          .select({ permission: SessionTable.permission })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) => row?.permission ?? undefined),
          ),
      prompt: (input) => admitPrompt({ db, events, store, content }, input),
      run: (sessionID) => runner.run({ sessionID, force: true }),
    }
  }),
)
