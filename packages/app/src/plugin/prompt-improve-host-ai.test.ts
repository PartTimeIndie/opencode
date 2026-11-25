import { describe, expect, test } from "bun:test"
import path from "node:path"

const { DEFAULT_SETTINGS, cleanImprovedPrompt, normalizeSettings, promptImproveAIRequest, promptImproveMaxTokens, promptImproveUserPrompt } = await import(
  `${path.resolve("../../.opencode/plugin-sources/prompt-improve-app/index.js")}?test=${Date.now()}`
)

describe("prompt-improve-app host AI model-target contract", () => {
  test("reserves output capacity for reasoning as well as the visible rewrite", () => {
    expect(promptImproveMaxTokens("short")).toBe(8192)
    expect(promptImproveMaxTokens("x".repeat(20_000))).toBe(14_096)
    expect(promptImproveMaxTokens("x".repeat(40_000))).toBe(16_384)
  })

  test("uses a configured chain and trims its reference", () => {
    expect(promptImproveAIRequest(normalizeSettings({ modelChain: " chain:rewrite-chain " }))).toEqual({
      chain: "rewrite-chain",
    })
  })

  test("uses a configured direct model without collapsing it into a chain", () => {
    expect(promptImproveAIRequest(normalizeSettings({ modelChain: "model:zhipuai-coding-plan/glm-5.3" }))).toEqual({
      model: "zhipuai-coding-plan/glm-5.3",
    })
  })

  test("uses the Settings default chain until the runtime persists its concrete id", () => {
    expect(promptImproveAIRequest(normalizeSettings({}))).toEqual({ chain: "default" })
  })

  test("unrelated legacy settings do not override the durable default target", () => {
    expect(promptImproveAIRequest(normalizeSettings({ model: "legacy/provider", useDefaultChain: false }))).toEqual({
      chain: "default",
    })
  })

  test("normalizes an empty chain to the safe default reference", () => {
    expect(normalizeSettings({ modelChain: "   " })).toMatchObject({ modelChain: "chain:default" })
  })
})

describe("prompt-improve-app clean formatting contract", () => {
  test("the default rewrite instructions always demand clean flowing-text formatting", () => {
    const template = DEFAULT_SETTINGS.promptTemplate
    expect(template).toContain("{prompt}")
    expect(template).toContain("blank lines")
    expect(template).toContain("numbered lists")
    expect(template).toContain("bulleted lists")
    expect(template).toContain("Markdown bold")
    expect(template).toContain("Never bold")
    expect(template).toContain("fenced code blocks")
  })

  test("the default template reaches the rewrite model around the draft prompt", () => {
    const userPrompt = promptImproveUserPrompt("Fix the login bug", DEFAULT_SETTINGS.promptTemplate)
    expect(userPrompt).toContain("numbered lists")
    expect(userPrompt).toContain("Fix the login bug")
    expect(userPrompt.endsWith("Fix the login bug")).toBe(true)
  })

  test("custom templates keep working with and without a placeholder", () => {
    expect(promptImproveUserPrompt("hello", "Improve: {prompt}")).toBe("Improve: hello")
    expect(promptImproveUserPrompt("hello", "Improve this")).toContain("hello")
  })

  test("normalizes sloppy model spacing in flowing text", () => {
    const sloppy = "\n\nStart here.   \n\n\n\n- Point one\n- Point two   \n\n\nEnd.  \n"
    expect(cleanImprovedPrompt(sloppy)).toBe("Start here.\n\n- Point one\n- Point two\n\nEnd.")
  })

  test("keeps fenced code blocks byte-identical including inner blanks", () => {
    const fenced = "Intro:\n\n\n```js\nlet a = 1   \n\n\nlet b = 2\n```\n\n\n\nOutro"
    expect(cleanImprovedPrompt(fenced)).toBe("Intro:\n\n```js\nlet a = 1   \n\n\nlet b = 2\n```\n\nOutro")
  })

  test("keeps markdown emphasis the rewrite produced", () => {
    expect(cleanImprovedPrompt("**Must** pass tests.\n\nThen commit.")).toBe("**Must** pass tests.\n\nThen commit.")
  })

  test("unwraps a fully fenced answer before normalizing", () => {
    expect(cleanImprovedPrompt("```\nDo the thing.   \n```")).toBe("Do the thing.")
  })

  test("normalizes after extracting the prompt from a JSON wrapper", () => {
    expect(cleanImprovedPrompt('{"prompt": "Do it.\\n\\n\\nWith order."}')).toBe("Do it.\n\nWith order.")
  })
})
