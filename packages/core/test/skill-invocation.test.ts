import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PluginBoot } from "@opencode-ai/core/plugin/boot"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillDiscovery } from "@opencode-ai/core/skill/discovery"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { SystemContext } from "@opencode-ai/core/system-context"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigMigrateV1 } from "@opencode-ai/core/v1/config/migrate"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
const manual = {
  manual: ["visual-qa-testing", "multi-agent-review", "progressive-plan-builder", "multi-agent-problem-solver"],
}
const document = (skill_invocation: (typeof Config.Info.Type)["skill_invocation"]) =>
  new Config.Document({ type: "document", info: new Config.Info({ skill_invocation }) })
const layer = (entries: Config.Entry[]) =>
  SkillV2.layer.pipe(
    Layer.provide(SkillDiscovery.defaultLayer),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed(entries) }))),
  )
const skill = (name: string, extra: Partial<SkillV2.Info> = {}) =>
  new SkillV2.Info({
    name,
    description: `Guidance for ${name}`,
    location: AbsolutePath.make(path.resolve(`/skills/${name}/SKILL.md`)),
    content: `Instructions for ${name}`,
    ...extra,
  })

describe("global skill invocation policy", () => {
  it.effect("bounds guidance variants while retaining recently used context identity", () => {
    const state = { current: skill("first") }
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      const agent = new AgentV2.Info(AgentV2.Info.empty(AgentV2.ID.make("build")))
      const selection = { id: agent.id, info: agent }
      const first = yield* guidance.load(selection)
      for (const index of Array.from({ length: SkillGuidance.CACHE_LIMIT - 1 }, (_, index) => index)) {
        state.current = skill(`variant-${index}`)
        yield* guidance.load(selection)
      }
      state.current = skill("first")
      expect(yield* guidance.load(selection)).toBe(first)
      for (const index of Array.from({ length: SkillGuidance.CACHE_LIMIT }, (_, index) => index)) {
        state.current = skill(`new-${index}`)
        yield* guidance.load(selection)
      }
      state.current = skill("first")
      const reloaded = yield* guidance.load(selection)
      expect(reloaded).not.toBe(first)
      expect((yield* SystemContext.initialize(reloaded)).baseline).toContain("<name>first</name>")
    }).pipe(
      Effect.provide(
        SkillGuidance.layer.pipe(
          Layer.provide(Layer.mock(SkillV2.Service, { list: () => Effect.sync(() => [state.current]) })),
          Layer.provide(Layer.mock(PluginBoot.Service, { wait: () => Effect.void })),
        ),
      ),
    )
  })

  test("validates both dialects and preserves the policy through V1 migration", () => {
    expect(Schema.decodeUnknownSync(Config.Info)({ skill_invocation: manual }).skill_invocation).toEqual(manual)
    const legacy = Schema.decodeUnknownSync(ConfigV1.Info)({ skill_invocation: manual })
    expect(ConfigMigrateV1.migrate(legacy).skill_invocation).toEqual(manual)
    for (const schema of [Config.Info, ConfigV1.Info]) {
      expect(() => Schema.decodeUnknownSync(schema)({ skill_invocation: { manual: true } })).toThrow()
      expect(() => Schema.decodeUnknownSync(schema)({ skill_invocation: { default: "manual" } })).toThrow()
    }
  })

  it.effect("restricts only named toolbar skills and retains image generation and other prior modes", () =>
    Effect.gen(function* () {
      const skills = yield* SkillV2.Service
      const register = yield* skills.transform()
      yield* register((editor) => {
        for (const item of [
          skill("imagegen"),
          skill("effect"),
          skill("localization"),
          skill("future-project-skill"),
          skill("impostor", { aliases: ["visual-qa-testing"] }),
          skill("already-manual", { disableModelInvocation: true }),
          ...manual.manual.map((name) => skill(name)),
        ])
          editor.source({ type: "embedded", skill: item })
      })
      const list = yield* skills.list()
      expect(list.map((item) => item.name)).toEqual([
        "imagegen",
        "effect",
        "localization",
        "future-project-skill",
        "impostor",
        "already-manual",
        ...manual.manual,
      ])
      expect(list.filter((item) => item.disableModelInvocation).map((item) => item.name)).toEqual([
        "already-manual",
        ...manual.manual,
      ])
      expect(SkillV2.resolveSelected(list, ["visual-qa-testing"]).skills[0]?.content).toBe(
        "Instructions for visual-qa-testing",
      )
      const guidance = yield* SkillGuidance.Service
      const agent = new AgentV2.Info(AgentV2.Info.empty(AgentV2.ID.make("build")))
      const context = yield* guidance.load({ id: agent.id, info: agent }).pipe(Effect.flatMap(SystemContext.initialize))
      expect(context.baseline).toContain("<name>imagegen</name>")
      for (const name of ["effect", "localization", "future-project-skill", "impostor"])
        expect(context.baseline).toContain(`<name>${name}</name>`)
      for (const name of ["already-manual", ...manual.manual])
        expect(context.baseline).not.toContain(`<name>${name}</name>`)
    }).pipe(
      Effect.provide(
        SkillGuidance.layer.pipe(
          Layer.provideMerge(layer([document(manual)])),
          Layer.provide(Layer.mock(PluginBoot.Service, { wait: () => Effect.void })),
        ),
      ),
    ),
  )

  it.live("parses portable groups and refreshes metadata without changing skill identity or manual mode", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const filepath = path.join(tmp.path, "test.md")
          const write = (ids: string) =>
            Effect.promise(() =>
              fs.writeFile(
                filepath,
                `---\nname: test\ndescription: Test skill\ndisable-model-invocation: true\nmetadata:\n  opencode/groups: "${ids}"\n  native-host: "preserved"\n---\nBody`,
              ),
            )
          yield* write("media, studio, media")
          const skills = yield* SkillV2.Service
          const register = yield* skills.transform()
          yield* register((editor) => editor.source({ type: "directory", path: AbsolutePath.make(tmp.path) }))
          expect((yield* skills.list())[0]).toMatchObject({
            name: "test",
            groups: ["media", "studio", "media"],
            disableModelInvocation: true,
            content: "Body",
          })
          yield* write("studio")
          expect((yield* skills.list())[0].groups).toEqual(["media", "studio", "media"])
          expect((yield* skills.list({ refresh: true }))[0].groups).toEqual(["studio"])
        }).pipe(Effect.provide(layer([]))),
      ),
    ),
  )

  it.live("applies outside directory caches, ignores project widening and preserves stricter frontmatter", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const entries: Config.Entry[] = [
          document({ manual: ["test"] }),
          new Config.Directory({ type: "directory", path: AbsolutePath.make(tmp.path) }),
          document({ manual: [] }),
        ]
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "test"))
            await fs.writeFile(
              path.join(tmp.path, "test", "SKILL.md"),
              "---\nname: test\ndescription: Test skill\ndisable-model-invocation: false\n---\nTest",
            )
          })
          const skills = yield* SkillV2.Service
          const register = yield* skills.transform()
          yield* register((editor) => {
            editor.source({ type: "directory", path: AbsolutePath.make(tmp.path) })
            editor.source({ type: "embedded", skill: skill("imagegen", { disableModelInvocation: true }) })
          })
          expect((yield* skills.list()).map((item) => item.disableModelInvocation)).toEqual([true, true])
          entries[0] = document({ manual: [] })
          expect((yield* skills.list()).map((item) => item.disableModelInvocation)).toEqual([false, true])
          entries[0] = document({ manual: ["test"] })
          expect((yield* skills.list()).map((item) => item.disableModelInvocation)).toEqual([true, true])
        }).pipe(Effect.provide(layer(entries)))
      }),
    ),
  )
})
