import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { CommandV2 } from "@opencode-ai/core/command"
import { Config } from "@opencode-ai/core/config"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SkillV2 } from "@opencode-ai/core/skill"
import { PluginBoot } from "@opencode-ai/core/plugin/boot"
import { admitSkillCommand } from "../src/handlers/session"
import { InvalidRequestError } from "../src/errors"

const sessionID = SessionV2.ID.make("ses_skill_admission")
const messageID = SessionMessage.ID.make("msg_skill_admission_anchor")
const location = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })

const skill = (name: string, extra: Partial<SkillV2.Info> = {}): SkillV2.Info => ({
  name,
  description: `Guidance for ${name}`,
  location: AbsolutePath.make(`${name}/SKILL.md`.replace(/\\/g, "/")),
  content: `Instructions for ${name}`,
  ...extra,
})

const document = (skill_invocation: unknown) =>
  new Config.Document({ type: "document", info: new Config.Info({ skill_invocation: skill_invocation as never }) })

const permission = (rules: PermissionV2.Ruleset) =>
  Layer.succeed(
    PermissionV2.Service,
    PermissionV2.Service.of({
      assert: (input) => PermissionV2.evaluate(input.action, input.resources[0]!, rules).effect === "deny"
        ? Effect.fail(new PermissionV2.DeniedError({ rules })) : Effect.void,
      ask: () => Effect.die("unused"),
      reply: () => Effect.die("unused"),
      materializationRules: () => Effect.succeed(rules),
      get: () => Effect.die("unused"),
      forSession: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
    }),
  )

const agentLayer = (agent: AgentV2.Info | undefined) =>
  Layer.succeed(
    AgentV2.Service,
    AgentV2.Service.of({
      get: (id: AgentV2.ID) => Effect.succeed(agent && agent.id === id ? agent : undefined),
      all: () => Effect.succeed(agent ? [agent] : []),
    } as never),
  )

const boot = Layer.succeed(
  PluginBoot.Service,
  PluginBoot.Service.of({ wait: () => Effect.void, refreshMcpCommands: () => Effect.void }),
)

const commandService = (names: string[]) =>
  Layer.succeed(
    CommandV2.Service,
    CommandV2.Service.of({
      get: (name: string) => Effect.succeed(names.includes(name) ? ({ name, template: "", source: "skill" } as never) : undefined),
      list: () => Effect.succeed([]),
    } as never),
  )

const run = (serviceLayer: Layer.Layer<never>) => (skill: string, agent?: string) =>
  Effect.runPromise(
    admitSkillCommand({ skill, sessionID, location, agent }).pipe(
      Effect.provide(
        Layer.succeed(
          LocationServiceMap,
          LocationServiceMap.of({
            bindExecution: () => Effect.void,
            get: () => serviceLayer as never,
            invalidate: () => Effect.void,
          }),
        ),
      ),
    ) as Effect.Effect<void>,
  )

test("deny blocks skill commands even with explicit selection and no permission prompt", async () => {
  const config = Layer.succeed(
    Config.Service,
    Config.Service.of({ entries: () => Effect.succeed([document({ entries: { locked: { invocation: "deny" } } })]) }),
  )
  const skills = Layer.succeed(
    SkillV2.Service,
    SkillV2.Service.of({
      list: () => Effect.succeed([skill("locked")]),
      transform: () => Effect.die("unused"),
      sources: () => Effect.die("unused"),
    }),
  )
  const admit = run(Layer.mergeAll(config, skills, permission([]), agentLayer(undefined), boot, commandService(["locked"])))
  const error = await admit("locked", "build").then(
    () => null,
    (error) => error,
  )
  expect(error).toBeInstanceOf(InvalidRequestError)
  expect((error as InvalidRequestError).kind).toBe("skill_denied")
  expect((error as InvalidRequestError).message).toContain("invocation: deny")
})

test("manual and ask commands pass because command selection is explicit user intent", async () => {
  const config = Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () => Effect.succeed([document({ entries: { gated: { invocation: "manual" }, asked: { invocation: "ask" } } })]),
    }),
  )
  const skills = Layer.succeed(
    SkillV2.Service,
    SkillV2.Service.of({
      list: () => Effect.succeed([skill("gated"), skill("asked")]),
      transform: () => Effect.die("unused"),
      sources: () => Effect.die("unused"),
    }),
  )
  const admit = run(Layer.mergeAll(config, skills, permission([]), agentLayer(undefined), boot, commandService(["gated"])))
  await expect(admit("gated", "build")).resolves.toBeUndefined()
  await expect(admit("asked", "build")).resolves.toBeUndefined()
  // Stale skill registrations fail closed before command expansion.
  await expect(admit("vanished", "build")).rejects.toBeInstanceOf(InvalidRequestError)
})

test("configured permission deny rules block commands even when invocation policy allows", async () => {
  const config = Layer.succeed(
    Config.Service,
    Config.Service.of({ entries: () => Effect.succeed([document({})]) }),
  )
  const skills = Layer.succeed(
    SkillV2.Service,
    SkillV2.Service.of({
      list: () => Effect.succeed([skill("open")]),
      transform: () => Effect.die("unused"),
      sources: () => Effect.die("unused"),
    }),
  )
  const rules: PermissionV2.Ruleset = [{ action: "skill", resource: "open", effect: "deny" }]
  const admit = run(Layer.mergeAll(config, skills, permission(rules), agentLayer(undefined), boot, commandService(["open"])))
  const error = await admit("open").then(
    () => null,
    (error) => error,
  )
  expect(error).toBeInstanceOf(InvalidRequestError)
  expect((error as InvalidRequestError).message).toContain("denied by permission rules")
})

test("unreadable skill policy configuration fails closed with a diagnosis", async () => {
  const config = Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () => Effect.succeed([document({})]),
      issues: () => Effect.succeed([{ path: "opencode.json", message: "invalid JSON/JSONC syntax" }]),
    }),
  )
  const skills = Layer.succeed(
    SkillV2.Service,
    SkillV2.Service.of({
      list: () => Effect.succeed([skill("open")]),
      transform: () => Effect.die("unused"),
      sources: () => Effect.die("unused"),
    }),
  )
  const admit = run(Layer.mergeAll(config, skills, permission([]), agentLayer(undefined), boot, commandService(["open"])))
  const error = await admit("open").then(
    () => null,
    (error) => error,
  )
  expect(error).toBeInstanceOf(InvalidRequestError)
  expect((error as InvalidRequestError).kind).toBe("skill_policy_unreadable")
  expect((error as InvalidRequestError).message).toContain("opencode.json")
})

test("per-agent overrides replace the global mode for the session agent", async () => {
  const config = Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () => Effect.succeed([document({ entries: { asked: { invocation: "deny" } } })]),
    }),
  )
  const skills = Layer.succeed(
    SkillV2.Service,
    SkillV2.Service.of({
      list: () => Effect.succeed([skill("asked")]),
      transform: () => Effect.die("unused"),
      sources: () => Effect.die("unused"),
    }),
  )
  const agent = new AgentV2.Info({
    ...AgentV2.Info.empty(AgentV2.ID.make("reviewer")),
    skills: { asked: { invocation: "allow" } },
  })
  const admit = run(Layer.mergeAll(config, skills, permission([]), agentLayer(agent), boot, commandService(["asked"])))
  await expect(admit("asked", "reviewer")).resolves.toBeUndefined()
  // The default agent without the override stays blocked by the global deny.
  const error = await admit("asked", "build").then(
    () => null,
    (error) => error,
  )
  expect(error).toBeInstanceOf(InvalidRequestError)
})
