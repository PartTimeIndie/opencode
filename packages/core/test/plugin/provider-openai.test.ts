import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { Integration } from "@opencode-ai/core/integration"
import { ModelV2 } from "@opencode-ai/core/model"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { OpenAIPlugin } from "./provider-packages"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { fakeSelectorSdk, it, model, provider } from "./provider-helper"

function add(plugin: PluginV2.Interface, integrations: Integration.Interface) {
  return plugin.add({
    ...OpenAIPlugin,
    effect: OpenAIPlugin.effect.pipe(Effect.provideService(Integration.Service, integrations)),
  })
}

describe("OpenAIPlugin", () => {
  it.effect("registers browser and headless ChatGPT OAuth methods", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      yield* add(plugin, yield* Integration.Service)
      expect((yield* (yield* Integration.Service).get(Integration.ID.make("openai")))?.methods).toEqual([
        {
          id: Integration.MethodID.make("chatgpt-browser"),
          type: "oauth",
          label: "ChatGPT Pro/Plus (browser)",
        },
        {
          id: Integration.MethodID.make("chatgpt-headless"),
          type: "oauth",
          label: "ChatGPT Pro/Plus (headless)",
        },
      ])
    }),
  )

  it.effect("creates an OpenAI SDK for @ai-sdk/openai using the provider ID as SDK name", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      yield* add(plugin, yield* Integration.Service)
      const result = yield* plugin.trigger(
        "aisdk.sdk",
        {
          model: model("custom-openai", "gpt-5"),
          package: "@ai-sdk/openai",
          options: { name: "custom-openai", apiKey: "test" },
        },
        {},
      )
      expect(result.sdk?.responses("gpt-5").provider).toBe("custom-openai.responses")
    }),
  )

  it.effect("ignores non-OpenAI SDK packages", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      yield* add(plugin, yield* Integration.Service)
      const result = yield* plugin.trigger(
        "aisdk.sdk",
        { model: model("openai", "gpt-5"), package: "@ai-sdk/openai-compatible", options: { name: "openai" } },
        {},
      )
      expect(result.sdk).toBeUndefined()
    }),
  )

  it.effect("uses the Responses API for language models", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const calls: string[] = []
      yield* add(plugin, yield* Integration.Service)
      const result = yield* plugin.trigger(
        "aisdk.language",
        {
          model: model("openai", "alias", {
            api: { id: ModelV2.ID.make("gpt-5"), type: "aisdk", package: "test-provider" },
          }),
          sdk: fakeSelectorSdk(calls),
          options: {},
        },
        {},
      )
      expect(calls).toEqual(["responses:gpt-5"])
      expect(result.language).toBeDefined()
    }),
  )

  it.effect("ignores non-OpenAI providers", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const calls: string[] = []
      yield* add(plugin, yield* Integration.Service)
      const result = yield* plugin.trigger(
        "aisdk.language",
        { model: model("anthropic", "gpt-5"), sdk: fakeSelectorSdk(calls), options: {} },
        {},
      )
      expect(calls).toEqual([])
      expect(result.language).toBeUndefined()
    }),
  )

  it.effect("disables GPT-5 chat-latest aliases during catalog transforms", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const catalog = yield* Catalog.Service
      yield* add(plugin, yield* Integration.Service)
      const transform = yield* catalog.transform()
      yield* transform((catalog) => {
        const item = provider("openai", { api: { type: "aisdk", package: "@ai-sdk/openai" } })
        catalog.provider.update(item.id, (draft) => {
          draft.api = item.api
        })
        for (const id of ["gpt-5", "gpt-5-chat-latest", "gpt-5.2-chat-latest"]) {
          const target = model("openai", id, { api: { type: "aisdk", package: "@ai-sdk/openai" } })
          catalog.model.update(item.id, target.id, (draft) => {
            draft.api = target.api
          })
        }
      })
      expect((yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5"))).enabled).toBe(true)
      expect((yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5-chat-latest"))).enabled).toBe(false)
      expect((yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5.2-chat-latest"))).enabled).toBe(
        false,
      )
    }),
  )

  it.effect("exposes GPT-6 Luna MAX in the provider catalog variants", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const catalog = yield* Catalog.Service
      yield* add(plugin, yield* Integration.Service)
      const transform = yield* catalog.transform()
      yield* transform((editor) => {
        const openai = provider("openai", { api: { type: "aisdk", package: "@ai-sdk/openai" } })
        editor.provider.update(openai.id, (draft) => {
          draft.api = openai.api
        })
        const luna = model("openai", "gpt-6-luna", {
          api: { type: "aisdk", package: "@ai-sdk/openai" },
        })
        editor.model.update(openai.id, luna.id, (draft) => {
          draft.api = luna.api
          draft.capabilities.reasoning = true
        })
      })

      const luna = yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-6-luna"))
      expect(luna.variants.find((variant) => variant.id === "max")).toMatchObject({
        id: "max",
        options: {
          reasoningEffort: "max",
          reasoningSummary: "auto",
          include: ["reasoning.encrypted_content"],
        },
      })
    }),
  )

  it.effect("classifies catalog aliases by API ID and skips non-OpenAI model transports", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const catalog = yield* Catalog.Service
      yield* add(plugin, yield* Integration.Service)
      const transform = yield* catalog.transform()
      yield* transform((editor) => {
        const openai = provider("openai", { api: { type: "aisdk", package: "@ai-sdk/openai" } })
        editor.provider.update(openai.id, (draft) => {
          draft.api = openai.api
        })
        const alias = model("openai", "luna-alias", {
          api: {
            id: ModelV2.ID.make("gpt-6-luna"),
            type: "aisdk",
            package: "@ai-sdk/openai",
          },
        })
        editor.model.update(openai.id, alias.id, (draft) => {
          draft.api = alias.api
          draft.capabilities.reasoning = true
        })
        const routed = model("openai", "gpt-6-luna", {
          api: { type: "aisdk", package: "@openrouter/ai-sdk-provider" },
        })
        editor.model.update(openai.id, routed.id, (draft) => {
          draft.api = routed.api
          draft.capabilities.reasoning = true
        })
      })

      const alias = yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("luna-alias"))
      const routed = yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-6-luna"))
      expect(alias.variants.map((variant) => String(variant.id))).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(routed.variants).toEqual([])
    }),
  )

  it.effect("applies OpenAI variants to per-model OpenAI transport overrides", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const catalog = yield* Catalog.Service
      yield* add(plugin, yield* Integration.Service)
      const transform = yield* catalog.transform()
      yield* transform((editor) => {
        const openrouter = provider("openrouter", {
          api: { type: "aisdk", package: "@openrouter/ai-sdk-provider" },
        })
        editor.provider.update(openrouter.id, (draft) => {
          draft.api = openrouter.api
        })
        const luna = model("openrouter", "luna-display-alias", {
          api: {
            id: ModelV2.ID.make("gpt-6-luna"),
            type: "aisdk",
            package: "@ai-sdk/openai",
          },
        })
        editor.model.update(openrouter.id, luna.id, (draft) => {
          draft.api = luna.api
          draft.capabilities.reasoning = true
        })
      })

      const luna = yield* catalog.model.get(ProviderV2.ID.openrouter, ModelV2.ID.make("luna-display-alias"))
      expect(luna.variants.map((variant) => String(variant.id))).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ])
      expect(luna.variants.find((variant) => variant.id === "max")).toMatchObject({
        options: {
          reasoningEffort: "max",
          reasoningSummary: "auto",
          include: ["reasoning.encrypted_content"],
        },
      })
    }),
  )

  it.effect("inherits the OpenAI provider transport when adding Luna reasoning variants", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const catalog = yield* Catalog.Service
      yield* add(plugin, yield* Integration.Service)
      const transform = yield* catalog.transform()
      yield* transform((editor) => {
        const openai = provider("openai", { api: { type: "aisdk", package: "@ai-sdk/openai" } })
        editor.provider.update(openai.id, (draft) => {
          draft.api = openai.api
        })
        const inherited = model("openai", "gpt-6-luna", { api: { type: "native", settings: {} } })
        editor.model.update(inherited.providerID, inherited.id, (draft) => {
          draft.api = inherited.api
          draft.capabilities.reasoning = true
        })
        const explicitNative = model("openai", "native-luna", {
          api: { type: "native", settings: { endpoint: "https://native.example.com" } },
        })
        editor.model.update(explicitNative.providerID, explicitNative.id, (draft) => {
          draft.api = explicitNative.api
          draft.capabilities.reasoning = true
        })
      })

      const inherited = yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-6-luna"))
      const explicitNative = yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("native-luna"))
      expect(inherited.api).toMatchObject({ type: "aisdk", package: "@ai-sdk/openai" })
      expect(inherited.variants.map((variant) => String(variant.id))).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ])
      expect(explicitNative.variants).toEqual([])
    }),
  )

  it.effect("does not disable gpt-5-chat-latest for non-OpenAI providers", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const catalog = yield* Catalog.Service
      yield* add(plugin, yield* Integration.Service)
      const transform = yield* catalog.transform()
      yield* transform((catalog) => {
        const item = provider("custom-openai")
        catalog.provider.update(item.id, () => {})
        catalog.model.update(item.id, ModelV2.ID.make("gpt-5-chat-latest"), () => {})
      })
      expect(
        (yield* catalog.model.get(ProviderV2.ID.make("custom-openai"), ModelV2.ID.make("gpt-5-chat-latest"))).enabled,
      ).toBe(true)
    }),
  )
})
