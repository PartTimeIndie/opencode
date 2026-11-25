import { describe, expect } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "path"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AppProcess } from "@opencode-ai/core/process"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionAgentPolicy } from "@opencode-ai/core/session/agent-policy"
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

  it.live("delegates git patches through explicit parent and reviewer policies without shell access", () =>
    Effect.promise(() => tmpdir()).pipe(
      Effect.flatMap((tmp) =>
        withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => seedRepo(tmp.path))
            const parent = new AgentV2.Info({
              id: AgentV2.ID.make("build"),
              mode: "primary",
              hidden: false,
              request: { headers: {}, body: {} },
              permissions: [],
              tools: {
                mode: "explicit",
                entries: { git_status: { visible: true, permission: "allow" } },
              },
            })
            const reviewerRules: PermissionV2.Ruleset = [
              { action: "*", resource: "*", effect: "deny" },
              { action: "git_status", resource: "*", effect: "allow" },
            ]
            const parentTools = yield* registry.materialize([], SessionAgentPolicy.delegable(parent.tools))
            const childTools = yield* registry.materialize(reviewerRules)
            const policy = SessionAgentPolicy.derive({
              parent: undefined,
              parentSessionID: sessionID,
              parentAgent: parent,
              parentDelegableTools: parentTools.definitions.map((tool) => tool.name),
              childTools: childTools.definitions.map((tool) => tool.name),
              type: "task",
            })
            const reviewer = yield* registry.materialize(reviewerRules, policy.tools)
            expect(reviewer.definitions.map((tool) => tool.name)).toEqual(["git_status"])
            const result = yield* reviewer.settle(call({ scope: "patch" }))
            expect(result.result.type).toBe("text")
            if (result.result.type === "text") {
              expect(result.result.value).toContain("+changed")
              expect(result.result.value).toContain("+staged")
            }

            // An omitted parent entry or an explicit reviewer deny still wins.
            expect((yield* registry.materialize([], { mode: "explicit", entries: {} })).definitions).toEqual([])
            const denied = yield* registry.materialize(
              [...reviewerRules, { action: "git_status", resource: "*", effect: "deny" }],
              policy.tools,
            )
            expect(denied.definitions).toEqual([])
          }),
        ),
      ),
    ),
  )

  it.live("never executes repository fsmonitor, external diff or textconv callbacks", () =>
    Effect.promise(() => tmpdir()).pipe(
      Effect.flatMap((tmp) =>
        withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const marker = path.join(tmp.path, "callback-ran")
            yield* Effect.sync(() => {
              seedRepo(tmp.path)
              const hook = path.join(tmp.path, "callback.js")
              fs.writeFileSync(hook, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed")`)
              const command = `"${process.execPath.replaceAll("\\", "/")}" "${hook.replaceAll("\\", "/")}"`
              git(tmp.path, ["config", "core.fsmonitor", command])
              git(tmp.path, ["config", "diff.external", command])
              git(tmp.path, ["config", "diff.fixture.textconv", command])
              git(tmp.path, ["config", "color.ui", "always"])
              fs.writeFileSync(path.join(tmp.path, ".gitattributes"), "tracked.txt diff=fixture\n")
            })
            const index = fs.readFileSync(path.join(tmp.path, ".git", "index"))
            const result = yield* settleTool(registry, call({ scope: "patch" }))
            expect(result.result.type).toBe("text")
            if (result.result.type === "text") {
              expect(result.result.value).toContain("+changed")
              expect(result.result.value).toContain("+staged")
              expect(result.result.value).not.toContain("\u001b[")
            }
            expect(fs.existsSync(marker)).toBe(false)
            expect(fs.readFileSync(path.join(tmp.path, ".git", "index"))).toEqual(index)
          }),
        ),
      ),
    ),
  )

  it.live("marks capture loss instead of presenting a bounded patch as complete", () =>
    Effect.promise(() => tmpdir()).pipe(
      Effect.flatMap((tmp) =>
        withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              seedRepo(tmp.path)
              fs.writeFileSync(path.join(tmp.path, "tracked.txt"), "large changed line\n".repeat(4000))
            })
            const result = yield* settleTool(registry, call({ scope: "patch" }))
            expect(result.output?.structured).toMatchObject({ scope: "patch", truncated: true })
            expect(result.result.type).toBe("text")
            if (result.result.type === "text") expect(result.result.value).toContain("output truncated")
          }),
        ),
      ),
    ),
  )

  it.live("ignores inherited Git repository and config redirection", () =>
    Effect.promise(() => tmpdir()).pipe(
      Effect.flatMap((tmp) =>
        withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => seedRepo(tmp.path))
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                const overrides = {
                  GIT_DIR: path.join(tmp.path, "nonexistent-repository"),
                  GIT_WORK_TREE: path.join(tmp.path, "nonexistent-worktree"),
                  GIT_INDEX_FILE: path.join(tmp.path, "nonexistent-index"),
                  GIT_CONFIG_COUNT: "1",
                  GIT_CONFIG_KEY_0: "core.bare",
                  GIT_CONFIG_VALUE_0: "true",
                }
                const previous = Object.keys(overrides).map((key) => [key, process.env[key]] as const)
                Object.assign(process.env, overrides)
                return previous
              }),
              (previous) =>
                Effect.sync(() => {
                  for (const [key, value] of previous) {
                    if (value === undefined) delete process.env[key]
                    else process.env[key] = value
                  }
                }),
            )
            const result = yield* settleTool(registry, call({ scope: "patch" }))
            expect(result.result.type).toBe("text")
            if (result.result.type === "text") {
              expect(result.result.value).toContain("## main")
              expect(result.result.value).toContain("+changed")
              expect(result.result.value).toContain("+staged")
            }
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
