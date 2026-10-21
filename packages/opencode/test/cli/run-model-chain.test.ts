import { describe, expect, test } from "bun:test"
import { resolveRunModel } from "../../src/cli/cmd/run/model-chain"

const chains = [{
  id: "default",
  name: "Default",
  steps: [
    { providerID: "zhipuai-coding-plan", modelID: "glm-5.3" },
    { providerID: "openai", modelID: "sol" },
  ],
}]

describe("run model admission", () => {
  test("snapshots the default chain around an agent-resolved model", () => {
    expect(resolveRunModel({
      explicit: undefined,
      agent: { providerID: "zhipuai-coding-plan", id: "glm-5.3" },
      chains,
      defaultChainID: "default",
    })).toMatchObject({
      providerID: "zhipuai-coding-plan",
      id: "glm-5.3",
      chain: { id: "default", active: 0, steps: [{ id: "glm-5.3" }, { id: "sol" }] },
    })
  })

  test("keeps an explicit model as a chain-free opt-out", () => {
    const model = resolveRunModel({
      explicit: { providerID: "zhipuai-coding-plan", id: "glm-5.3" },
      agent: undefined,
      chains,
      defaultChainID: "default",
    })
    expect(model).toMatchObject({ providerID: "zhipuai-coding-plan", id: "glm-5.3" })
    expect(model?.chain).toBeUndefined()
  })

  test("falls back to the agent model for a removed default chain", () => {
    const model = resolveRunModel({
      explicit: undefined,
      agent: { providerID: "zhipuai-coding-plan", id: "glm-5.3" },
      chains,
      defaultChainID: "removed",
    })
    expect(model).toMatchObject({ providerID: "zhipuai-coding-plan", id: "glm-5.3" })
    expect(model?.chain).toBeUndefined()
  })

  test("keeps an agent variant chain-free when the chain has no matching variant", () => {
    const model = resolveRunModel({
      explicit: undefined,
      agent: { providerID: "zhipuai-coding-plan", id: "glm-5.3" },
      chains: [{
        ...chains[0]!,
        steps: [{ providerID: "zhipuai-coding-plan", modelID: "glm-5.3", variant: "high" }],
      }],
      defaultChainID: "default",
      variant: "max",
    })
    expect(model).toMatchObject({ providerID: "zhipuai-coding-plan", id: "glm-5.3", variant: "max" })
    expect(model?.chain).toBeUndefined()
  })

  test("uses the command variant to select the matching repeated-model step", () => {
    expect(resolveRunModel({
      explicit: undefined,
      agent: { providerID: "zhipuai-coding-plan", id: "glm-5.3" },
      chains: [{
        ...chains[0]!,
        steps: [
          { providerID: "zhipuai-coding-plan", modelID: "glm-5.3", variant: "low" },
          { providerID: "zhipuai-coding-plan", modelID: "glm-5.3", variant: "high" },
        ],
      }],
      defaultChainID: "default",
      variant: "high",
    })).toMatchObject({ variant: "high", chain: { active: 1 } })
  })
})
