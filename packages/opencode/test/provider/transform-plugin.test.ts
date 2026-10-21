import { expect, test } from "bun:test"
import type { ProviderConfigurationModel, ProviderPluginModule } from "@opencode-ai/plugin/provider"
import { ProviderTransform } from "../../src/provider/transform"

function model(): ProviderConfigurationModel {
  return {
    id: "neutral",
    providerID: "example",
    name: "Neutral",
    family: "",
    api: { id: "neutral", npm: "example-sdk", url: "" },
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 1000, output: 100 },
    status: "active",
    options: {},
    headers: {},
    release_date: "",
    variants: {},
  }
}

test("a neutral provider's public rules are isolated, overrideable, and survive model copies", () => {
  const controller = new AbortController()
  const first: ProviderPluginModule = {
    id: "first",
    async provider() {},
    transforms: {
      temperature: () => 0.4,
      variants: (input) => {
        expect(Object.getOwnPropertySymbols(input)).toEqual([])
        return { careful: { budget: 7 } }
      },
      chatMaxOutputTokens: () => undefined,
    },
  }
  const second: ProviderPluginModule = { id: "second", async provider() {}, transforms: { temperature: () => 0.8 } }
  const bound = ProviderTransform.bindModel(model(), [first, second], controller.signal)
  expect(ProviderTransform.temperature({ ...bound })).toBe(0.8)
  expect(ProviderTransform.variants(bound)).toEqual({ careful: { budget: 7 } })
  expect(ProviderTransform.chatMaxOutputTokens(bound)).toBeUndefined()
  expect(ProviderTransform.temperature(model())).toBeUndefined()
  expect(ProviderTransform.chatMaxOutputTokens(model())).toBe(100)
  expect(JSON.parse(JSON.stringify(bound))).toEqual(model())
  controller.abort(new Error("Plugin disposed"))
  expect(() => ProviderTransform.temperature({ ...bound })).toThrow("Plugin disposed")
})
