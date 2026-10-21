import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { ConfigOptimization } from "@opencode-ai/core/config/optimization"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { GlobTool } from "@opencode-ai/core/tool/glob"
import { GrepTool } from "@opencode-ai/core/tool/grep"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { executeTool, toolIdentity } from "./lib/tool"
import { testEffect } from "./lib/effect"

const sessionID = SessionV2.ID.make("ses_search_limits")
const grepInputs: Ripgrep.GrepInput[] = []
const globInputs: Ripgrep.GlobInput[] = []

const ripgrep = Layer.succeed(
  Ripgrep.Service,
  Ripgrep.Service.of({
    find: () => Effect.succeed([]),
    glob: (input) =>
      Effect.sync(() => {
        globInputs.push(input)
        return []
      }),
    grep: (input) =>
      Effect.sync(() => {
        grepInputs.push(input)
        return []
      }),
  }),
)

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    materializationRules: () => Effect.succeed([]),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            optimization: new ConfigOptimization.Info({
              profile: "safe",
              features: new ConfigOptimization.Features({ core_search_limits: true }),
            }),
          }),
        }),
      ]),
  }),
)

const location = Layer.succeed(
  Location.Service,
  Location.Service.of({
    directory: AbsolutePath.make(process.cwd()),
    workspaceID: undefined,
    project: { id: Project.ID.make("proj_test"), directory: AbsolutePath.make(process.cwd()) },
    vcs: undefined,
  }),
)

const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
const tools = Layer.mergeAll(
  registry,
  permission,
  config,
  location,
  ripgrep,
  FSUtil.defaultLayer,
  GlobTool.layer.pipe(Layer.provide(registry), Layer.provide(permission), Layer.provide(location), Layer.provide(ripgrep), Layer.provide(config)),
  GrepTool.layer.pipe(
    Layer.provide(registry),
    Layer.provide(permission),
    Layer.provide(location),
    Layer.provide(ripgrep),
    Layer.provide(config),
    Layer.provide(FSUtil.defaultLayer),
  ),
)
const it = testEffect(tools)

describe("search tool optimization limits", () => {
  beforeEach(() => {
    grepInputs.length = 0
    globInputs.length = 0
  })

  it.effect("uses conservative default grep and glob limits when enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service

      yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-glob", name: "glob", input: { pattern: "**/*.ts" } },
      })
      yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-grep", name: "grep", input: { pattern: "needle" } },
      })

      expect(globInputs[0]?.limit).toBe(GlobTool.DEFAULT_LIMIT)
      expect(grepInputs[0]?.limit).toBe(GrepTool.DEFAULT_LIMIT)
    }),
  )

  test("marks capped grep and glob output as potentially non-exhaustive", () => {
    expect(
      GrepTool.toModelOutput(
        Array.from({ length: GrepTool.DEFAULT_LIMIT }, (_, index) => ({
          entry: { path: `src/file-${index}.ts`, type: "file" as const, mime: "text/typescript" },
          line: 1,
          offset: 0,
          text: "needle",
          submatches: [],
        })),
      ),
    ).toContain("rerun with a higher limit")
    expect(
      GlobTool.toModelOutput(
        Array.from({ length: GlobTool.DEFAULT_LIMIT }, (_, index) => ({
          path: `src/file-${index}.ts`,
          type: "file" as const,
          mime: "text/typescript",
        })),
      ),
    ).toContain("rerun with a higher limit")
  })
})
