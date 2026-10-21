import { describe, expect, test } from "bun:test"
import {
  migrateModelTargetSetting,
  resolveModelTargetSelection,
  shouldAutoSelectModelTarget,
} from "./settings-model-target-picker-model"

const models = [
  {
    providerID: "zhipuai-coding-plan",
    modelID: "glm-5.3",
    name: "GLM 5.3",
    capabilities: { input: { text: true } },
  },
  {
    providerID: "openrouter",
    modelID: "qwen/qwen3-asr-flash",
    name: "Qwen ASR",
    capabilities: { input: { audio: true }, output: { transcription: true } },
  },
]
const chains = [{ id: "review", name: "Review", steps: [{ providerID: "zhipuai-coding-plan", modelID: "glm-5.3" }] }]

describe("model target picker persistence", () => {
  test("keeps unavailable model and chain identifiers visible", () => {
    expect(resolveModelTargetSelection("model:openrouter/removed-tts", { chains, models })).toMatchObject({
      unavailable: true,
      label: "openrouter/removed-tts",
    })
    expect(resolveModelTargetSelection("chain:removed-speech", { chains, models })).toMatchObject({
      unavailable: true,
      label: "removed-speech",
    })
  })
  test("resolves direct models and chains from the same setting", () => {
    expect(resolveModelTargetSelection("model:zhipuai-coding-plan/glm-5.3", { chains, models }).label).toBe("GLM 5.3")
    expect(resolveModelTargetSelection("chain:review", { chains, models }).label).toBe("Review")
  })

  test("migrates legacy values once and is then idempotent", () => {
    expect(migrateModelTargetSetting({ value: "review", chainIDs: ["review"] })).toBe("chain:review")
    expect(migrateModelTargetSetting({ value: "chain:review", chainIDs: ["review"] })).toBeUndefined()
  })

  test("never replaces a valid direct model with a default chain", () => {
    expect(
      shouldAutoSelectModelTarget({
        autoSelectDefault: true,
        defaultChainID: "review",
        value: "model:zhipuai-coding-plan/glm-5.3",
        chainIDs: ["review"],
        modelKeys: ["zhipuai-coding-plan/glm-5.3"],
      }),
    ).toBeUndefined()
  })

  test("never replaces an unavailable direct model selection with the default chain", () => {
    // A provider/model list flicker (provider offline, models briefly unsynced)
    // must not silently swap the user's explicit model for the default chain.
    expect(
      shouldAutoSelectModelTarget({
        autoSelectDefault: true,
        defaultChainID: "review",
        value: "model:zhipuai-coding-plan/glm-5.3",
        chainIDs: ["review"],
        modelKeys: [],
      }),
    ).toBeUndefined()
  })

  test("never replaces an explicit chain that is momentarily unavailable", () => {
    expect(
      shouldAutoSelectModelTarget({
        autoSelectDefault: true,
        defaultChainID: "review",
        value: "chain:codex",
        chainIDs: ["review"],
        modelKeys: ["zhipuai-coding-plan/glm-5.3"],
      }),
    ).toBeUndefined()
  })

  test("fills the default chain only while no selection exists", () => {
    expect(
      shouldAutoSelectModelTarget({
        autoSelectDefault: true,
        defaultChainID: "review",
        value: "",
        chainIDs: ["review"],
        modelKeys: [],
      }),
    ).toBe("chain:review")
  })

  test("auto-selects a sole matching direct model when no chain matches", () => {
    expect(
      shouldAutoSelectModelTarget({
        autoSelectSingle: true,
        value: "",
        chainIDs: [],
        modelKeys: ["openrouter/qwen/qwen3-asr-flash"],
      }),
    ).toBe("model:openrouter/qwen/qwen3-asr-flash")
  })

  test("keeps the dynamic default reference while the default is valid", () => {
    expect(
      shouldAutoSelectModelTarget({
        autoSelectDefault: true,
        defaultChainID: "review",
        value: "chain:default",
        chainIDs: ["review"],
        modelKeys: [],
      }),
    ).toBeUndefined()
  })
})
