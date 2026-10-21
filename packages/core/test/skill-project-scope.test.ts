import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Config } from "@opencode-ai/core/config"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillDiscovery } from "@opencode-ai/core/skill/discovery"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const scopes: { value: Record<string, { mode: "global" | "projects"; projects?: string[] }> } = { value: {} }
const decode = Schema.decodeUnknownSync(Config.Info)
const it = testEffect(Layer.mergeAll(
  SkillV2.layer.pipe(
    Layer.provide(SkillDiscovery.defaultLayer),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Layer.succeed(Config.Service, Config.Service.of({
      entries: () => Effect.succeed([new Config.Document({ type: "document", info: decode({ skill_scopes: scopes.value }) })]),
    }))),
    Layer.provide(Layer.succeed(Location.Service, Location.Service.of({
      directory: AbsolutePath.make("PROJECT_A"),
      project: { id: Project.ID.make("project-a"), directory: AbsolutePath.make("PROJECT_A") },
    }))),
  ),
  FSUtil.defaultLayer,
))

describe("skill project scope", () => {
  it.live("filters excluded skills before resolving same-name precedence", () =>
    Effect.acquireRelease(Effect.promise(() => tmpdir()), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]())).pipe(
      Effect.flatMap((tmp) => Effect.gen(function* () {
        const first = path.join(tmp.path, "first")
        const second = path.join(tmp.path, "second")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(first, "shared"), { recursive: true })
          await fs.mkdir(path.join(second, "shared"), { recursive: true })
          await fs.writeFile(path.join(first, "shared", "SKILL.md"), "---\nname: shared\ndescription: selected\n---\nSelected source")
          await fs.writeFile(path.join(second, "shared", "SKILL.md"), "---\nname: shared\ndescription: excluded\n---\nExcluded source")
        })
        scopes.value = { [first]: { mode: "projects", projects: ["PROJECT_A"] }, [second]: { mode: "projects", projects: ["PROJECT_B"] } }
        const skill = yield* SkillV2.Service
        const register = yield* skill.transform()
        yield* register((editor) => {
          editor.source({ type: "directory", path: AbsolutePath.make(first) })
          editor.source({ type: "directory", path: AbsolutePath.make(second) })
        })
        expect((yield* skill.list()).map((item) => ({ description: item.description, content: item.content }))).toEqual([
          { description: "selected", content: "Selected source" },
        ])
        scopes.value = {
          [first]: { mode: "global" },
          [path.join(first, "shared")]: { mode: "projects", projects: ["PROJECT_B"] },
          [second]: { mode: "global" },
        }
        expect((yield* skill.list()).map((item) => item.description)).toEqual(["excluded"])
        const alias = path.join(tmp.path, "alias")
        yield* Effect.promise(async () => {
          await fs.mkdir(alias)
          await fs.symlink(path.join(first, "shared"), path.join(alias, "shared"), process.platform === "win32" ? "junction" : "dir")
        })
        yield* register((editor) => {
          editor.source({ type: "directory", path: AbsolutePath.make(first) })
          editor.source({ type: "directory", path: AbsolutePath.make(second) })
          editor.source({ type: "directory", path: AbsolutePath.make(alias) })
        })
        expect((yield* skill.list()).map((item) => item.description)).toEqual(["excluded"])
      })),
    ),
  )
})
