import { describe, expect, test } from "bun:test"
import { parseDesktopTestingModel, parseDesktopTestingSessionModelFlag } from "../script/desktop-testing-model"

describe("desktop testing model parser", () => {
  test("preserves nested provider model IDs", () => {
    expect(parseDesktopTestingModel("openrouter/stealth/ox-alpha")).toEqual({
      providerID: "openrouter",
      modelID: "stealth/ox-alpha",
    })
  })

  test("builds the explicit sidecar model instead of silently falling back to the desktop default", () => {
    expect(parseDesktopTestingSessionModelFlag("openrouter/openrouter/free")).toEqual({
      providerID: "openrouter",
      id: "openrouter/free",
    })
    expect(parseDesktopTestingSessionModelFlag("openai/gpt-5.6-luna", "low")).toEqual({
      providerID: "openai",
      id: "gpt-5.6-luna",
      variant: "low",
    })
  })

  test("rejects missing provider or model IDs", () => {
    expect(() => parseDesktopTestingModel("stealth")).toThrow("--model must use provider/model")
    expect(() => parseDesktopTestingModel("/stealth")).toThrow("--model must use provider/model")
    expect(() => parseDesktopTestingModel("openrouter/")).toThrow("--model must use provider/model")
  })
})
