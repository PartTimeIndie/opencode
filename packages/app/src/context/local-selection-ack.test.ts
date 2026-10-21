import { describe, expect, test } from "bun:test"
import { classifyAgentSelectionReadback } from "./local-selection-ack"

describe("classifyAgentSelectionReadback", () => {
  const guard = {
    expected: { agent: "build", model: { providerID: "provider", modelID: "build-model" } },
    previousModel: { providerID: "provider", modelID: "plan-model" },
    baselineUpdatedAt: 100,
  }

  test.each([undefined, Number.NaN, 100, 99])("ignores a missing, invalid, or non-newer snapshot (%s)", (updatedAt) => {
    expect(
      classifyAgentSelectionReadback({
        ...guard,
        readback: { agent: "plan", model: { providerID: "provider", modelID: "plan-model" }, updatedAt },
      }),
    ).toBe("stale")
  })

  test("accepts a newer readback that confirms the acknowledged agent", () => {
    expect(
      classifyAgentSelectionReadback({
        ...guard,
        readback: {
          agent: "build",
          model: { providerID: "provider", modelID: "build-model" },
          updatedAt: 101,
        },
      }),
    ).toBe("confirmed")
  })

  test("holds an agent-only event until its matching model update arrives", () => {
    expect(
      classifyAgentSelectionReadback({
        ...guard,
        readback: {
          agent: "build",
          model: { providerID: "provider", modelID: "plan-model" },
          updatedAt: 101,
        },
      }),
    ).toBe("intermediate")
  })

  test("distinguishes a newer external handoff from the selected agent", () => {
    expect(
      classifyAgentSelectionReadback({
        ...guard,
        readback: {
          agent: "review",
          model: { providerID: "provider", modelID: "review-model" },
          updatedAt: 102,
        },
      }),
    ).toBe("external")
  })

  test("treats a newer model different from both the target and prior state as external", () => {
    expect(
      classifyAgentSelectionReadback({
        ...guard,
        readback: {
          agent: "build",
          model: { providerID: "provider", modelID: "review-model" },
          updatedAt: 102,
        },
      }),
    ).toBe("external")
  })
})
