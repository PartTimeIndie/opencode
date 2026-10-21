import { test, expect } from "bun:test"
import { Effect } from "effect"
import { ToolReadBudget } from "../../../src/session/runner/tool-read-budget"
import { ToolRegistry } from "../../../src/tool/registry"

test("read budget is a no-op when disabled (baseline behavior)", () => {
  const budget = ToolReadBudget.make(false)
  for (let i = 0; i < 100; i++) {
    const result = budget.check("read")
    expect(result.exceeded).toBe(false)
    expect(result.remaining).toBe(Infinity)
  }
})

test("session budget store keeps consumed state through continuation and resets after settlement", () => {
  const store = ToolReadBudget.sessionStore()
  let created = 0
  const create = () => {
    created++
    return ToolReadBudget.make(true, 1)
  }

  const active = store.acquire("session", create)
  expect(created).toBe(1)
  expect(active.check("read").exceeded).toBe(false)

  // A compaction continuation or current steer must not replace the active budget.
  const continuation = store.acquire("session", create)
  expect(continuation).toBe(active)
  expect(created).toBe(1)
  expect(continuation.check("read").exceeded).toBe(true)

  // A terminally settled activity is the boundary for the next independent queue task.
  store.settle("session")
  expect(store.get("session")).toBeUndefined()
  const nextQueueTask = store.acquire("session", create)
  expect(nextQueueTask).not.toBe(active)
  expect(created).toBe(2)
  expect(nextQueueTask.check("read").exceeded).toBe(false)
})

test("read budget counts read-type tools and stops after the ceiling", () => {
  const budget = ToolReadBudget.make(true, 3)
  expect(budget.check("read").exceeded).toBe(false)
  expect(budget.check("read").exceeded).toBe(false)
  expect(budget.check("read").exceeded).toBe(false)
  // 4th call exceeds the budget of 3
  expect(budget.check("read").exceeded).toBe(true)
})

test("read budget only tracks read-type tools, not other tools", () => {
  const budget = ToolReadBudget.make(true, 2)
  budget.check("read")
  budget.check("read")
  // write/bash/task are not read tools, they should never trigger the read budget
  expect(budget.check("write").exceeded).toBe(false)
  expect(budget.check("bash").exceeded).toBe(false)
  expect(budget.check("task").exceeded).toBe(false)
})

test("read budget counts grep and glob as read-type tools", () => {
  const budget = ToolReadBudget.make(true, 3)
  budget.check("read")
  budget.check("grep")
  budget.check("glob")
  expect(budget.check("read").exceeded).toBe(true)
})

test("read budget counts web search and fetch tools as read-type tools", () => {
  const budget = ToolReadBudget.make(true, 2)
  expect(budget.check("websearch", { query: "OpenCode" }).exceeded).toBe(false)
  expect(budget.check("webfetch", { url: "https://example.com" }).exceeded).toBe(false)
  expect(budget.check("websearch", { query: "OpenCode" }).exceeded).toBe(true)
})

test("read budget stops repeated identical reads before the session-wide ceiling", () => {
  const budget = ToolReadBudget.make(true, 100)
  const input = { path: "src/session.ts", offset: 1, limit: 200 }
  expect(budget.check("read", input).exceeded).toBe(false)
  expect(budget.check("read", input).exceeded).toBe(false)
  expect(budget.check("read", input).exceeded).toBe(false)
  expect(budget.check("read", input).exceeded).toBe(true)
})

test("read budget permits distinct paged reads", () => {
  const budget = ToolReadBudget.make(true, 100)
  for (const offset of [1, 201, 401, 601])
    expect(budget.check("read", { path: "src/session.ts", offset, limit: 200 }).exceeded).toBe(false)
})

test("explicit tool budgets allow identical re-reads while unconfigured tools keep the loop guard", () => {
  const budget = ToolReadBudget.limited({ grep: 3, glob: 3 })
  const input = { path: "src/session.ts", offset: 1, limit: 200 }
  // read has no explicit ceiling here, so the identical-read loop guard still applies
  expect(budget.check("read", input).exceeded).toBe(false)
  expect(budget.check("read", input).exceeded).toBe(false)
  expect(budget.check("read", input).exceeded).toBe(false)
  expect(budget.check("read", input).exceeded).toBe(true)
})

test("poll budget detects repeated identical polling calls as a self-loop", () => {
  const budget = ToolReadBudget.make(true, 100, 3)
  const args = { command: "Get-Process opencode" }
  expect(budget.check("bash", args).exceeded).toBe(false)
  expect(budget.check("bash", args).exceeded).toBe(false)
  expect(budget.check("bash", args).exceeded).toBe(false)
  // 4th identical call exceeds the poll repeat ceiling of 3
  expect(budget.check("bash", args).exceeded).toBe(true)
})

test("poll budget treats different bash commands as separate, non-looping calls", () => {
  const budget = ToolReadBudget.make(true, 100, 3)
  expect(budget.check("bash", { command: "ls" }).exceeded).toBe(false)
  expect(budget.check("bash", { command: "pwd" }).exceeded).toBe(false)
  expect(budget.check("bash", { command: "echo hello" }).exceeded).toBe(false)
  // all different commands, no loop
  expect(budget.check("bash", { command: "git status" }).exceeded).toBe(false)
})

