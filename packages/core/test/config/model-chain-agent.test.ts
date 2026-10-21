import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigModelChain } from "../../src/config/model-chain"

const chains = Schema.decodeUnknownSync(ConfigModelChain.Info)([
  {
    id: "planning",
    name: "Planning Chain",
    steps: [
      { providerID: "openai", modelID: "astra", variant: "high" },
      { providerID: "zai", modelID: "glm", variant: "medium" },
    ],
  },
])

describe("agent model targets", () => {
  test("resolves an agent chain to its full model reference", () => {
    expect(ConfigModelChain.agentTarget("chain:planning", chains)).toMatchObject({
      id: "astra",
      providerID: "openai",
      variant: "high",
      chain: {
        id: "planning",
        name: "Planning Chain",
        active: 0,
        steps: [
          { id: "astra", providerID: "openai", variant: "high" },
          { id: "glm", providerID: "zai", variant: "medium" },
        ],
      },
    })
  })

  test("keeps legacy and explicit single-model targets as single models", () => {
    expect(ConfigModelChain.agentTarget("openai/gpt-5", chains)).toMatchObject({ id: "gpt-5", providerID: "openai" })
    expect(ConfigModelChain.agentTarget("model:openai/gpt-5", chains)).toMatchObject({ id: "gpt-5", providerID: "openai" })
  })

  test("rejects a missing or deleted chain instead of silently using its first step", () => {
    expect(() => ConfigModelChain.agentTarget("chain:missing", chains)).toThrow("Unknown agent model chain: missing")
    expect(() => ConfigModelChain.agentTarget("chain:planning", [])).toThrow("Unknown agent model chain: planning")
    expect(() => ConfigModelChain.agentTarget("chain:", chains)).toThrow("Invalid agent model chain")
  })
})
