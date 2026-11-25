import { expect, test } from "bun:test"
import path from "node:path"
import { DateTime, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PluginBoot } from "@opencode-ai/core/plugin/boot"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionMessageTable, SessionSkillSelectionTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillTool } from "@opencode-ai/core/tool/skill"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { executeTool, toolIdentity } from "./lib/tool"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"

type Scenario = {
  text: string
  mode?: "manual" | "ask" | "allow" | "deny"
  origin?: SessionInput.Origin
  memory?: boolean
  future?: boolean
  denyPermission?: boolean
}

const run = async (scenario: Scenario) => {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const dependencies = Layer.mergeAll(database, events)
  const projector = SessionProjector.layer.pipe(Layer.provide(dependencies))
  const assertions: PermissionV2.AssertInput[] = []
  const permission = Layer.mock(PermissionV2.Service, {
    assert: (input) => Effect.gen(function* () {
      assertions.push(input)
      if (scenario.denyPermission) return yield* new PermissionV2.DeniedError({ rules: [] })
    }),
  })
  const skill = new SkillV2.Info({
    name: "review-flow", aliases: ["review-alias"], disableModelInvocation: true,
    description: "Fixture workflow", content: "Fixture guidance",
    location: AbsolutePath.make(path.resolve("fixture-skill.md")),
  })
  const config = Layer.mock(Config.Service, {
    issues: () => Effect.succeed([]),
    entries: () => Effect.succeed([new Config.Document({ type: "document", info: new Config.Info({
      skill_invocation: {
        entries: { [skill.name]: { visible: false, invocation: scenario.mode ?? "manual" } },
        selection_memory: { enabled: scenario.memory ?? true, minutes: 15, messages: 15 },
      },
    }) })]),
  })
  const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
  const services = Layer.mergeAll(dependencies, projector, registry, permission, config,
    FSUtil.defaultLayer,
    Layer.mock(PluginBoot.Service, { wait: () => Effect.void }),
    Layer.mock(AgentV2.Service, { get: () => Effect.succeed(new AgentV2.Info(AgentV2.Info.empty(toolIdentity.agent))) }),
    Layer.mock(SkillV2.Service, { list: () => Effect.succeed([skill]) }),
  )
  const layer = Layer.mergeAll(services, SkillTool.layer.pipe(Layer.provide(services)))
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const eventService = yield* EventV2.Service
    const sessionID = SessionV2.ID.make("ses_projected_skill")
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make(path.resolve("fixture")), sandboxes: [] }).run()
    yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: path.resolve("fixture"), slug: "skills", title: "Skills", version: "test" }).run()
    const start = () => eventService.publish(SessionEvent.Step.Started, {
      sessionID, timestamp: DateTime.makeUnsafe(Date.now()), assistantMessageID: toolIdentity.assistantMessageID,
      agent: toolIdentity.agent, model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "fixture", providerID: "fixture" }),
    })
    if (scenario.future) yield* start()
    const admitted = yield* SessionInput.admit(db, eventService, {
      id: SessionMessage.ID.make("msg_projected_selection"), sessionID,
      prompt: new Prompt({ text: scenario.text }), delivery: "steer",
      ...(scenario.origin === undefined ? {} : { origin: scenario.origin }),
    })
    expect(yield* SessionInput.promoteSteers(db, eventService, sessionID, admitted.admittedSeq)).toBe(1)
    if (!scenario.future) yield* start()
    const rows = yield* db.select().from(SessionMessageTable).all()
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.data).not.toHaveProperty("id")
      expect(row.data).not.toHaveProperty("type")
    }
    const result = yield* executeTool(yield* ToolRegistry.Service, {
      sessionID, ...toolIdentity,
      call: { type: "tool-call", id: "call-projected-skill", name: "skill", input: { name: skill.name } },
    })
    const selections = yield* db.select().from(SessionSkillSelectionTable).all()
    return { result, assertions, selections, output: SkillTool.toModelOutput(skill, []) }
  }).pipe(Effect.provide(layer), Effect.runPromise)
}

for (const memory of [true, false]) {
  for (const text of ["/review-flow", "Please use /review-flow now", "Please check\n\n/other\n\n/review-flow\n\n/third", "Please check\n/review-alias"]) {
    test(`registered skill loads projected interactive input (memory=${memory}): ${JSON.stringify(text)}`, async () => {
      const result = await run({ text, origin: "interactive", memory })
      expect(result.result).toEqual({ type: "text", value: result.output })
      expect(result.assertions.at(-1)?.extraRules).toBeUndefined()
      expect(result.selections).toHaveLength(memory ? 1 : 0)
    })
  }
}

for (const scenario of [
  { text: "/review-flow", origin: "plugin" },
  { text: "/review-flow" },
  { text: "/review-flow", origin: "interactive", future: true },
  { text: "/review-flow-extra", origin: "interactive" },
  { text: "/review-alias-extra", origin: "interactive" },
] satisfies Scenario[]) {
  test(`manual rejects unselected projected input: ${JSON.stringify(scenario)}`, async () => {
    const result = await run(scenario)
    expect(result.result).toEqual({ type: "error", value: "Skill review-flow requires an explicit /review-flow invocation" })
    expect(result.assertions).toHaveLength(0)
    expect(result.selections).toHaveLength(0)
  })
}

for (const text of ["Check this", "Please /review-flow now"]) {
  test(`ask preserves selection consent through projection: ${text}`, async () => {
    const result = await run({ text, origin: "interactive", mode: "ask" })
    expect(result.result).toEqual({ type: "text", value: result.output })
    expect(result.assertions.at(-1)?.extraRules).toEqual(text === "Check this"
      ? [{ action: "skill", resource: "review-flow", effect: "ask" }]
      : undefined)
  })
}

test("hidden allow loads without selection, while deny and tool permissions still block explicit selection", async () => {
  const allowed = await run({ text: "Check this", mode: "allow" })
  expect(allowed.result).toEqual({ type: "text", value: allowed.output })
  expect(allowed.assertions.at(-1)?.extraRules).toBeUndefined()
  const denied = await run({ text: "/review-flow", origin: "interactive", mode: "deny" })
  expect(denied.result).toEqual({ type: "error", value: "Skill review-flow is blocked by configuration (invocation: deny)" })
  expect(denied.assertions).toHaveLength(0)
  const permissionDenied = await run({ text: "/review-flow", origin: "interactive", denyPermission: true })
  expect(permissionDenied.result).toEqual({ type: "error", value: "Unable to load skill review-flow" })
})
