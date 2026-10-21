import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { PluginBoot } from "@opencode-ai/core/plugin/boot"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { it } from "../lib/effect"

const build = AgentV2.ID.make("build")
const effect = new SkillV2.Info({
  name: "effect",
  description: "Build applications with Effect",
  location: AbsolutePath.make(path.resolve("/skills/effect/SKILL.md")),
  content: "Effect guidance",
})
const hidden = new SkillV2.Info({
  name: "hidden",
  location: AbsolutePath.make(path.resolve("/skills/hidden/SKILL.md")),
  content: "Undescribed guidance",
})
const denied = new SkillV2.Info({
  name: "denied",
  description: "Must not be advertised",
  location: AbsolutePath.make(path.resolve("/skills/denied/SKILL.md")),
  content: "Denied guidance",
})
const surface = new SkillV2.Info({
  name: "on-demand-ui",
  description: "Build native OpenCode UIs",
  requiredTools: ["surface"],
  location: AbsolutePath.make(path.resolve("/skills/on-demand-ui/SKILL.md")),
  content: "Use surface",
})

const layer = (list: () => SkillV2.Info[], wait: () => void = () => {}) =>
  SkillGuidance.layer.pipe(
    Layer.provide(Layer.mock(SkillV2.Service, { list: () => Effect.succeed(list()) })),
    Layer.provide(Layer.mock(PluginBoot.Service, { wait: () => Effect.sync(wait) })),
  )

describe("SkillGuidance", () => {
  it.effect("removes manual-only names and descriptions from baseline and context updates", () => {
    const agent = new AgentV2.Info(AgentV2.Info.empty(build))
    let skills = [effect]
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      const selection = { id: agent.id, info: agent }
      const first = yield* guidance.load(selection).pipe(Effect.flatMap(SystemContext.initialize))
      expect(first.baseline).toContain("<name>effect</name>")
      skills = [new SkillV2.Info({ ...effect, disableModelInvocation: true })]
      const context = yield* guidance.load(selection)
      const manual = yield* SystemContext.initialize(context)
      expect(manual.baseline).not.toContain("<name>effect</name>")
      expect(manual.baseline).not.toContain(effect.description!)
      expect(yield* SystemContext.reconcile(context, first.snapshot)).toMatchObject({
        _tag: "Updated",
        text: expect.stringContaining("No skills are currently available."),
      })
      skills = [new SkillV2.Info({ ...effect, disableModelInvocation: false })]
      expect((yield* guidance.load(selection).pipe(Effect.flatMap(SystemContext.initialize))).baseline).toContain(
        "<name>effect</name>",
      )
    }).pipe(Effect.provide(layer(() => skills)))
  })

  it.effect("renders described agent skills and reconciles the complete available list", () => {
    const agent = new AgentV2.Info({
      ...AgentV2.Info.empty(build),
      permissions: [{ action: "skill", resource: "denied", effect: "deny" }],
    })
    let skills = [hidden, denied, effect]
    let waited = 0
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      const initialized = yield* guidance
        .load({ id: agent.id, info: agent })
        .pipe(Effect.flatMap(SystemContext.initialize))

      expect(waited).toBe(1)
      expect(initialized.baseline).toBe(
        [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          "<available_skills>",
          "  <skill>",
          "    <name>effect</name>",
          "    <description>Build applications with Effect</description>",
          "  </skill>",
          "</available_skills>",
        ].join("\n"),
      )

      skills = []
      expect(
        yield* guidance
          .load({ id: agent.id, info: agent })
          .pipe(Effect.flatMap((context) => SystemContext.reconcile(context, initialized.snapshot))),
      ).toMatchObject({
        _tag: "Updated",
        text: expect.stringContaining("No skills are currently available."),
      })
    }).pipe(
      Effect.provide(
        layer(
          () => skills,
          () => waited++,
        ),
      ),
    )
  })

  it.effect("omits guidance when the selected agent denies all skills", () => {
    const agent = new AgentV2.Info({
      ...AgentV2.Info.empty(build),
      permissions: [{ action: "skill", resource: "*", effect: "deny" }],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(
        yield* guidance.load({ id: agent.id, info: agent }).pipe(Effect.flatMap(SystemContext.initialize)),
      ).toEqual({
        baseline: "",
        snapshot: {},
      })
    }).pipe(Effect.provide(layer(() => [effect])))
  })

  it.effect("filters guidance through the effective session tool policy", () => {
    const agent = new AgentV2.Info(AgentV2.Info.empty(build))
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      const restricted = yield* guidance
        .load({ id: agent.id, info: agent }, { mode: "explicit", entries: {} })
        .pipe(Effect.flatMap(SystemContext.initialize))
      const allowed = yield* guidance
        .load(
          { id: agent.id, info: agent },
          { mode: "explicit", entries: { surface: { visible: true, permission: "allow" } } },
        )
        .pipe(Effect.flatMap(SystemContext.initialize))

      expect(restricted.baseline).toContain("No skills are currently available.")
      expect(allowed.baseline).toContain("<name>on-demand-ui</name>")
    }).pipe(Effect.provide(layer(() => [surface])))
  })

  it.effect("omits guidance when a resource-specific denial follows the global denial", () => {
    const agent = new AgentV2.Info({
      ...AgentV2.Info.empty(build),
      permissions: [
        { action: "skill", resource: "*", effect: "deny" },
        { action: "skill", resource: "hidden", effect: "deny" },
      ],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(
        yield* guidance.load({ id: agent.id, info: agent }).pipe(Effect.flatMap(SystemContext.initialize)),
      ).toEqual({
        baseline: "",
        snapshot: {},
      })
    }).pipe(Effect.provide(layer(() => [effect])))
  })

  it.effect("retains specifically allowed skills after a global denial", () => {
    const agent = new AgentV2.Info({
      ...AgentV2.Info.empty(build),
      permissions: [
        { action: "skill", resource: "*", effect: "deny" },
        { action: "skill", resource: "effect", effect: "allow" },
      ],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(
        (yield* guidance.load({ id: agent.id, info: agent }).pipe(Effect.flatMap(SystemContext.initialize))).baseline,
      ).toContain("<name>effect</name>")
    }).pipe(Effect.provide(layer(() => [effect])))
  })

  it.effect("omits guidance when a specifically allowed skill is denied again", () => {
    const agent = new AgentV2.Info({
      ...AgentV2.Info.empty(build),
      permissions: [
        { action: "skill", resource: "*", effect: "deny" },
        { action: "skill", resource: "effect", effect: "allow" },
        { action: "skill", resource: "effect", effect: "deny" },
      ],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(
        yield* guidance.load({ id: agent.id, info: agent }).pipe(Effect.flatMap(SystemContext.initialize)),
      ).toEqual({
        baseline: "",
        snapshot: {},
      })
    }).pipe(Effect.provide(layer(() => [effect])))
  })

  it.effect("reuses unchanged guidance and invalidates when the available skills change", () => {
    const agent = new AgentV2.Info(AgentV2.Info.empty(build))
    let skills = [effect]
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      const selection = { id: agent.id, info: agent }
      const first = yield* guidance.load(selection)
      expect(yield* guidance.load(selection)).toBe(first)
      const generation = yield* SystemContext.initialize(first)

      skills = []
      const updated = yield* guidance.load(selection)
      expect(updated).not.toBe(first)
      expect(yield* SystemContext.reconcile(updated, generation.snapshot)).toMatchObject({
        _tag: "Updated",
        text: expect.stringContaining("No skills are currently available."),
      })
    }).pipe(Effect.provide(layer(() => skills)))
  })
})
