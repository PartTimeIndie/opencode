import { describe, expect, test } from "bun:test"
import {
  implementationModelPreferenceKey,
  initialHandoffModelMode,
  initialImplementationModel,
  parseModelRef,
  readImplementationModelPreference,
  resolveHandoffModelTarget,
  writeImplementationModelPreference,
} from "./agent-handoff-model"

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  }
}

describe("agent handoff", () => {
  test("stores an implementation model independently for each canonical target agent", () => {
    const storage = memoryStorage()
    const build = implementationModelPreferenceKey("local", "C:/project", "build")
    const admin = implementationModelPreferenceKey("local", "C:/project", "pu-bot-admin")
    writeImplementationModelPreference(storage, build, { ref: "openai/gpt-5", variant: "high" })
    writeImplementationModelPreference(storage, admin, { ref: "crng/gpt-oss" })
    expect(readImplementationModelPreference(storage, build)).toEqual({ ref: "openai/gpt-5", variant: "high" })
    expect(readImplementationModelPreference(storage, admin)).toEqual({ ref: "crng/gpt-oss", variant: undefined })
  })

  test("does not mistake an invalid model reference for a model", () => {
    expect(parseModelRef("openai/gpt-5")).toEqual({ providerID: "openai", id: "gpt-5" })
    expect(parseModelRef("missing-provider")).toBeUndefined()
  })

  test("ignores corrupt preference storage", () => {
    const storage = { getItem: () => "not-json" }
    expect(readImplementationModelPreference(storage, "agent")).toBeUndefined()
  })

  test("a remembered implementation model is the next default even for an ordinary planning-model action", () => {
    const remembered = { ref: "openai/gpt-5", variant: "high" }
    expect(initialHandoffModelMode("planning-model", remembered)).toBe("implementation-model")
    expect(initialImplementationModel(undefined, remembered)).toEqual(remembered)
  })

  test("the first handoff defaults to the originating planning model", () => {
    expect(initialHandoffModelMode("planning-model", undefined)).toBe("planning-model")
  })

  test("an explicitly supplied implementation model wins deterministically", () => {
    const remembered = { ref: "openai/old" }
    const supplied = { ref: "openai/new", variant: "medium" }
    expect(initialHandoffModelMode("implementation-model", remembered)).toBe("implementation-model")
    expect(initialImplementationModel(supplied, remembered)).toEqual(supplied)
  })

  test("prefers the target agent then global default chain over stale remembered handoff preferences", () => {
    const remembered = { ref: "chain:old" }
    expect(initialImplementationModel(undefined, remembered, "glm-chain")).toEqual({ ref: "chain:glm-chain" })
    expect(initialImplementationModel(undefined, remembered, "glm-chain", { ref: "chain:build" })).toEqual({ ref: "chain:build" })
    expect(initialImplementationModel({ ref: "model:openai/manual" }, remembered, "glm-chain", { ref: "chain:build" })).toEqual({ ref: "model:openai/manual" })
    expect(initialHandoffModelMode("planning-model", { ref: "chain:glm-chain" })).toBe("implementation-model")
  })

  test("preserves a selected chain as the handoff model target", () => {
    expect(
      resolveHandoffModelTarget("chain:astra-chain", undefined, [
        {
          id: "astra-chain",
          name: "Astra Chain",
          steps: [
            { providerID: "openai", modelID: "astra", variant: "high" },
            { providerID: "zai", modelID: "glm-5.3" },
          ],
        },
      ]),
    ).toEqual({
      providerID: "openai",
      id: "astra",
      variant: "high",
      chain: {
        id: "astra-chain",
        name: "Astra Chain",
        active: 0,
        steps: [
          { providerID: "openai", id: "astra", variant: "high" },
          { providerID: "zai", id: "glm-5.3" },
        ],
      },
    })
  })
})
