import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "../src/config"
import { ConfigModelChain } from "../src/config/model-chain"
import { ConfigV1 } from "../src/v1/config/config"
import { ConfigMigrateV1 } from "../src/v1/config/migrate"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"

const settings = {
  model_chains: [{
    id: "default",
    name: "Default",
    steps: [{ providerID: "one", modelID: "primary" }, { providerID: "two", modelID: "fallback" }],
  }],
  default_model_chain: "default",
}

describe("model chain config", () => {
  test("switches freely between configured chains and a direct model", () => {
    const chains = Schema.decodeUnknownSync(ConfigModelChain.Info)([
      { id: "first", name: "First", steps: [{ providerID: "one", modelID: "primary" }] },
      { id: "second", name: "Second", steps: [{ providerID: "two", modelID: "other", variant: "high" }] },
    ])
    const first = ConfigModelChain.resolve({ chains, chainID: "first", model: undefined, single: false })
    expect(first?.chain?.id).toBe("first")
    const second = ConfigModelChain.resolve({ chains, chainID: "second", model: undefined, single: false })
    expect(second).toMatchObject({ providerID: "two", id: "other", variant: "high", chain: { id: "second" } })
    const direct = ConfigModelChain.resolve({ chains, chainID: "second", model: second, single: true })
    expect(direct).toEqual(ModelV2.Ref.make({
      providerID: ProviderV2.ID.make("two"), id: ModelV2.ID.make("other"), variant: ModelV2.VariantID.make("high"),
    }))
    const chosen = ModelV2.Ref.make({ providerID: ProviderV2.ID.make("cerebras"), id: ModelV2.ID.make("chosen") })
    expect(ConfigModelChain.resolve({ chains, chainID: "first", model: chosen, single: false })).toEqual(chosen)
  })

  test("selects only the configured default chain steps", () => {
    const chains = Schema.decodeUnknownSync(ConfigModelChain.Info)([
      { id: "unrelated", name: "Unrelated", steps: [{ providerID: "other", modelID: "wrong" }] },
      {
        id: "default",
        name: "Default",
        steps: [
          { providerID: "openai", modelID: "gpt-5.6-sol", variant: "high" },
          { providerID: "zai", modelID: "glm-5.3" },
        ],
      },
    ])
    expect(ConfigModelChain.selectedSteps({ chains, chainID: "default" })).toEqual([
      {
        providerID: ProviderV2.ID.make("openai"),
        modelID: ModelV2.ID.make("gpt-5.6-sol"),
        variant: ModelV2.VariantID.make("high"),
      },
      { providerID: ProviderV2.ID.make("zai"), modelID: ModelV2.ID.make("glm-5.3") },
    ])
    expect(ConfigModelChain.selectedSteps({ chains, chainID: "retired" })).toBeUndefined()
  })

  test("decodes model chains in V2 while ignoring future keys", () => {
    expect(Schema.decodeUnknownSync(Config.Info)({ ...settings, future_setting: true })).toMatchObject(settings)
  })

  test("preserves V1 model chains through migration while ignoring future keys", () => {
    const decoded = Schema.decodeUnknownSync(ConfigV1.Info)({ ...settings, future_setting: true })
    expect(ConfigMigrateV1.migrate(decoded)).toMatchObject(settings)
  })

  test("matches repeated models by variant and rejects an absent agent variant", () => {
    const chains = Schema.decodeUnknownSync(ConfigModelChain.Info)([{
      id: "variants",
      name: "Variants",
      steps: [
        { providerID: "one", modelID: "primary", variant: "low" },
        { providerID: "one", modelID: "primary", variant: "high" },
      ],
    }])
    expect(ConfigModelChain.resolve({
      chains,
      chainID: "variants",
      model: ModelV2.Ref.make({
        providerID: ProviderV2.ID.make("one"),
        id: ModelV2.ID.make("primary"),
        variant: ModelV2.VariantID.make("high"),
      }),
      single: false,
    })).toMatchObject({ chain: { active: 1 } })
    expect(ConfigModelChain.resolve({
      chains,
      chainID: "variants",
      model: ModelV2.Ref.make({
        providerID: ProviderV2.ID.make("one"),
        id: ModelV2.ID.make("primary"),
        variant: ModelV2.VariantID.make("max"),
      }),
      single: false,
    })?.chain).toBeUndefined()
  })
})
