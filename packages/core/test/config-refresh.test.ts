import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { Config } from "@opencode-ai/core/config"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { Policy } from "@opencode-ai/core/policy"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { tmpdir } from "./fixture/tmpdir"

const layerFor = (root: string) =>
  Config.layer.pipe(
    Layer.provideMerge(FSUtil.defaultLayer.pipe(Layer.provideMerge(NodeFileSystem.layer))),
    Layer.provide(
      Layer.succeed(
        Global.Service,
        Global.Service.of({
          home: root,
          data: root,
          cache: root,
          config: root,
          state: root,
          tmp: root,
          bin: root,
          log: root,
          repos: root,
        } as never),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        Location.Service,
        Location.Service.of({
          directory: AbsolutePath.make(root),
          project: { directory: AbsolutePath.make(root), worktree: AbsolutePath.make(root), sandboxes: [] },
        } as never),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        Policy.Service,
        Policy.Service.of({
          load: () => Effect.void,
          evaluate: (_action: string, _resource: string, fallback: Effect.Effect<never>) => Effect.succeed(fallback),
          hasStatements: () => Effect.succeed(false),
        } as never),
      ),
    ),
  )

const runWith = <A, E>(root: string, effect: Effect.Effect<A, E, Config.Service | FSUtil.Service>) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(layerFor(root)))) as Effect.Effect<A>)

describe("Config published generation", () => {
  test("refresh replaces the published generation for skill policy consumers", async () => {
    const tmp = await tmpdir()
    const file = path.join(tmp.path, "opencode.json")
    await fs.writeFile(file, JSON.stringify({ skill_invocation: { entries: { effect: { invocation: "deny" } } } }))
    await runWith(tmp.path, Effect.gen(function* () {
      const readInvocation = Effect.gen(function* () {
        const entries = yield* Config.Service.use((svc) => svc.entries())
        return Config.globalLatest(entries, "skill_invocation")
      })
      expect((yield* readInvocation)?.entries?.effect?.invocation).toBe("deny")
      // An external direct write leaves the published generation stale.
      yield* FSUtil.use.writeFileString(file, JSON.stringify({ skill_invocation: { entries: { effect: { invocation: "allow" } } } }))
      expect((yield* readInvocation)?.entries?.effect?.invocation).toBe("deny")
      const fresh = yield* Config.Service.use((svc) => svc.entries({ refresh: true }))
      expect(Config.globalLatest(fresh, "skill_invocation")?.entries?.effect?.invocation).toBe("allow")
      // The published generation itself moved so later consumers cannot mix
      // new agent overrides with outdated global defaults.
      expect((yield* readInvocation)?.entries?.effect?.invocation).toBe("allow")
    }))
  })

  test("unreadable documents surface as issues and clear after repair", async () => {
    const tmp = await tmpdir()
    const file = path.join(tmp.path, "opencode.json")
    await fs.writeFile(file, JSON.stringify({ model: "test/model" }))
    await runWith(tmp.path, Effect.gen(function* () {
      const issuesNow = () =>
        Config.Service.use((svc) => (svc.issues ? svc.issues() : Effect.succeed([] as Config.ConfigIssue[])))
      expect(yield* issuesNow()).toHaveLength(0)
      yield* FSUtil.use.writeFileString(file, "{ broken")
      const fresh = yield* Config.Service.use((svc) => svc.entries({ refresh: true }))
      expect(Config.globalLatest(fresh, "model")).toBeUndefined()
      const issues = yield* issuesNow()
      expect(issues.some((issue) => issue.path === file)).toBe(true)
      yield* FSUtil.use.writeFileString(file, JSON.stringify({ model: "test/model" }))
      yield* Config.Service.use((svc) => svc.entries({ refresh: true }))
      expect(yield* issuesNow()).toHaveLength(0)
    }))
  })

  test("missing optional config files are not issues", async () => {
    const tmp = await tmpdir()
    await runWith(tmp.path, Effect.gen(function* () {
      const issues = yield* Config.Service.use((svc) => (svc.issues ? svc.issues() : Effect.succeed([] as Config.ConfigIssue[])))
      expect(issues).toHaveLength(0)
    }))
  })
})
