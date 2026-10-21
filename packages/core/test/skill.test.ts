import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillDiscovery } from "@opencode-ai/core/skill/discovery"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const urls = new Map<string, AbsolutePath[]>()
let pulls = 0
const discovery = Layer.succeed(
  SkillDiscovery.Service,
  SkillDiscovery.Service.of({
    pull: (url) => {
      pulls++
      return Effect.succeed(urls.get(url) ?? [])
    },
  }),
)
const it = testEffect(
  SkillV2.layer.pipe(
    Layer.provide(discovery),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provideMerge(AgentV2.locationLayer),
  ),
)

function write(directory: string, name: string, description: string) {
  return fs.writeFile(
    path.join(directory, name, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---
# ${name}`,
  )
}

describe("SkillV2", () => {
  it.effect("recognizes only an explicit leading slash invocation of the selected skill or alias", () =>
    Effect.sync(() => {
      const skill = new SkillV2.Info({
        name: "manual",
        aliases: ["shortcut"],
        location: AbsolutePath.make("/skills/manual.md"),
        content: "Manual",
      })
      for (const text of ["/manual", " /manual now", "/shortcut\nnow"])
        expect(SkillV2.invokedBySlash(skill, text)).toBe(true)
      for (const text of [
        "Use manual",
        "Please /manual",
        "/manual-other",
        "/manual/other",
        "/manual!",
        "`/manual`",
        "",
      ])
        expect(SkillV2.invokedBySlash(skill, text)).toBe(false)
    }),
  )

  it.effect("enforces selected-name request boundaries", () =>
    Effect.sync(() => {
      const decode = Schema.decodeUnknownSync(SkillV2.ResolveInput)
      expect(
        decode({ names: Array.from({ length: 16 }, (_, index) => `${"x".repeat(125)}${String(index).padStart(3, "0")}`) }).names,
      ).toHaveLength(16)
      expect(() => decode({ names: Array.from({ length: 17 }, (_, index) => `skill-${index}`) })).toThrow()
      expect(decode({ names: ["x".repeat(128)] }).names[0]).toHaveLength(128)
      expect(() => decode({ names: ["x".repeat(129)] })).toThrow()
    }),
  )

  it.effect("accepts the aggregate content boundary and reports later content deterministically", () =>
    Effect.sync(() => {
      const skills = Array.from({ length: 5 }, (_, index) =>
        new SkillV2.Info({
          name: `skill-${index}`,
          location: AbsolutePath.make(`/skills/skill-${index}/SKILL.md`),
          content: index < 4 ? "x".repeat(64 * 1024) : "x",
        }),
      )

      expect(SkillV2.resolveSelected(skills, skills.map((skill) => skill.name))).toEqual(
        new SkillV2.ResolveOutput({
          skills: skills.slice(0, 4).map((skill) => new SkillV2.Resolved({ name: skill.name, content: skill.content })),
          issues: [new SkillV2.ResolveIssue({ name: "skill-4", code: "total_too_large" })],
        }),
      )
    }),
  )

  it.effect("resolves only selected canonical skill names within content limits", () =>
    Effect.sync(() => {
      const skills = [
        new SkillV2.Info({
          name: "personal-writing-style",
          aliases: ["writing style"],
          location: AbsolutePath.make("/skills/personal-writing-style/SKILL.md"),
          content: "Current personal style",
        }),
        new SkillV2.Info({
          name: "oversized",
          location: AbsolutePath.make("/skills/oversized/SKILL.md"),
          content: "x".repeat(64 * 1024 + 1),
        }),
      ]

      expect(
        SkillV2.resolveSelected(skills, [
          "personal-writing-style",
          "writing style",
          "/personal-writing-style",
          "../SKILL.md",
          "oversized",
          "personal-writing-style",
        ]),
      ).toEqual(
        new SkillV2.ResolveOutput({
          skills: [new SkillV2.Resolved({ name: "personal-writing-style", content: "Current personal style" })],
          issues: [
            new SkillV2.ResolveIssue({ name: "writing style", code: "not_found" }),
            new SkillV2.ResolveIssue({ name: "/personal-writing-style", code: "not_a_skill" }),
            new SkillV2.ResolveIssue({ name: "../SKILL.md", code: "not_a_skill" }),
            new SkillV2.ResolveIssue({ name: "oversized", code: "too_large" }),
          ],
        }),
      )
    }),
  )

  it.live("registers sources and resolves later source precedence", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = path.join(tmp.path, "first")
          const second = path.join(tmp.path, "second")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(first, "review"), { recursive: true })
            await fs.mkdir(path.join(second, "review"), { recursive: true })
            await write(first, "review", "First")
            await write(second, "review", "Second")
            await fs.writeFile(
              path.join(first, "foo.md"),
              "---\nslash: true\ndisable-model-invocation: true\nprovider: anthropic\nmodel: claude-sonnet-4\nagent: build\nvariant: high\ntools: [surface]\naliases: [foo alias, speech foo]\n---\n# foo",
            )
          })

          const skill = yield* SkillV2.Service
          const register = yield* skill.transform()
          yield* register((editor) => {
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(second) })
            expect(editor.list()).toEqual([
              { type: "directory", path: AbsolutePath.make(first) },
              { type: "directory", path: AbsolutePath.make(second) },
            ])
          })

          expect(yield* skill.sources()).toEqual([
            { type: "directory", path: AbsolutePath.make(first) },
            { type: "directory", path: AbsolutePath.make(second) },
          ])
          expect(yield* skill.list()).toEqual([
            new SkillV2.Info({
              name: "foo",
              slash: true,
              disableModelInvocation: true,
              agent: "build",
              requiredTools: ["surface"],
              aliases: ["foo alias", "speech foo"],
              model: {
                id: ModelV2.ID.make("claude-sonnet-4"),
                providerID: ProviderV2.ID.make("anthropic"),
                variant: ModelV2.VariantID.make("high"),
              },
              location: AbsolutePath.make(path.join(first, "foo.md")),
              content: "# foo",
            }),
            {
              name: "review",
              description: "Second",
              location: AbsolutePath.make(path.join(second, "review", "SKILL.md")),
              content: "# review",
            },
          ])
        }),
      ),
    ),
  )

  it.live("loads URL sources and filters skills for agents", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "deploy"), { recursive: true })
            await write(tmp.path, "deploy", "Deploy production")
          })
          pulls = 0
          urls.set("https://example.test/skills/", [AbsolutePath.make(tmp.path)])

          const agents = yield* AgentV2.Service
          yield* agents.update((editor) =>
            editor.update(AgentV2.ID.make("reviewer"), (agent) => {
              agent.permissions.push({ action: "skill", resource: "deploy", effect: "deny" })
            }),
          )

          const skill = yield* SkillV2.Service
          const register = yield* skill.transform()
          yield* register((editor) => editor.source({ type: "url", url: "https://example.test/skills/" }))

          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect((yield* skill.list({ refresh: true })).map((item) => item.name)).toEqual(["deploy"])
          expect(pulls).toBe(1)
          expect(SkillV2.available(yield* skill.list(), (yield* agents.get(AgentV2.ID.make("reviewer")))!)).toEqual([])
        }),
      ),
    ),
  )

  it.effect("filters skills whose required tools are unavailable", () =>
    Effect.sync(() => {
      const required = new SkillV2.Info({
        name: "on-demand-ui",
        requiredTools: ["surface"],
        location: AbsolutePath.make("/skills/on-demand-ui/SKILL.md"),
        content: "Use surface",
      })
      const restricted = new AgentV2.Info({
        ...AgentV2.Info.empty(AgentV2.ID.make("restricted")),
        tools: { mode: "explicit", entries: {} },
      })
      const allowed = new AgentV2.Info({
        ...AgentV2.Info.empty(AgentV2.ID.make("allowed")),
        tools: {
          mode: "explicit",
          entries: { surface: { visible: true, permission: "allow" } },
        },
      })

      expect(SkillV2.available([required], restricted)).toEqual([])
      expect(SkillV2.missingTools(required, restricted)).toEqual(["surface"])
      expect(SkillV2.available([required], allowed)).toEqual([required])
    }),
  )

  it.live("refreshes directory sources while preserving the cached default list", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "first"), { recursive: true })
            await write(tmp.path, "first", "First")
          })

          const skill = yield* SkillV2.Service
          const register = yield* skill.transform()
          yield* register((editor) => editor.source({ type: "directory", path: AbsolutePath.make(tmp.path) }))

          expect((yield* skill.list()).map((item) => [item.name, item.description])).toEqual([["first", "First"]])
          yield* Effect.promise(async () => {
            await write(tmp.path, "first", "Updated")
            await fs.mkdir(path.join(tmp.path, "second"), { recursive: true })
            await write(tmp.path, "second", "Second")
          })

          expect((yield* skill.list()).map((item) => item.name)).toEqual(["first"])
          expect((yield* skill.list({ refresh: true })).map((item) => [item.name, item.description])).toEqual([
            ["first", "Updated"],
            ["second", "Second"],
          ])

          yield* Effect.promise(() => fs.rm(path.join(tmp.path, "first"), { recursive: true }))
          expect((yield* skill.list({ refresh: true })).map((item) => item.name)).toEqual(["second"])
        }),
      ),
    ),
  )
})
