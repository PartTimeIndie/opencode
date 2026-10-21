import { expect } from "bun:test"
import { Effect, Stream } from "effect"
import { LLM } from "@opencode-ai/llm"
import { Catalog } from "@opencode-ai/core/catalog"
import { ModelV2 } from "@opencode-ai/core/model"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import OpenAICompatiblePlugin from "../../../provider-plugins/openai-compatible/src/index"
import { LMStudioPlugin } from "./provider-packages"
import { it } from "./provider-helper"

it.live("LM Studio loaded context replaces stale config through the real catalog and runner adapter", () =>
  Effect.gen(function* () {
    const observed: { path: string; authorization: string | null }[] = []
    const loaded = { context: 64_000 }
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch(request) {
            observed.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization") })
            return Response.json({
              data: [
                {
                  id: "qwen-test",
                  state: "loaded",
                  type: "vlm",
                  capabilities: ["tool_use"],
                  loaded_context_length: loaded.context,
                  max_context_length: 262_144,
                },
              ],
            })
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    const plugins = yield* PluginV2.Service
    const catalog = yield* Catalog.Service
    yield* plugins.add(LMStudioPlugin)
    const transform = yield* catalog.transform()
    const configure = (editor: Catalog.Editor) => {
      editor.provider.update(ProviderV2.ID.make("lmstudio"), (provider) => {
        provider.api = { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${server.url}proxy/v1` }
        provider.request.body.apiKey = "fixture-key"
      })
      editor.model.update(ProviderV2.ID.make("lmstudio"), ModelV2.ID.make("qwen-test"), (model) => {
        model.name = "My Qwen"
        model.limit = { context: 32_000, output: 8_192 }
      })
      editor.model.update(ProviderV2.ID.make("lmstudio"), ModelV2.ID.make("my-alias"), (model) => {
        model.api = { id: ModelV2.ID.make("qwen-test"), type: "aisdk", package: "@ai-sdk/openai-compatible" }
        model.limit = { context: 16_000, output: 4_096 }
      })
    }
    yield* transform(configure)
    const selected = yield* catalog.model.get(ProviderV2.ID.make("lmstudio"), ModelV2.ID.make("qwen-test"))
    expect(selected.limit).toEqual({ context: 64_000, output: 8_192 })
    expect(selected.name).toBe("My Qwen")
    expect((yield* catalog.model.get(ProviderV2.ID.make("lmstudio"), ModelV2.ID.make("my-alias"))).limit.context).toBe(
      64_000,
    )
    expect(observed).toEqual([{ path: "/proxy/api/v0/models", authorization: "Bearer fixture-key" }])
    const resolved = yield* SessionRunnerModel.fromCatalogModel(
      selected,
      undefined,
      undefined,
      undefined,
      OpenAICompatiblePlugin.nativeModels,
    )
    expect(resolved.route.defaults.limits?.context).toBe(64_000)
    const compaction = SessionCompaction.make({
      config: [],
      events: {} as never,
      llm: { stream: () => Stream.die("unexpected summary") },
    })
    expect(
      compaction.requiresAutomaticCompaction({
        sessionID: SessionSchema.ID.make("ses_lmstudio_budget"),
        entries: [],
        model: resolved,
        request: LLM.request({ model: resolved, messages: [], tools: [] }),
        contextEstimateTokens: 37_946,
      }),
    ).toBe(false)

    loaded.context = 128_000
    yield* transform(configure)
    expect((yield* catalog.model.get(ProviderV2.ID.make("lmstudio"), ModelV2.ID.make("qwen-test"))).limit.context).toBe(
      128_000,
    )
  }),
)

it.live("LM Studio discovers loaded models without requiring a model limit in config", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: () =>
            Response.json({
              data: [
                {
                  id: "loaded",
                  state: "loaded",
                  type: "vlm",
                  loaded_context_length: 64_000,
                  capabilities: ["tool_use"],
                },
                { id: "unloaded", state: "not-loaded", type: "llm", max_context_length: 262_144 },
                { id: "embedding", state: "loaded", type: "embeddings", loaded_context_length: 2_048 },
              ],
            }),
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    yield* (yield* PluginV2.Service).add(LMStudioPlugin)
    const catalog = yield* Catalog.Service
    yield* (yield* catalog.transform())((editor) =>
      editor.provider.update(ProviderV2.ID.make("lmstudio"), (provider) => {
        provider.api = { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${server.url}v1` }
      }),
    )
    const models = yield* catalog.model.all()
    expect(models.map((model) => model.id)).toEqual([ModelV2.ID.make("loaded")])
    expect(models[0].limit.context).toBe(64_000)
    expect(models[0].capabilities).toMatchObject({ tools: true, input: ["text/*", "image/*"] })
  }),
)

for (const [name, response] of [
  ["HTTP failure", () => new Response(null, { status: 503 })],
  ["invalid JSON", () => new Response("not JSON")],
  ["invalid shape", () => Response.json({ data: {} })],
  [
    "missing loaded context",
    () => Response.json({ data: [{ id: "qwen-test", state: "loaded", max_context_length: 262_144 }] }),
  ],
  [
    "invalid loaded context",
    () =>
      Response.json({
        data: [{ id: "qwen-test", state: "loaded", loaded_context_length: -1, max_context_length: 262_144 }],
      }),
  ],
] as const) {
  it.live(`LM Studio preserves configured limits on ${name}`, () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => Bun.serve({ port: 0, fetch: response })),
        (server) => Effect.sync(() => server.stop(true)),
      )
      yield* (yield* PluginV2.Service).add(LMStudioPlugin)
      const catalog = yield* Catalog.Service
      yield* (yield* catalog.transform())((editor) => {
        editor.provider.update(ProviderV2.ID.make("lmstudio"), (provider) => {
          provider.api = { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `${server.url}v1` }
        })
        editor.model.update(ProviderV2.ID.make("lmstudio"), ModelV2.ID.make("qwen-test"), (model) => {
          model.limit = { context: 32_000, output: 8_192 }
        })
      })
      expect((yield* catalog.model.get(ProviderV2.ID.make("lmstudio"), ModelV2.ID.make("qwen-test"))).limit).toEqual({
        context: 32_000,
        output: 8_192,
      })
    }),
  )
}
