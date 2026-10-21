import { describe, expect } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AgentPlugin } from "@opencode-ai/core/plugin/agent"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const it = testEffect(AgentV2.locationLayer)

describe("AgentV2", () => {
  it.effect("starts without agents", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service

      expect(yield* agent.all()).toEqual([])
      expect(yield* agent.get(AgentV2.ID.make("build"))).toBeUndefined()
    }),
  )

  it.effect("materializes replayable agent transforms", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("reviewer")
      const transform = yield* agent.transform()

      yield* transform((editor) =>
        editor.update(id, (info) => {
          info.description = "Reviews code"
          info.mode = "subagent"
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ id, description: "Reviews code", mode: "subagent" })
      expect((yield* agent.all()).map((info) => info.id)).toEqual([id])
    }),
  )

  it.effect("rebuilds state when a transform is replaced", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("reviewer")
      const transform = yield* agent.transform()

      yield* transform((editor) =>
        editor.update(id, (info) => {
          info.description = "Old description"
          info.hidden = true
        }),
      )
      yield* transform((editor) =>
        editor.update(id, (info) => {
          info.description = "New description"
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ description: "New description", hidden: false })
    }),
  )

  it.effect("removes a transform when its scope closes", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("scoped")
      const scope = yield* Scope.make()
      const transform = yield* agent.transform().pipe(Scope.provide(scope))

      yield* transform((editor) => editor.update(id, () => {}))
      expect(yield* agent.get(id)).toBeDefined()

      yield* Scope.close(scope, Exit.void)
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("applies direct agent updates", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("build")

      yield* agent.update((editor) =>
        editor.update(id, (info) => {
          info.mode = "primary"
          info.hidden = true
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ id, mode: "primary", hidden: true })
    }),
  )

  it.effect("creates agents with runtime defaults and supports direct removal", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("custom")

      yield* agent.update((editor) => editor.update(id, () => {}))
      expect(yield* agent.get(id)).toEqual(AgentV2.Info.empty(id))

      yield* agent.update((editor) => editor.remove(id))
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("does not ambiently opt built-in agents into bash", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect.pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
        ),
      )

      const agents = yield* agent.all()
      expect(agents.map((item) => String(item.id)).sort()).toEqual([
        "build",
        "compaction",
        "explore",
        "general",
        "plan",
        "review",
        "summary",
        "title",
      ])
      for (const item of agents) {
        expect(item.permissions.some((rule) => rule.action === "bash" && rule.effect !== "deny")).toBe(false)
      }
    }),
  )

  it.effect("does not install plugin-owned voice agents in the core", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect.pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
        ),
      )

      const voice = yield* agent.get(AgentV2.ID.make("voice-moderator"))
      expect(voice).toBeUndefined()
    }),
  )

  it.effect("provides a read-only review subagent for model fanout", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect.pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
        ),
      )

      const review = yield* agent.get(AgentV2.ID.make("review"))
      expect(review).toMatchObject({
        mode: "subagent",
        hidden: false,
      })
      expect(review?.steps).toBeUndefined()
      expect(PermissionV2.evaluate("read", "src/index.ts", review?.permissions ?? []).effect).toBe("allow")
      expect(PermissionV2.evaluate("grep", "*", review?.permissions ?? []).effect).toBe("allow")
      expect(PermissionV2.evaluate("git_status", "summary", review?.permissions ?? []).effect).toBe("allow")
      expect(PermissionV2.evaluate("edit", "src/index.ts", review?.permissions ?? []).effect).toBe("deny")
      expect(PermissionV2.evaluate("bash", "git diff", review?.permissions ?? []).effect).toBe("deny")

      const plan = yield* agent.get(AgentV2.ID.make("plan"))
      expect(PermissionV2.evaluate("task", "review", plan?.permissions ?? []).effect).toBe("allow")
      expect(PermissionV2.evaluate("task", "general", plan?.permissions ?? []).effect).toBe("deny")
    }),
  )

  it.effect("enables only the paired plan and build handoff targets by default", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect.pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
        ),
      )

      const build = yield* agent.get(AgentV2.ID.make("build"))
      const plan = yield* agent.get(AgentV2.ID.make("plan"))
      expect(plan?.system).toContain("including in a later message after the plan was presented")
      expect(plan?.system).toContain('call switch_agent with agent "build"')
      expect(PermissionV2.evaluate("edit", "src/index.ts", plan?.permissions ?? []).effect).toBe("deny")
      expect(PermissionV2.evaluate("bash", "bun test", plan?.permissions ?? []).effect).toBe("deny")
      expect(PermissionV2.evaluate("switch_agent", "plan", build?.permissions ?? []).effect).toBe("allow")
      expect(PermissionV2.evaluate("switch_agent", "build", build?.permissions ?? []).effect).toBe("deny")
      expect(PermissionV2.evaluate("switch_agent", "build", plan?.permissions ?? []).effect).toBe("allow")
      expect(PermissionV2.evaluate("switch_agent", "plan", plan?.permissions ?? []).effect).toBe("deny")
      expect(PermissionV2.evaluate("surface", "*", build?.permissions ?? []).effect).toBe("allow")
      expect(PermissionV2.evaluate("surface", "*", plan?.permissions ?? []).effect).toBe("allow")
    }),
  )

  it.effect("allows the general subagent to open user questions", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect.pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
        ),
      )

      const general = yield* agent.get(AgentV2.ID.make("general"))
      expect(general).toBeDefined()
      expect(PermissionV2.evaluate("question", "*", general?.permissions ?? []).effect).toBe("allow")
    }),
  )
})
