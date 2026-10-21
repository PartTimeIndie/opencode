import path from "path"
import { describe, expect, test } from "bun:test"
import { LLM } from "@opencode-ai/llm"
import { LLMClient } from "@opencode-ai/llm/route"
import { DateTime, Effect, Layer } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { Integration } from "@opencode-ai/core/integration"
import { Credential } from "@opencode-ai/core/credential"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Location } from "@opencode-ai/core/location"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { ModelV2 } from "@opencode-ai/core/model"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { ModelsDevPlugin } from "@opencode-ai/core/plugin/models-dev"
import { openaiReasoningEfforts } from "../../../provider-plugins/openai/src/reasoning"
import { OpenAIPlugin } from "./provider-packages"
import { Policy } from "@opencode-ai/core/policy"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const events = EventV2.defaultLayer
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
)
const plugins = PluginV2.layer.pipe(Layer.provide(events))
const policy = Policy.layer.pipe(Layer.provide(locationLayer))
const connections = Credential.layer.pipe(
  Layer.fresh,
  Layer.provide(Database.layerFromPath(":memory:").pipe(Layer.fresh)),
  Layer.provide(events),
)
const integrations = Integration.locationLayer.pipe(Layer.provide(events), Layer.provide(connections))
const catalog = Catalog.layer.pipe(
  Layer.provide(Layer.mergeAll(events, locationLayer, plugins, policy, connections, integrations)),
)
const layer = Layer.mergeAll(
  catalog.pipe(Layer.provide(connections)),
  integrations,
  connections,
  events,
  locationLayer,
  plugins,
)
const it = testEffect(layer)

function reasoningModel(input: { id: string; releaseDate?: string; reasoning?: boolean }) {
  return {
    id: input.id,
    name: input.id,
    release_date: input.releaseDate ?? "2026-07-09",
    attachment: false,
    reasoning: input.reasoning ?? true,
    temperature: false,
    tool_call: true,
    limit: { context: 1_000_000, output: 128_000 },
  } satisfies ModelsDev.Model
}

describe("OpenAI reasoning effort parser", () => {
  for (const item of [
    { name: "GPT-6 Astra", id: "gpt-6-astra", expected: ["low", "medium", "high", "xhigh", "max"] },
    { name: "qualified Astra", id: "openai/gpt-6-astra", expected: ["low", "medium", "high", "xhigh", "max"] },
    { name: "canonical GPT-5", id: "gpt-5", releaseDate: "2025-08-07", expected: ["minimal", "low", "medium", "high"] },
    { name: "unversioned GPT-5 Pro", id: "gpt-5-pro", expected: ["high"] },
    { name: "versioned GPT-5 Pro", id: "gpt-5.5-pro", expected: ["medium", "high", "xhigh"] },
    { name: "GPT-5.1", id: "gpt-5.1", expected: ["none", "low", "medium", "high"] },
    { name: "GPT-5.4", id: "gpt-5.4", expected: ["none", "low", "medium", "high", "xhigh"] },
    { name: "unversioned GPT-5 Codex", id: "gpt-5-codex", expected: ["low", "medium", "high"] },
    { name: "GPT-5.1 Codex", id: "gpt-5.1-codex", expected: ["low", "medium", "high"] },
    { name: "GPT-5.1 Codex Max", id: "gpt-5.1-codex-max", expected: ["low", "medium", "high", "xhigh"] },
    { name: "GPT-5.2 Codex", id: "gpt-5.2-codex", expected: ["low", "medium", "high", "xhigh"] },
    { name: "GPT-5.3 Codex", id: "gpt-5.3-codex", expected: ["none", "low", "medium", "high", "xhigh"] },
    { name: "unversioned GPT-5 Chat", id: "gpt-5-chat-latest", expected: [] },
    { name: "versioned GPT-5 Chat", id: "gpt-5.2-chat-latest", expected: ["medium"] },
    { name: "deep research", id: "o3-deep-research", expected: ["medium"] },
    { name: "last pre-max version", id: "gpt-5.5", expected: ["none", "low", "medium", "high", "xhigh"] },
    { name: "first max version", id: "gpt-5.6-sol", expected: ["none", "low", "medium", "high", "xhigh", "max"] },
    { name: "slash-form GPT-5.6", id: "openai/gpt-5.6-sol", expected: ["none", "low", "medium", "high", "xhigh", "max"] },
    { name: "hyphen-form GPT-5.6", id: "gpt-5-6-sol", expected: ["none", "low", "medium", "high", "xhigh", "max"] },
    { name: "GPT-6 Sol", id: "gpt-6-sol", expected: ["none", "low", "medium", "high", "xhigh", "max"] },
    { name: "GPT-6.1 Sol", id: "gpt-6.1-sol", expected: ["none", "low", "medium", "high", "xhigh", "max"] },
    { name: "qualified GPT-6.1 Sol", id: "openai/gpt-6.1-sol", expected: ["none", "low", "medium", "high", "xhigh", "max"] },
    { name: "GPT-50 lookalike", id: "gpt-50", releaseDate: "2024-01-01", expected: ["low", "medium", "high"] },
    { name: "GPT-5o lookalike", id: "gpt-5o", releaseDate: "2024-01-01", expected: ["low", "medium", "high"] },
    { name: "non-reasoning GPT-5.6", id: "gpt-5.6-sol", reasoning: false, expected: [] },
  ]) {
    test(item.name, () => {
      expect(
        openaiReasoningEfforts(
          reasoningModel({ id: item.id, releaseDate: item.releaseDate, reasoning: item.reasoning }),
          "@ai-sdk/openai",
        ),
      ).toEqual(item.expected)
    })
  }

  test("non-OpenAI package", () => {
    expect(openaiReasoningEfforts(reasoningModel({ id: "gpt-5.6-sol" }), "@ai-sdk/openai-compatible")).toEqual([])
  })
})

