import { describe, expect, test } from "bun:test"
import { resolveRunModel } from "../../../src/cli/cmd/run/model-chain"

const chains = [
  {
    id: "default",
    name: "Default chain",
    steps: [
      { providerID: "missing", modelID: "unavailable" },
      { providerID: "test", modelID: "agent-model", variant: "high" },
      { providerID: "test", modelID: "fallback", variant: "low" },
      { providerID: "test", modelID: "plain" },
    ],
  },
]

describe("resolveRunModel", () => {
  test("selects an available agent step without removing unavailable chain steps", () => {
    const result = resolveRunModel({
      explicit: undefined,
      agent: { providerID: "test", id: "agent-model", variant: "high" },
      chains,
      defaultChainID: "default",
      providers: [
        {
          id: "test",
          models: {
            "agent-model": { variants: { high: {} } },
            fallback: { variants: { low: {} } },
            plain: {},
          },
        },
      ],
    })

    expect(result).toMatchObject({
      providerID: "test",
      id: "agent-model",
      variant: "high",
      chain: { active: 1 },
    })
    expect(result?.chain?.steps).toHaveLength(4)
    expect(result?.chain?.steps[0]).toMatchObject({ providerID: "missing", id: "unavailable" })
  })

  test("falls back in chain order when the agent step or its variant is unavailable", () => {
    const result = resolveRunModel({
      explicit: undefined,
      agent: { providerID: "outside", id: "not-in-chain" },
      chains,
      defaultChainID: "default",
      providers: [
        {
          id: "test",
          models: {
            "agent-model": { variants: {} },
            fallback: { variants: { low: {} } },
            plain: {},
          },
        },
      ],
    })

    expect(result).toMatchObject({
      providerID: "test",
      id: "fallback",
      variant: "low",
      chain: { active: 2 },
    })
  })

  test("fails clearly when no configured chain step is available", () => {
    expect(() =>
      resolveRunModel({
        explicit: undefined,
        agent: { providerID: "test", id: "agent-model", variant: "high" },
        chains,
        defaultChainID: "default",
        providers: [{ id: "test", models: { "agent-model": { variants: {} } } }],
      }),
    ).toThrow('chain-unavailable: no available steps in model chain "Default chain"')
  })

  test("keeps an explicit model chain-free without consulting availability", () => {
    const result = resolveRunModel({
      explicit: { providerID: "test", id: "explicit", variant: "high" },
      agent: { providerID: "test", id: "agent-model", variant: "high" },
      chains,
      defaultChainID: "default",
      providers: [],
    })

    expect(result).toMatchObject({ providerID: "test", id: "explicit", variant: "high" })
    expect(result?.chain).toBeUndefined()
  })
})
