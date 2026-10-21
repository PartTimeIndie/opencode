import { describe, expect, test } from "bun:test"
import { desktopTestingDefaultModel, desktopTestingPromptModel } from "./default-model"

describe("desktopTestingDefaultModel", () => {
  test("projects the configured fallback chain into the V2 model contract", () => {
    expect(desktopTestingDefaultModel({
      id: "glm-codex",
      name: "GLM Codex",
      steps: [
        { providerID: "zhipuai-coding-plan", modelID: "glm-5.3" },
        { providerID: "cursor", modelID: "gpt-5.6-sol", variant: "medium" },
      ],
    })).toEqual({
      providerID: "zhipuai-coding-plan",
      id: "glm-5.3",
      chain: {
        id: "glm-codex",
        name: "GLM Codex",
        active: 0,
        steps: [
          { providerID: "zhipuai-coding-plan", id: "glm-5.3" },
          { providerID: "cursor", id: "gpt-5.6-sol", variant: "medium" },
        ],
      },
    })
  })

  test("does not invent a model when no default chain exists", () => {
    expect(desktopTestingDefaultModel(undefined)).toBeUndefined()
  })

  test("uses the persisted direct selection when no default chain exists", () => {
    expect(desktopTestingDefaultModel(undefined, { providerID: "cursor", modelID: "gpt-5.6-luna" }, "high")).toEqual({
      providerID: "cursor",
      id: "gpt-5.6-luna",
      variant: "high",
    })
  })
})

describe("desktopTestingPromptModel", () => {
  const chain = {
    id: "standard-coder",
    name: "Standard Coder",
    steps: [
      { providerID: "zhipuai-coding-plan", modelID: "glm-5.3-flash" },
      { providerID: "cursor", modelID: "gpt-6.1-sol", variant: "medium" },
    ],
  }

  test("forwards an explicit model choice untouched", () => {
    expect(
      desktopTestingPromptModel({
        requested: { providerID: "cursor", modelID: "gpt-6.1-sol" },
        variant: "medium",
        sessionModel: { providerID: "zhipuai-coding-plan", id: "glm-5.3-flash" },
        chain,
      }),
    ).toEqual({ providerID: "cursor", id: "gpt-6.1-sol", variant: "medium" })
  })

  test("keeps a stored session model sticky by omitting the model", () => {
    expect(
      desktopTestingPromptModel({
        sessionModel: { providerID: "cursor", id: "gpt-6.1-sol" },
        chain,
      }),
    ).toBeUndefined()
  })

  test("resolves the configured default chain for a session without a model", () => {
    expect(desktopTestingPromptModel({ chain })).toEqual({
      providerID: "zhipuai-coding-plan",
      id: "glm-5.3-flash",
      chain: {
        id: "standard-coder",
        name: "Standard Coder",
        active: 0,
        steps: [
          { providerID: "zhipuai-coding-plan", id: "glm-5.3-flash" },
          { providerID: "cursor", id: "gpt-6.1-sol", variant: "medium" },
        ],
      },
    })
  })

  test("falls back to the direct selection when no default chain exists", () => {
    expect(
      desktopTestingPromptModel({ selected: { providerID: "cursor", modelID: "gpt-6.1-sol" }, selectedVariant: "high" }),
    ).toEqual({ providerID: "cursor", id: "gpt-6.1-sol", variant: "high" })
  })

  test("never invents a model when neither chain nor selection exists", () => {
    expect(desktopTestingPromptModel({})).toBeUndefined()
  })

  test("applies a caller variant to the resolved default", () => {
    expect(desktopTestingPromptModel({ chain, variant: "low" })).toEqual({
      providerID: "zhipuai-coding-plan",
      id: "glm-5.3-flash",
      variant: "low",
      chain: {
        id: "standard-coder",
        name: "Standard Coder",
        active: 0,
        steps: [
          { providerID: "zhipuai-coding-plan", id: "glm-5.3-flash" },
          { providerID: "cursor", id: "gpt-6.1-sol", variant: "medium" },
        ],
      },
    })
  })
})
