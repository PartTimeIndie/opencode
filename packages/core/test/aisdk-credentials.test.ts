import { expect } from "bun:test"
import { DateTime, Effect, Layer, Option } from "effect"
import { AISDK } from "@opencode-ai/core/aisdk"
import { Catalog } from "@opencode-ai/core/catalog"
import { Credential } from "@opencode-ai/core/credential"
import { EventV2 } from "@opencode-ai/core/event"
import { Integration } from "@opencode-ai/core/integration"
import { ModelV2 } from "@opencode-ai/core/model"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginBoot } from "@opencode-ai/core/plugin/boot"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { LLM } from "@opencode-ai/llm"
import { LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { testEffect } from "./lib/effect"
import { CerebrasPlugin } from "./plugin/provider-packages"
import { model, withEnv } from "./plugin/provider-helper"

const services = AISDK.layer.pipe(Layer.provideMerge(PluginV2.locationLayer.pipe(Layer.provide(EventV2.defaultLayer))))
const it = testEffect(services)

function credential(key: string, integrationID = "cerebras") {
  return new Credential.Stored({
    id: Credential.ID.create(),
    integrationID: Integration.ID.make(integrationID),
    label: "fixture",
    value: new Credential.Key({ type: "key", key }),
  })
}

function fixture(apiKey?: string) {
  const authorizations: (string | null)[] = []
  const selected = model("cerebras", "qwen-fixture", {
    api: { id: ModelV2.ID.make("qwen-fixture"), type: "aisdk", package: "@ai-sdk/cerebras" },
    request: {
      headers: {},
      body: {
        ...(apiKey ? { apiKey } : {}),
        fetch: async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          authorizations.push(new Headers(init?.headers).get("authorization"))
          if (typeof init?.body === "string" && JSON.parse(init.body).stream) {
            return new Response(
              `data: ${JSON.stringify({
                id: "fixture",
                created: 0,
                model: "qwen-fixture",
                choices: [{ index: 0, delta: { content: "Ready" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              })}\n\ndata: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            )
          }
          return Response.json({
            id: "fixture",
            created: 0,
            model: "qwen-fixture",
            choices: [{ index: 0, message: { role: "assistant", content: "Ready" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        },
      },
    },
  })
  return { selected, authorizations }
}

it.effect("passes a stored Cerebras key to the real SDK without copying it into the catalog", () =>
  withEnv({ CEREBRAS_API_KEY: undefined }, () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      yield* plugin.add(CerebrasPlugin)
      const input = fixture()
      const language = yield* aisdk.language(input.selected, credential("stored-key"))
      const result = yield* Effect.promise(() =>
        language.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }] }),
      )
      expect(result.content).toContainEqual({ type: "text", text: "Ready" })
      expect(input.authorizations).toEqual(["Bearer stored-key"])
      expect(input.selected.request.body.apiKey).toBeUndefined()
    }),
  ),
)

it.effect("preserves an explicit SDK key over a stored key", () =>
  Effect.gen(function* () {
    yield* (yield* PluginV2.Service).add(CerebrasPlugin)
    const aisdk = yield* AISDK.Service
    const input = fixture("configured-key")
    const language = yield* aisdk.language(input.selected, credential("stored-key"))
    yield* Effect.promise(() => language.doGenerate({ prompt: [] }))
    expect(input.authorizations).toEqual(["Bearer configured-key"])
  }),
)

it.effect("does not reuse a cached language after a stored key changes or is removed", () =>
  withEnv({ CEREBRAS_API_KEY: undefined }, () =>
    Effect.gen(function* () {
      yield* (yield* PluginV2.Service).add(CerebrasPlugin)
      const aisdk = yield* AISDK.Service
      const input = fixture()
      const first = credential("first-key")
      const language = yield* aisdk.language(input.selected, first)
      expect(yield* aisdk.language(input.selected, first)).toBe(language)
      yield* Effect.promise(() => language.doGenerate({ prompt: [] }))
      const rotated = yield* aisdk.language(input.selected, credential("rotated-key"))
      expect(rotated).not.toBe(language)
      yield* Effect.promise(() => rotated.doGenerate({ prompt: [] }))
      expect(input.authorizations).toEqual(["Bearer first-key", "Bearer rotated-key"])
      const removed = yield* aisdk.language(input.selected)
      expect(removed).not.toBe(rotated)
      const result = yield* Effect.tryPromise(() => removed.doGenerate({ prompt: [] })).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      expect(input.authorizations).toHaveLength(2)
    }),
  ),
)

it.effect("never gives a Cerebras SDK another provider's credential", () =>
  withEnv({ CEREBRAS_API_KEY: undefined }, () =>
    Effect.gen(function* () {
      yield* (yield* PluginV2.Service).add(CerebrasPlugin)
      const input = fixture()
      const language = yield* (yield* AISDK.Service).language(input.selected, credential("foreign-key", "groq"))
      const result = yield* Effect.tryPromise(() => language.doGenerate({ prompt: [] })).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      expect(input.authorizations).toEqual([])
    }),
  ),
)

it.effect("does not turn an OAuth credential into an API key", () =>
  withEnv({ CEREBRAS_API_KEY: undefined }, () =>
    Effect.gen(function* () {
      yield* (yield* PluginV2.Service).add(CerebrasPlugin)
      const input = fixture()
      const saved = new Credential.Stored({
        ...credential("unused"),
        value: new Credential.OAuth({
          type: "oauth",
          methodID: Integration.MethodID.make("fixture"),
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: 60000,
        }),
      })
      const language = yield* (yield* AISDK.Service).language(input.selected, saved)
      const result = yield* Effect.tryPromise(() => language.doGenerate({ prompt: [] })).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      expect(input.authorizations).toEqual([])
    }),
  ),
)

it.effect("retains environment-key fallback when there is no stored key", () =>
  withEnv({ CEREBRAS_API_KEY: "env-key" }, () =>
    Effect.gen(function* () {
      yield* (yield* PluginV2.Service).add(CerebrasPlugin)
      const input = fixture()
      const language = yield* (yield* AISDK.Service).language(input.selected)
      yield* Effect.promise(() => language.doGenerate({ prompt: [] }))
      expect(input.authorizations).toEqual(["Bearer env-key"])
    }),
  ),
)

it.effect("the Location runner forwards its resolved credential for main and small models", () =>
  withEnv({ CEREBRAS_API_KEY: undefined }, () =>
    Effect.gen(function* () {
      yield* (yield* PluginV2.Service).add(CerebrasPlugin)
      const input = fixture()
      const saved = credential("runner-key")
      const runner = SessionRunnerModel.locationLayer.pipe(
        Layer.provide(
          Layer.mock(Catalog.Service)({
            provider: {
              get: () => Effect.die("unused"),
              all: () => Effect.succeed([]),
              available: () => Effect.succeed([]),
            },
            model: {
              get: () => Effect.succeed(input.selected),
              all: () => Effect.succeed([input.selected]),
              available: () => Effect.succeed([input.selected]),
              default: () => Effect.succeed(Option.some(input.selected)),
              small: () => Effect.succeed(Option.some(input.selected)),
            },
          }),
        ),
        Layer.provide(
          Layer.mock(Integration.Service)({
            attempt: {
              status: () => Effect.die("unused"),
              complete: () => Effect.die("unused"),
              cancel: () => Effect.die("unused"),
            },
            connection: {
              list: () => Effect.succeed(new Map()),
              forIntegration: () => Effect.succeed({ type: "credential" as const, id: saved.id, label: saved.label }),
              credential: () => Effect.succeed(saved),
              key: () => Effect.die("unused"),
              oauth: () => Effect.die("unused"),
              update: () => Effect.die("unused"),
              remove: () => Effect.die("unused"),
            },
          }),
        ),
        Layer.provide(Layer.mock(PluginBoot.Service)({ wait: () => Effect.void })),
      )
      yield* Effect.gen(function* () {
        const resolver = yield* SessionRunnerModel.Service
        const session = SessionV2.Info.make({
          id: SessionV2.ID.make("ses_cerebras_credentials"),
          projectID: ProjectV2.ID.global,
          title: "test",
          model: { id: input.selected.id, providerID: input.selected.providerID },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
          location: { directory: AbsolutePath.make("/project") },
        })
        const main = yield* resolver.resolve(session)
        const small = yield* resolver.resolveSmall(session)
        expect(Option.isSome(small)).toBe(true)
        if (Option.isNone(small)) return
        for (const selected of [main, small.value]) {
          const response = yield* LLM.generate(LLM.request({ model: selected, prompt: "test" })).pipe(
            Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.defaultLayer))),
          )
          expect(response.text).toBe("Ready")
        }
      }).pipe(Effect.provide(runner))
      expect(input.authorizations).toEqual(["Bearer runner-key", "Bearer runner-key"])
    }),
  ),
)
