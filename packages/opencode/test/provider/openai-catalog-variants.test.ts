import { expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import type { ModelsDev } from "@opencode-ai/core/models-dev"
import { OpenAIPlugin } from "../../../provider-plugins/openai/src/index"
import requestCompatibility from "../../../provider-plugins/request-compatibility/src/index"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"

const luna: ModelsDev.Model = {
  id: "gpt-6-luna",
  name: "GPT-6 Luna",
  release_date: "2026-09-01",
  attachment: true,
  reasoning: true,
  temperature: false,
  tool_call: true,
  limit: { context: 200_000, output: 32_000 },
  modalities: { input: ["text"], output: ["text"] },
}
const modules = [requestCompatibility, OpenAIPlugin]

test("legacy provider catalog exposes GPT-6 Luna MAX with the Responses request option", () => {
  const openai = Provider.fromModelsDevProvider(
    {
      id: "openai",
      name: "OpenAI",
      env: [],
      npm: "@ai-sdk/openai",
      models: { [luna.id]: luna },
    },
    modules,
  )

  const variants = openai.models[luna.id]?.variants
  expect(variants ? Object.keys(variants) : undefined).toEqual(["low", "medium", "high", "xhigh", "max"])
  expect(variants?.max).toEqual({
    reasoningEffort: "max",
    reasoningSummary: "auto",
    include: ["reasoning.encrypted_content"],
  })
})

test("OpenAI plugin preserves request-compatibility variants for other providers", () => {
  const opus: ModelsDev.Model = {
    ...luna,
    id: "claude-opus-4.7",
    name: "Claude Opus 4.7",
    provider: { npm: "@ai-sdk/anthropic" },
  }
  const anthropic = Provider.fromModelsDevProvider(
    {
      id: "anthropic",
      name: "Anthropic",
      env: [],
      npm: "@ai-sdk/anthropic",
      models: { [opus.id]: opus },
    },
    modules,
  )
  const openrouterModel: ModelsDev.Model = { ...luna, id: "openai/gpt-6-luna" }
  const openrouter = Provider.fromModelsDevProvider(
    {
      id: "openrouter",
      name: "OpenRouter",
      env: [],
      npm: "@openrouter/ai-sdk-provider",
      models: { [openrouterModel.id]: openrouterModel },
    },
    modules,
  )

  expect(Object.keys(anthropic.models[opus.id]?.variants ?? {})).toContain("high")
  expect(Object.keys(openrouter.models[openrouterModel.id]?.variants ?? {})).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ])
  expect(openrouter.models[openrouterModel.id]?.variants?.max).toEqual({ reasoning: { effort: "max" } })
})

test("generated Luna MAX variant passes through host options into the OpenAI SDK request", async () => {
  const openai = Provider.fromModelsDevProvider(
    {
      id: "openai",
      name: "OpenAI",
      env: [],
      npm: "@ai-sdk/openai",
      models: { [luna.id]: luna },
    },
    modules,
  )
  const model = openai.models[luna.id]
  expect(model).toBeDefined()
  if (!model) throw new Error("OpenAI Luna catalog model was not created")

  const variant = model.variants?.max
  expect(variant).toBeDefined()
  if (!variant) throw new Error("OpenAI Luna MAX variant was not generated")

  let requestBody: unknown
  const openaiSDK = createOpenAI({
    apiKey: "test",
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(await new Request(input, init).text())
        return Response.json({ error: { message: "Request captured by test" } }, { status: 400 })
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const providerOptions = ProviderTransform.providerOptions(model, {
    ...ProviderTransform.options({ model, sessionID: "test-session" }),
    ...variant,
  })

  await expect(
    openaiSDK.responses(model.api.id).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "think" }] }],
      providerOptions,
    }),
  ).rejects.toThrow()

  expect(requestBody).toMatchObject({
    model: "gpt-6-luna",
    reasoning: { effort: "max", summary: "auto" },
    include: ["reasoning.encrypted_content"],
    store: false,
  })
})