describe("ModelsDevPlugin", () => {
  it.effect("registers key methods for providers with environment variables", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = {
          path: Flag.OPENCODE_MODELS_PATH,
          disabled: Flag.OPENCODE_DISABLE_MODELS_FETCH,
        }
        Flag.OPENCODE_MODELS_PATH = path.join(import.meta.dir, "fixtures", "models-dev.json")
        Flag.OPENCODE_DISABLE_MODELS_FETCH = true
        return previous
      }),
      () =>
        Effect.gen(function* () {
          yield* ModelsDevPlugin.effect
          const integrations = yield* Integration.Service
          expect(yield* integrations.list()).toEqual([
            new Integration.Info({
              id: Integration.ID.make("acme"),
              name: "Acme",
              methods: [
                { type: "key" },
                {
                  type: "env",
                  names: ["ACME_API_KEY"],
                },
              ],
              connections: [],
            }),
          ])
        }).pipe(Effect.provide(ModelsDev.defaultLayer)),
      (previous) =>
        Effect.sync(() => {
          Flag.OPENCODE_MODELS_PATH = previous.path
          Flag.OPENCODE_DISABLE_MODELS_FETCH = previous.disabled
        }),
    ),
  )

  it.effect("projects GPT-5.6 Sol modes and lowers Sol Pro max into the native Responses body", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = {
          path: Flag.OPENCODE_MODELS_PATH,
          disabled: Flag.OPENCODE_DISABLE_MODELS_FETCH,
        }
        Flag.OPENCODE_MODELS_PATH = path.join(import.meta.dir, "fixtures", "models-dev.json")
        Flag.OPENCODE_DISABLE_MODELS_FETCH = true
        return previous
      }),
      () =>
        Effect.gen(function* () {
          yield* (yield* PluginV2.Service).add(OpenAIPlugin)
          yield* ModelsDevPlugin.effect
          const service = yield* Catalog.Service
          const providerID = ProviderV2.ID.make("openai")
          const base = yield* service.model.get(providerID, ModelV2.ID.make("gpt-5.6-sol"))
          const fast = yield* service.model.get(providerID, ModelV2.ID.make("gpt-5.6-sol-fast"))
          const pro = yield* service.model.get(providerID, ModelV2.ID.make("gpt-5.6-sol-pro"))

          expect(base.variants.map((variant) => String(variant.id))).toEqual([
            "none",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "fast",
            "pro",
          ])
          expect(base.api).toMatchObject({
            id: "gpt-5.6-sol",
            type: "aisdk",
            package: "@ai-sdk/openai",
            url: "https://api.openai.test/v1",
          })
          expect(base.cost).toEqual([
            { input: 10, output: 60, cache: { read: 1, write: 12.5 } },
            {
              tier: { type: "context", size: 272_000 },
              input: 15,
              output: 90,
              cache: { read: 1.5, write: 18.75 },
            },
            {
              tier: { type: "context", size: 272_000 },
              input: 16,
              output: 96,
              cache: { read: 1.6, write: 20 },
            },
            {
              tier: { type: "context", size: 200_000 },
              input: 14,
              output: 84,
              cache: { read: 1.4, write: 17.5 },
            },
          ])
          expect(String(fast.api.id)).toBe("gpt-5.6-sol")
          expect(fast.request.options).toMatchObject({ serviceTier: "priority" })
          expect(fast.cost).toEqual([{ input: 20, output: 120, cache: { read: 2, write: 0 } }, ...base.cost.slice(1)])
          expect(pro.api).toMatchObject({
            id: "gpt-5.6-sol",
            type: "aisdk",
            package: "@ai-sdk/openai",
            url: "https://api.openai.test/v1",
          })
          expect(pro.request.options).toMatchObject({ reasoning: { mode: "pro" } })
          expect(pro.variants.find((variant) => String(variant.id) === "max")?.options).toMatchObject({
            reasoningEffort: "max",
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          })

          const session = SessionV2.Info.make({
            id: SessionV2.ID.make("ses_gpt56_sol_pro_max"),
            projectID: ProjectV2.ID.global,
            title: "GPT-5.6 Sol Pro max",
            model: { id: pro.id, providerID, variant: ModelV2.VariantID.make("max") },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
            location: { directory: AbsolutePath.make(import.meta.dir) },
          })
          const plugins = yield* PluginV2.Service
          const resolved = yield* SessionRunnerModel.resolve(session, pro, plugins.nativeModels())
          const prepared = yield* LLMClient.prepare<{
            model: string
            reasoning?: { effort?: string; summary?: string; mode?: string }
            include?: string[]
          }>(LLM.request({ model: resolved, prompt: "sentinel" }))

          expect(String(resolved.id)).toBe("gpt-5.6-sol")
          expect(prepared.body.model).toBe("gpt-5.6-sol")
          expect(prepared.body.reasoning).toEqual({ effort: "max", summary: "auto", mode: "pro" })
          expect(prepared.body.include).toEqual(["reasoning.encrypted_content"])
        }).pipe(Effect.provide(ModelsDev.defaultLayer)),
      (previous) =>
        Effect.sync(() => {
          Flag.OPENCODE_MODELS_PATH = previous.path
          Flag.OPENCODE_DISABLE_MODELS_FETCH = previous.disabled
        }),
    ),
  )
})
