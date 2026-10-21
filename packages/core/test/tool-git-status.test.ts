import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "path"
import { Effect, Layer } from "effect"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AppProcess } from "@opencode-ai/core/process"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { GitStatusTool } from "@opencode-ai/core/tool/git-status"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_git_status_tool_test")
const assertions: PermissionV2.AssertInput[] = []

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => assertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    materializationRules: () => Effect.succeed([]),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const withTool = <A, E, R>(directory: string, body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
  const gitStatus = GitStatusTool.layer.pipe(
    Layer.provide(registry),
    Layer.provide(activeLocation),
    Layer.provide(permission),
    Layer.provide(AppProcess.defaultLayer),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(Effect.provide(Layer.mergeAll(registry, gitStatus)))
}

const call = (input: typeof GitStatusTool.Input.Type, id = "call-git-status") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "git_status", input },
})

const git = (cwd: string, args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true })
  if (result.status !== 0 || result.error) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

const seedRepo = (directory: string) => {
  git(directory, ["init", "-b", "main"])
  fs.writeFileSync(path.join(directory, "tracked.txt"), "original\n")
  git(directory, ["add", "."])
  git(directory, ["-c", "user.email=agent@example.com", "-c", "user.name=agent", "commit", "-m", "init"])
  fs.writeFileSync(path.join(directory, "staged.txt"), "staged\n")
  git(directory, ["add", "staged.txt"])
  fs.writeFileSync(path.join(directory, "tracked.txt"), "original\nchanged\n")
  fs.writeFileSync(path.join(directory, "untracked.txt"), "untracked\n")
}

const it = testEffect(Layer.empty)

describe("GitStatusTool", () => {
  it.live("reports branch, status and diff summaries in the default summary scope", () =>
    Effect.promise(() => tmpdir()).pipe(
      Effect.flatMap((tmp) =>
        withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => seedRepo(tmp.path))
            assertions.length = 0
            const definitions = yield* toolDefinitions(registry)
            expect(definitions.map((tool) => tool.name)).toEqual(["git_status"])
            const settlement = yield* settleTool(registry, call({}))
            const text = settlement.result.type === "text" ? settlement.result.value : ""
            expect(text).toContain("$ git status --short --branch --untracked-files=all")
            expect(text).toContain("## main")
            expect(text).toContain("A  staged.txt")
            expect(text).toContain(" M tracked.txt")
            expect(text).toContain("?? untracked.txt")
            expect(text).toContain("$ git --no-pager diff --stat")
            expect(text).toContain("$ git --no-pager diff --cached --stat")
            expect(settlement.output?.structured).toMatchObject({ scope: "summary", truncated: false })
            expect(assertions[0]?.action).toBe("git_status")
          }),
        ),
      ),
    ),
  )

  it.live("includes the bounded full diffs in patch scope", () =>
    Effect.promise(() => tmpdir()).pipe(
      Effect.flatMap((tmp) =>
        withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => seedRepo(tmp.path))
            const settlement = yield* settleTool(registry, call({ scope: "patch" }, "call-git-status-patch"))
            const text = settlement.result.type === "text" ? settlement.result.value : ""
            expect(text).toContain("diff --git")
            expect(text).toContain("+changed")
            expect(text).toContain("+staged")
            expect(settlement.output?.structured).toMatchObject({ scope: "patch", truncated: false })
          }),
        ),
      ),
    ),
  )

  it.live("fails honestly outside a git repository", () =>
    Effect.promise(() => tmpdir()).pipe(
      Effect.flatMap((tmp) =>
        withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const settlement = yield* settleTool(registry, call({}))
            expect(settlement.result.type).toBe("error")
            if (settlement.result.type === "error") expect(settlement.result.value).toContain("not a git repository")
          }),
        ),
      ),
    ),
  )
})
