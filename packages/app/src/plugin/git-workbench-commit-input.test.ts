import { describe, expect, test } from "bun:test"
import path from "node:path"

const { commitAutoInput } = await import(
  `${path.resolve("../../.opencode/plugin-sources/git-workbench-app/index.js")}?chain-test=${Date.now()}`
)

const state = (settings: Record<string, unknown>) => ({ settings })

describe("git-workbench-app commitAuto model-target contract", () => {
  test("requests the persisted model chain", () => {
    expect(commitAutoInput(state({ commitChain: "chain:commit-chain" }))).toEqual({
      action: "commitAuto",
      commitTarget: "chain:commit-chain",
    })
  })

  test("requests a persisted direct model", () => {
    expect(commitAutoInput(state({ commitChain: "model:zhipuai-coding-plan/glm-5.3" }))).toEqual({
      action: "commitAuto",
      commitTarget: "model:zhipuai-coding-plan/glm-5.3",
    })
  })

  test("uses the default reference until the runtime persists its concrete id", () => {
    expect(commitAutoInput(state({}))).toEqual({ action: "commitAuto", commitTarget: "chain:default" })
  })

  test("legacy model opt-outs cannot bypass the chain", () => {
    expect(commitAutoInput(state({ useDefaultChain: false, commitModel: "legacy/model" }))).toEqual({
      action: "commitAuto",
      commitTarget: "chain:default",
    })
  })

  test("preserves caller-provided fields like the worktree directory", () => {
    expect(commitAutoInput(state({ commitChain: "chain:commit-chain" }), { directory: "C:/repo" })).toEqual({
      action: "commitAuto",
      directory: "C:/repo",
      commitTarget: "chain:commit-chain",
    })
  })
})