test("plugin-declared polling repetition is detected as a self-loop", () => {
  const budget = ToolReadBudget.make(true, 100, 2)
  const args = { task_id: "abc123" }
  expect(budget.check("poll", args).exceeded).toBe(false)
  expect(budget.check("poll", args).exceeded).toBe(false)
  expect(budget.check("poll", args).exceeded).toBe(true)
})

test("registry normalizes built-in and bash budget categories", () => {
  expect(ToolRegistry.budgetCategory("read", undefined, {})).toBe("read")
  expect(ToolRegistry.budgetCategory("grep", undefined, {})).toBe("read")
  expect(ToolRegistry.budgetCategory("glob", undefined, {})).toBe("read")
  expect(ToolRegistry.budgetCategory("websearch", undefined, { query: "OpenCode" })).toBe("read")
  expect(ToolRegistry.budgetCategory("webfetch", undefined, { url: "https://example.com" })).toBe("read")
  expect(ToolRegistry.budgetCategory("unclassified_plugin_tool", undefined, {})).toBe("other")
  expect(ToolRegistry.budgetCategory("bash", undefined, { command: "Get-Content package.json" })).toBe("read")
  expect(
    ToolRegistry.budgetCategory("bash", undefined, {
      command: "$p = 'packages/core/src/session/input.ts'; $lines = Get-Content -LiteralPath $p; $lines[90..365]",
    }),
  ).toBe("read")
  expect(ToolRegistry.budgetCategory("bash", undefined, { command: "git status" })).toBe("poll")
  expect(ToolRegistry.budgetCategory("bash", undefined, { command: "bun test" })).toBe("poll")
})

test("composed PowerShell reads hit the hard stop after the read budget is consumed", () => {
  const budget = ToolReadBudget.make(true, 1)
  const command = `$paths = @('packages/llm/src/route/transport/index.ts','packages/llm/src/schema/events.ts'); foreach ($path in $paths) { if (Test-Path -LiteralPath $path) { Write-Output "===== $path ====="; Get-Content -LiteralPath $path } }; Write-Output '===== refs ====='; rg -n 'ai' package.json`
  const check = (value: string) => budget.check(ToolRegistry.budgetCategory("bash", undefined, { command: value }), { command: value })

  expect(check(command).exceeded).toBe(false)
  expect(check(command).exceeded).toBe(true)
})

test("normalized bash reads hit the hard stop while normal commands remain available", () => {
  const budget = ToolReadBudget.make(true, 1, 3)
  const check = (command: string) => {
    const category = ToolRegistry.budgetCategory("bash", undefined, { command })
    return budget.check(category, { command })
  }

  expect(check("Get-Content package.json").exceeded).toBe(false)
  for (const command of [
    "Select-String -Path package.json -Pattern name",
    "rg ToolReadBudget packages/core",
    "cat package.json",
    "type package.json",
    "git grep ToolReadBudget packages/core",
    "git show HEAD -- package.json",
    "git log -p -1 HEAD -- packages/core",
  ])
    expect(check(command).exceeded).toBe(true)

  expect(check("git status").exceeded).toBe(false)
  expect(check("bun test packages/core/test/session/runner/tool-read-budget.test.ts").exceeded).toBe(false)
  expect(check("rm generated.txt").exceeded).toBe(false)
})

test("git content commands cannot bypass a consumed bash read budget", () => {
  const budget = ToolReadBudget.make(true, 1, 8)
  const check = (command: string) => {
    const category = ToolRegistry.budgetCategory("bash", undefined, { command })
    return budget.check(category, { command })
  }

  expect(check("git diff -- packages/core").exceeded).toBe(false)
  for (const command of [
    "git grep ToolReadBudget packages/core",
    "git show HEAD -- package.json",
    "git log --oneline --all -- packages/core",
    "git blame packages/core/src/permission/shell-command-access.ts",
    "git cat-file -p HEAD:package.json",
  ])
    expect(check(command).exceeded).toBe(true)

  expect(check("git status").exceeded).toBe(false)
  expect(check("git add packages/core").exceeded).toBe(false)
  expect(check("bun test packages/core/test/session/runner/tool-read-budget.test.ts").exceeded).toBe(false)
})

test("materialized registry categories keep web and assigned bash reads in the hard budget", async () => {
  const materialization = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      return yield* registry.materialize()
    }).pipe(Effect.provide(ToolRegistry.defaultLayer)),
  )
  const budget = ToolReadBudget.make(true, 2)
  const check = (name: string, input: unknown) => budget.check(materialization.budgetCategory({ name, input }), input)

  expect(check("websearch", { query: "OpenCode" }).exceeded).toBe(false)
  expect(check("webfetch", { url: "https://example.com" }).exceeded).toBe(false)
  expect(
    check("bash", {
      command: "$p = 'packages/core/src/session/input.ts'; $lines = Get-Content -LiteralPath $p; $lines[90..365]",
    }).exceeded,
  ).toBe(true)
})
