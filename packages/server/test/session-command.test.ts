import { expect, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { CommandV2 } from "@opencode-ai/core/command"
import { AgentV2 } from "@opencode-ai/core/agent"
import { PluginBoot } from "@opencode-ai/core/plugin/boot"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { ContentStore } from "@opencode-ai/core/content-store"
import { Effect, Layer, Schema } from "effect"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { explicitCommandPrompt, loadSessionCommand } from "../src/handlers/session"

const sessionID = SessionV2.ID.make("ses_server_command")
const messageID = SessionMessage.ID.make("msg_server_command")
const location = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })

test("admits a local command without waiting for MCP command boot", async () => {
  let waitCalls = 0
  const command = new CommandV2.Info({
    name: "goal",
    template: "Work on the goal",
    source: "command",
  })
  const boot = Layer.mock(PluginBoot.Service, {
    wait: () =>
      Effect.suspend(() => {
        waitCalls += 1
        return Effect.never
      }),
    refreshMcpCommands: () => Effect.never,
  })
  const commands = Layer.mock(CommandV2.Service, {
    get: (name) => Effect.succeed(name === command.name ? command : undefined),
  })
  const locations = LocationServiceMap.of({
    bindExecution: () => Effect.void,
    get: () => Layer.mergeAll(commands, boot) as never,
    invalidate: () => Effect.void,
  })
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const content = Layer.mock(ContentStore.Service, {
    normalizePrompt: (input) => Effect.succeed(input.prompt),
  })
  const sessions = SessionV2.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
    Layer.provide(store),
    Layer.provide(Project.defaultLayer),
    Layer.provide(SessionExecution.noopLayer),
    Layer.provide(content),
  )
  const layer = Layer.mergeAll(
    database,
    events,
    SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database)),
    store,
    content,
    sessions,
  )

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* database.db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: location.directory, sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        yield* database.db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            slug: "server-command",
            directory: location.directory,
            title: "Server command",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)

        const commandInfo = yield* loadSessionCommand({ command: command.name, location }).pipe(
          Effect.provideService(LocationServiceMap, locations),
          Effect.timeout("1 second"),
        )
        expect(commandInfo).toEqual(command)
        expect(waitCalls).toBe(0)

        const session = yield* SessionV2.Service
        const admitted = yield* session.prompt({
          id: messageID,
          sessionID,
          prompt: new Prompt({ text: command.template }),
          resume: false,
        })
        expect(yield* SessionInput.find(database.db, admitted.id)).toEqual(admitted)
      }),
    ).pipe(Effect.provide(layer), Effect.timeout("2 seconds")),
  )
})

test("command API preserves explicit tool names through template expansion without activating or exposing their schemas", async () => {
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(ApplicationTools.layer),
    Layer.provide(Layer.mock(ToolOutputStore.Service, {})),
  )
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const tools = yield* ToolRegistry.Service
    yield* tools.register({ export_report: Tool.withExplicitInvocation(Tool.make({
      description: "Manual report export", input: Schema.Struct({}), output: Schema.String,
      execute: () => Effect.die("No execution during command resolution"),
    }), ["export-report", "report-preview"]) })
    const expanded = "# Report skill\n\nPrepare a preview only."
    expect(yield* explicitCommandPrompt("export-report", expanded)).toBe("/export-report\n\n" + expanded)
    expect(yield* explicitCommandPrompt("report-preview", expanded)).toBe("/report-preview\n\n" + expanded)
    expect(yield* explicitCommandPrompt("ordinary-command", expanded)).toBe(expanded)
    expect(yield* explicitCommandPrompt("export-report-extra", expanded)).toBe(expanded)
    expect((yield* tools.materialize(undefined, undefined, { sessionID, agent: AgentV2.ID.make("build"), lastUserText: "/export-report" })).definitions).toEqual([])
  })).pipe(Effect.provide(registry)))
})

test("skill commands keep a leading slash marker so downstream durable checks recognize the invocation", async () => {
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(ApplicationTools.layer),
    Layer.provide(Layer.mock(ToolOutputStore.Service, {})),
  )
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const expanded = "# Review workflow\n\nAsk the user which findings to implement before editing."
    expect(yield* explicitCommandPrompt("review-flow", expanded, "skill")).toBe("/review-flow\n\n" + expanded)
    expect(yield* explicitCommandPrompt("ordinary-command", expanded, "command")).toBe(expanded)
    expect(yield* explicitCommandPrompt("mcp-command", expanded, "mcp")).toBe(expanded)
    expect(yield* explicitCommandPrompt("export-report", expanded, "skill")).toBe("/export-report\n\n" + expanded)
    expect(yield* explicitCommandPrompt("review-flow", "/review-flow\n\n" + expanded, "skill")).toBe(
      "/review-flow\n\n" + expanded,
    )
  })).pipe(Effect.provide(registry)))
})
