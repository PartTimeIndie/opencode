import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { CommandV2 } from "@opencode-ai/core/command"
import { Config } from "@opencode-ai/core/config"
import { ConfigSkillPlugin } from "@opencode-ai/core/config/plugin/skill"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { SkillCommandPlugin } from "@opencode-ai/core/plugin/skill-command"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const integrationIt = testEffect(
  Layer.mergeAll(
    CommandV2.locationLayer,
    FSUtil.defaultLayer,
    SkillV2.locationLayer.pipe(Layer.provide(FSUtil.defaultLayer)),
  ),
)
const decode = Schema.decodeUnknownSync(Config.Info)
const filesystem = Layer.effect(
  FSUtil.Service,
  FSUtil.Service.use((fs) =>
    Effect.succeed(
      FSUtil.Service.of({
        ...fs,
        up: () => Effect.succeed([path.join("/repo", ".agents"), path.join("/repo", ".codex")]),
      }),
    ),
  ),
).pipe(Layer.provide(FSUtil.defaultLayer))

describe("ConfigSkillPlugin.Plugin", () => {
  it.effect("registers the original shared skill source only in selected projects", () =>
    Effect.gen(function* () {
      const sources: SkillV2.Source[] = []
      const source = "/repo/first/.opencode/skills/shared"
      const config = Config.Service.of({ entries: () => Effect.succeed([
        new Config.Document({ type: "document", info: decode({ skill_scopes: { [source]: { mode: "projects", projects: ["/repo/other"] } } }) }),
        new Config.Directory({ type: "directory", path: AbsolutePath.make("/repo/other/.opencode") }),
      ]) })
      yield* ConfigSkillPlugin.Plugin.effect.pipe(
        Effect.provideService(Config.Service, config),
        Effect.provideService(Global.Service, Global.Service.of(Global.make({ home: "/home/test" }))),
        Effect.provide(filesystem),
        Effect.provideService(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/repo/other") }))),
        Effect.provideService(SkillV2.Service, SkillV2.Service.of({
          transform: () => Effect.succeed((update) => Effect.sync(() => update({ source: (item) => sources.push(item), list: () => sources }))),
          sources: () => Effect.succeed(sources),
          list: () => Effect.succeed([]),
        })),
      )
      expect(sources).toContainEqual(new SkillV2.DirectorySource({ type: "directory", path: AbsolutePath.make(source) }))
    }),
  )
  it.effect("registers configured skill directories and URLs", () =>
    Effect.gen(function* () {
      const directory = AbsolutePath.make("/repo/packages/app")
      const sources: SkillV2.Source[] = []
      const transform = Effect.fnUntraced(function* () {
        return Effect.fnUntraced(function* (update: (editor: SkillV2.Editor) => void) {
          update({
            source: (source) => sources.push(source),
            list: () => sources,
          })
        })
      })

      yield* ConfigSkillPlugin.Plugin.effect.pipe(
        Effect.provideService(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Directory({ type: "directory", path: AbsolutePath.make("/repo/.opencode") }),
                new Config.Document({
                  type: "document",
                  info: decode({
                    skills: ["./skills", "~/shared-skills", "/opt/skills", "https://example.test/skills/"],
                  }),
                }),
              ]),
          }),
        ),
        Effect.provideService(Global.Service, Global.Service.of(Global.make({ home: "/home/test" }))),
        Effect.provide(filesystem),
        Effect.provideService(Location.Service, Location.Service.of(location({ directory }))),
        Effect.provideService(
          SkillV2.Service,
          SkillV2.Service.of({
            transform,
            sources: () => Effect.succeed(sources),
            list: () => Effect.succeed([]),
          }),
        ),
      )

      expect(sources).toEqual([
        new SkillV2.DirectorySource({
          type: "directory",
          path: AbsolutePath.make(path.join("/home/test", ".agents", "skills")),
        }),
        new SkillV2.DirectorySource({
          type: "directory",
          path: AbsolutePath.make(path.join("/home/test", ".cursor", "skills")),
        }),
        new SkillV2.DirectorySource({
          type: "directory",
          path: AbsolutePath.make(path.join("/home/test", ".claude", "skills")),
        }),
        new SkillV2.DirectorySource({
          type: "directory",
          path: AbsolutePath.make(path.join("/home/test", ".codex", "skills")),
        }),
        new SkillV2.DirectorySource({
          type: "directory",
          path: AbsolutePath.make(path.join("/repo", ".agents", "skills")),
        }),
        new SkillV2.DirectorySource({
          type: "directory",
          path: AbsolutePath.make(path.join("/repo", ".codex", "skills")),
        }),
        new SkillV2.DirectorySource({
          type: "directory",
          path: AbsolutePath.make(path.join("/repo/.opencode", "skill")),
        }),
        new SkillV2.DirectorySource({
          type: "directory",
          path: AbsolutePath.make(path.join("/repo/.opencode", "skills")),
        }),
        new SkillV2.DirectorySource({ type: "directory", path: AbsolutePath.make(path.join(directory, "skills")) }),
        new SkillV2.DirectorySource({
          type: "directory",
          path: AbsolutePath.make(path.join("/home/test", "shared-skills")),
        }),
        new SkillV2.DirectorySource({ type: "directory", path: AbsolutePath.make("/opt/skills") }),
        new SkillV2.UrlSource({ type: "url", url: "https://example.test/skills/" }),
      ])
    }),
  )

  integrationIt.live("project-local automatic metadata overrides the global manual skill without changing its source", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const home = path.join(tmp.path, "home")
          const project = path.join(tmp.path, "project")
          const globalDirectory = path.join(home, ".config", "opencode")
          const projectDirectory = path.join(project, ".opencode")
          const globalFile = path.join(globalDirectory, "skills", "unity-localization", "SKILL.md")
          const projectFile = path.join(projectDirectory, "skills", "unity-localization", "SKILL.md")
          yield* Effect.promise(async () => {
            for (const [file, manual] of [[globalFile, true], [projectFile, false]] as const) {
              await fs.mkdir(path.dirname(file), { recursive: true })
              await fs.writeFile(file, `---\nname: unity-localization\ndescription: Unity localization\ndisable-model-invocation: ${manual}\n---\n${manual ? "global" : "project"}`)
            }
          })
          const register = (includeProject: boolean) => ConfigSkillPlugin.Plugin.effect.pipe(
            Effect.provideService(Config.Service, Config.Service.of({
              entries: () => Effect.succeed([
                new Config.Directory({ type: "directory", path: AbsolutePath.make(globalDirectory) }),
                ...(includeProject ? [new Config.Directory({ type: "directory", path: AbsolutePath.make(projectDirectory) })] : []),
              ]),
            })),
            Effect.provideService(Global.Service, Global.Service.of(Global.make({ home }))),
            Effect.provideService(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(project) }, { projectDirectory: AbsolutePath.make(project) }))),
          )
          const skills = yield* SkillV2.Service
          yield* register(false)
          expect((yield* skills.list()).find((item) => item.name === "unity-localization")?.disableModelInvocation).toBe(true)
          yield* register(true)
          const selected = (yield* skills.list()).find((item) => item.name === "unity-localization")
          expect(selected?.disableModelInvocation).toBe(false)
          expect(selected?.location).toBe(AbsolutePath.make(projectFile))
          expect(yield* Effect.promise(() => fs.readFile(globalFile, "utf8"))).toContain("disable-model-invocation: true")
        }),
      ),
    ),
  )

  integrationIt.live("discovers global, project, and repo-local skills for the slash catalog", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const home = path.join(tmp.path, "home")
          const project = path.join(tmp.path, "project")
          const directory = AbsolutePath.make(path.join(project, "packages", "app"))
          const files = [
            [path.join(home, ".codex", "skills", "global-skill", "SKILL.md"), "global-skill"],
            [path.join(project, ".agents", "skills", "project-skill", "SKILL.md"), "project-skill"],
            [path.join(project, ".opencode", "skills", "on-demand-ui", "SKILL.md"), "on-demand-ui"],
          ] as const
          yield* Effect.promise(async () => {
            await fs.mkdir(directory, { recursive: true })
            await Promise.all(
              files.map(async ([file, name]) => {
                await fs.mkdir(path.dirname(file), { recursive: true })
                await fs.writeFile(file, `---\nname: ${name}\ndescription: ${name}\n---\n${name} instructions`)
              }),
            )
          })

          const skill = yield* SkillV2.Service
          yield* ConfigSkillPlugin.Plugin.effect.pipe(
            Effect.provideService(
              Config.Service,
              Config.Service.of({
                entries: () =>
                  Effect.succeed([
                    new Config.Directory({
                      type: "directory",
                      path: AbsolutePath.make(path.join(project, ".opencode")),
                    }),
                  ]),
              }),
            ),
            Effect.provideService(Global.Service, Global.Service.of(Global.make({ home }))),
            Effect.provideService(
              Location.Service,
              Location.Service.of(location({ directory }, { projectDirectory: AbsolutePath.make(project) })),
            ),
          )

          expect((yield* skill.list()).map((item) => item.name).toSorted()).toEqual([
            "global-skill",
            "on-demand-ui",
            "project-skill",
          ])

          yield* SkillCommandPlugin.Plugin.effect
          expect((yield* CommandV2.Service.use((command) => command.list())).map((item) => item.name).toSorted()).toEqual([
            "global-skill",
            "on-demand-ui",
            "project-skill",
          ])
        }),
      ),
    ),
  )
})
