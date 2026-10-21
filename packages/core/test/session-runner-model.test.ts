import { describe, expect } from "bun:test"
import { LLM, Model } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { Endpoint, LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { ConfigProvider, DateTime, Effect, Layer, Option } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { Headers } from "effect/unstable/http"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/core/integration"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { PluginBoot } from "@opencode-ai/core/plugin/boot"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionV2 } from "@opencode-ai/core/session"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { requestProfiles, nativeModels } from "./fixture/provider-request-profiles"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { it, testEffect } from "./lib/effect"

const fromCatalogModel = (...input: Parameters<typeof SessionRunnerModel.fromCatalogModel>) =>
  SessionRunnerModel.fromCatalogModel(input[0], input[1], input[2], input[3], nativeModels)

type Api =
  | {
      readonly type: "aisdk"
      readonly package: string
      readonly url?: string
      readonly settings?: Record<string, unknown>
    }
  | { readonly type: "native"; readonly url?: string; readonly settings: Record<string, unknown> }

type OpenAI56Body = {
  readonly model: string
  readonly store?: boolean
  readonly reasoning?: { readonly effort?: string; readonly summary?: string; readonly mode?: string }
  readonly include?: string[]
}

const model = (api: Api, variants: ModelV2.Info["variants"] = []) =>
  new ModelV2.Info({
    id: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test-provider"),
    name: "Test model",
    api: { id: ModelV2.ID.make("api-test-model"), ...api },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: {
      headers: { "x-test": "header" },
      body: { apiKey: "secret", custom_extension: { enabled: true } },
      generation: { temperature: 0.7 },
      options: { store: false, serviceTier: "priority" },
    },
    variants,
    time: { released: DateTime.makeUnsafe(0) },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 100, input: 80, output: 20 },
  })

const provider = (api: ProviderV2.Info["api"]) =>
  new ProviderV2.Info({
    id: ProviderV2.ID.make("test-provider"),
    name: "Test provider",
    api,
    request: { headers: {}, body: {} },
  })

const openAI56Model = (input: { id: string; apiID?: string; options: Record<string, unknown> }) => {
  const base = model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://api.openai.com/v1" })
  return new ModelV2.Info({
    ...base,
    id: ModelV2.ID.make(input.id),
    providerID: ProviderV2.ID.make("openai"),
    api: {
      id: ModelV2.ID.make(input.apiID ?? input.id),
      type: "aisdk",
      package: "@ai-sdk/openai",
      url: "https://api.openai.com/v1",
    },
    request: { ...base.request, variant: "max", options: input.options },
  })
}

it.effect("canonicalizes a foreign provider model before it enters the session runner", () => Effect.gen(function* () {
  class ForeignModel {
    constructor(
      readonly id: string,
      readonly provider: string,
      readonly route: typeof OpenAIChat.route,
    ) {}
  }

  const catalog = model({ type: "aisdk", package: "foreign-provider", url: "https://provider.test/v1" })
  const foreign = new ForeignModel(
    "foreign-model",
    "foreign-provider",
    OpenAIChat.route.with({ provider: "foreign-provider", endpoint: { baseURL: "https://provider.test/v1" } }),
  )
  const resolved = yield* SessionRunnerModel.fromCatalogModel(catalog, undefined, undefined, undefined, {
    "foreign-provider": { resolve: () => foreign },
  })

  expect(foreign).not.toBeInstanceOf(Model)
  expect(resolved).toBeInstanceOf(Model)
  expect(resolved).not.toBe(foreign)
  expect(LLM.request({ model: resolved, prompt: "hello" }).model).toBe(resolved)
}))

describe("SessionRunnerModel", () => {
  it.effect("executes an independently bundled native provider through the same public model contract", () => Effect.gen(function* () {
    const directory = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "opencode-native-provider-")))
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(directory, { recursive: true, force: true })))
    const build = yield* Effect.promise(() => Bun.build({
      entrypoints: [fileURLToPath(new URL("../../provider-plugins/openai/src/native.ts", import.meta.url))],
      outdir: directory, target: "bun", splitting: true,
    }))
    expect(build.success).toBe(true)
    const module = yield* Effect.promise(() => import(pathToFileURL(path.join(directory, "native.js")).href))
    const server = Bun.serve({ port: 0, fetch: () => new Response([
      { type: "response.output_text.delta", item_id: "message", delta: "Ready" },
      { type: "response.completed", response: {} },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }) })
    yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))
    const catalog = model({ type: "aisdk", package: "neutral-native", url: server.url.origin })
    const resolved = yield* SessionRunnerModel.fromCatalogModel(catalog, undefined, undefined, undefined, {
      "neutral-native": module.nativeModels["@ai-sdk/openai"],
    })
    const prepared = yield* LLMClient.prepare<{ model: string; service_tier: string }>(LLM.request({ model: resolved, prompt: "Hello" }))
    expect(prepared.body.model).toBe("api-test-model")
    expect(prepared.body.service_tier).toBe("priority")
    expect(SessionRunnerModel.requestPackage(resolved)).toBe("neutral-native")
    const response = yield* LLM.generate(LLM.request({ model: resolved, prompt: "Hello" })).pipe(
      Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.defaultLayer))),
    )
    expect(JSON.stringify(response)).toContain("Ready")
  }))

  const oauthCredential = new Credential.Stored({
    id: Credential.ID.create(),
    integrationID: Integration.ID.make("openai"),
    label: "ChatGPT",
    value: new Credential.OAuth({
      type: "oauth",
      methodID: Integration.MethodID.make("chatgpt-browser"),
      access: "oauth-access",
      refresh: "oauth-refresh",
      expires: 60_000,
      metadata: { accountID: "account-1" },
    }),
  })
  const selected = openAI56Model({
    id: "gpt-5.6",
    options: { reasoningEffort: "max", reasoningSummary: "auto" },
  })
  const oauthSmallModel = (id: string) => {
    const base = openAI56Model({ id, options: { reasoningEffort: "low" } })
    return new ModelV2.Info({
      ...base,
      request: { ...base.request, variant: undefined },
      variants: [
        {
          id: ModelV2.VariantID.make("max"),
          headers: {},
          body: {},
          generation: {},
          options: { reasoningEffort: "max" },
        },
      ],
    })
  }
  const luna = oauthSmallModel("gpt-5.6-luna")
  const sol = oauthSmallModel("gpt-5.6-sol")
  const oauthLayer = (available: { readonly luna: boolean; readonly sol: boolean }) =>
    SessionRunnerModel.locationLayer.pipe(
      Layer.provide(
        Layer.mock(Catalog.Service, {
          provider: {
            get: () => Effect.die("unused"),
            all: () => Effect.succeed([]),
            available: () => Effect.succeed([]),
          },
          model: {
            get: (_providerID, modelID) => {
              if (modelID === ModelV2.ID.make("gpt-5.6-luna"))
                return available.luna
                  ? Effect.succeed(luna)
                  : Effect.fail(new Catalog.ModelNotFoundError({ providerID: selected.providerID, modelID }))
              if (modelID === ModelV2.ID.make("gpt-5.6-sol"))
                return available.sol
                  ? Effect.succeed(sol)
                  : Effect.fail(new Catalog.ModelNotFoundError({ providerID: selected.providerID, modelID }))
              return Effect.succeed(selected)
            },
            all: () => Effect.succeed([selected, luna, sol]),
            available: () => Effect.succeed([selected, luna, sol]),
            default: () => Effect.succeed(Option.some(selected)),
            small: () => Effect.succeed(Option.some(openAI56Model({ id: "gpt-5.4-nano", options: {} }))),
          },
        }),
      ),
      Layer.provide(
        Layer.mock(Integration.Service, {
          connection: {
            list: () => Effect.succeed(new Map()),
            forIntegration: () =>
              Effect.succeed({ type: "credential", id: oauthCredential.id, label: oauthCredential.label }),
            credential: () => Effect.succeed(oauthCredential),
            key: () => Effect.die("unused"),
            oauth: () => Effect.die("unused"),
            update: () => Effect.die("unused"),
            remove: () => Effect.die("unused"),
          },
          attempt: {
            status: () => Effect.die("unused"),
            complete: () => Effect.die("unused"),
            cancel: () => Effect.die("unused"),
          },
        }),
      ),
      Layer.provide(Layer.mock(PluginBoot.Service, { wait: () => Effect.void })),
      Layer.provide(Layer.mock(PluginV2.Service, { requestProfiles: () => requestProfiles, nativeModels: () => nativeModels })),
    )
  const oauthIt = testEffect(oauthLayer({ luna: true, sol: true }))
  const oauthMissingLunaIt = testEffect(oauthLayer({ luna: false, sol: true }))
  const oauthMissingSmallIt = testEffect(oauthLayer({ luna: false, sol: false }))
  const cursorMissingIt = testEffect(
    SessionRunnerModel.locationLayer.pipe(
      Layer.provide(
        Layer.mock(Catalog.Service, {
          provider: {
            get: () => Effect.die("unused"),
            all: () => Effect.succeed([]),
            available: () => Effect.succeed([]),
          },
          model: {
            get: (providerID, modelID) =>
              Effect.fail(new Catalog.ModelNotFoundError({ providerID, modelID })),
            all: () => Effect.succeed([selected]),
            available: () => Effect.succeed([selected]),
            default: () => Effect.succeed(Option.some(selected)),
            small: () => Effect.succeed(Option.none()),
          },
        }),
      ),
      Layer.provide(
        Layer.mock(Integration.Service, {
          connection: {
            list: () => Effect.succeed(new Map()),
            forIntegration: () => Effect.succeed(undefined),
            credential: () => Effect.die("unused"),
            key: () => Effect.die("unused"),
            oauth: () => Effect.die("unused"),
            update: () => Effect.die("unused"),
            remove: () => Effect.die("unused"),
          },
          attempt: {
            status: () => Effect.die("unused"),
            complete: () => Effect.die("unused"),
            cancel: () => Effect.die("unused"),
          },
        }),
      ),
      Layer.provide(Layer.mock(PluginBoot.Service, { wait: () => Effect.void })),
    ),
  )

  oauthIt.effect("uses the known-compatible OAuth title model without inheriting the main max variant", () =>
    Effect.gen(function* () {
      const service = yield* SessionRunnerModel.Service
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_oauth_small_model"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: { id: selected.id, providerID: selected.providerID, variant: ModelV2.VariantID.make("max") },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = Option.getOrThrow(yield* service.resolveSmall(session))
      const prepared = yield* LLMClient.prepare<OpenAI56Body>(LLM.request({ model: resolved, prompt: "Title" }))

      expect(String(resolved.id)).toBe("gpt-5.6-luna")
      expect(prepared.route).toBe("openai-responses-codex")
      expect(prepared.metadata).toEqual({ transport: "http-json/codex" })
      expect(prepared.body.reasoning).toEqual({ effort: "low" })
    }),
  )

  oauthMissingLunaIt.effect("falls back to GPT-5.6 SOL without inheriting max", () =>
    Effect.gen(function* () {
      const service = yield* SessionRunnerModel.Service
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_oauth_small_model_mini"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: { id: selected.id, providerID: selected.providerID, variant: ModelV2.VariantID.make("max") },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = Option.getOrThrow(yield* service.resolveSmall(session))
      const prepared = yield* LLMClient.prepare<OpenAI56Body>(LLM.request({ model: resolved, prompt: "Title" }))

      expect(String(resolved.id)).toBe("gpt-5.6-sol")
      expect(prepared.body.reasoning).toEqual({ effort: "low" })
    }),
  )

  oauthMissingSmallIt.effect("uses the selected OAuth model instead of an incompatible generic small fallback", () =>
    Effect.gen(function* () {
      const service = yield* SessionRunnerModel.Service
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_oauth_small_model_missing"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: { id: selected.id, providerID: selected.providerID, variant: ModelV2.VariantID.make("max") },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = Option.getOrThrow(yield* service.resolveSmall(session))
      const prepared = yield* LLMClient.prepare<OpenAI56Body>(LLM.request({ model: resolved, prompt: "Title" }))

      expect(String(resolved.id)).toBe("gpt-5.6-sol")
      expect(prepared.body.reasoning).toEqual({ effort: "max", summary: "auto" })
    }),
  )

  cursorMissingIt.effect("fails closed when the selected session model is missing", () =>
    Effect.gen(function* () {
      const service = yield* SessionRunnerModel.Service
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_cursor_missing_model"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: {
          id: ModelV2.ID.make("grok-4.6"),
          providerID: ProviderV2.ID.cursor,
          variant: ModelV2.VariantID.make("Cursor Grok 4.6 High Fast"),
        },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      expect(yield* service.resolve(session).pipe(Effect.flip)).toMatchObject({
        _tag: "CatalogV2.ModelNotFound",
        providerID: "cursor",
        modelID: "grok-4.6",
      })
    }),
  )

  it.effect("maps catalog OpenAI AI SDK models into native Responses routes", () =>
    Effect.gen(function* () {
      const resolved = yield* fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
      )

      expect(resolved).toMatchObject({ id: "api-test-model", provider: "test-provider" })
      expect(resolved.route).toMatchObject({
        id: "openai-responses",
        endpoint: { baseURL: "https://openai.example/v1" },
        defaults: {
          headers: { "x-test": "header" },
          limits: { context: 100, input: 80, output: 20 },
          generation: { temperature: 0.7 },
          providerOptions: { openai: { store: false, serviceTier: "priority" } },
          http: { body: { custom_extension: { enabled: true } } },
        },
      })
    }),
  )

  it.effect("keeps catalog apiKey credentials out of provider JSON", () =>
    Effect.gen(function* () {
      const resolved = yield* fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
      )
      const prepared = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" }))

      expect(JSON.stringify(prepared.body)).not.toContain("apiKey")
      expect(JSON.stringify(prepared.body)).not.toContain("secret")
    }),
  )

  it.effect("gates GPT-5.6 ChatGPT OAuth capabilities without changing API-key Pro requests", () =>
    Effect.gen(function* () {
      const integrationID = Integration.ID.make("openai")
      const credential = new Credential.Stored({
        id: Credential.ID.create(),
        integrationID,
        label: "ChatGPT",
        value: new Credential.OAuth({
          type: "oauth",
          methodID: Integration.MethodID.make("chatgpt-browser"),
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: 60_000,
          metadata: { accountID: "account-1", privateMarker: "must-not-leak" },
        }),
      })
      const connection = { type: "credential" as const, id: credential.id, label: credential.label }
      const max = {
        reasoningEffort: "max",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      }
      const sol = openAI56Model({ id: "gpt-5.6-sol", options: max })
      const resolved = yield* fromCatalogModel(sol, connection, credential, {
        oauthWebSocket: true,
      })
      const request = LLM.request({ model: resolved, prompt: "Hello" })
      const prepared = yield* LLMClient.prepare<OpenAI56Body>(request)
      const url = Endpoint.render(resolved.route.endpoint, { request, body: prepared.body }).toString()
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url,
        body: JSON.stringify(prepared.body),
        headers: Headers.empty,
      })

      expect(url).toBe("https://chatgpt.com/backend-api/codex/responses")
      expect(prepared.route).toBe("openai-responses-websocket")
      expect(prepared.metadata).toEqual({ transport: "websocket-json" })
      expect(headers.authorization).toBe("Bearer oauth-access")
      expect(headers["chatgpt-account-id"]).toBe("account-1")
      expect(headers.originator).toBeUndefined()
      expect(prepared.body).toMatchObject({ model: "gpt-5.6-sol", store: false })
      expect(prepared.body.reasoning).toEqual({ effort: "max", summary: "auto" })
      expect(prepared.body.include).toEqual(["reasoning.encrypted_content"])
      expect(JSON.stringify(prepared.body)).not.toContain("account-1")
      expect(JSON.stringify(prepared.body)).not.toContain("must-not-leak")

      const base = yield* fromCatalogModel(
        openAI56Model({ id: "gpt-5.6", options: max }),
        connection,
        credential,
      )
      const basePrepared = yield* LLMClient.prepare<OpenAI56Body>(LLM.request({ model: base, prompt: "Hello" }))
      const baseBody = basePrepared.body
      expect(base.route.endpoint.baseURL).toBe("https://chatgpt.com/backend-api/codex")
      expect(basePrepared.route).toBe("openai-responses-codex")
      expect(basePrepared.metadata).toEqual({ transport: "http-json/codex" })
      expect(baseBody).toMatchObject({ model: "gpt-5.6-sol", store: false })
      expect(baseBody.reasoning).toEqual({ effort: "max", summary: "auto" })

      const baseProFailure = yield* fromCatalogModel(
        openAI56Model({ id: "gpt-5.6-pro", apiID: "gpt-5.6", options: { ...max, reasoning: { mode: "pro" } } }),
        connection,
        credential,
      ).pipe(Effect.flip)
      expect(baseProFailure).toMatchObject({
        _tag: "SessionRunnerModel.NativeModelError",
        modelID: "gpt-5.6-pro",
        apiID: "gpt-5.6-sol",
        reason: "reasoning-mode",
      })

      const solPro = openAI56Model({
        id: "gpt-5.6-sol-pro",
        apiID: "gpt-5.6-sol",
        options: { ...max, reasoning: { mode: "pro" } },
      })
      const proFailure = yield* fromCatalogModel(solPro, connection, credential).pipe(Effect.flip)
      expect(proFailure).toMatchObject({
        _tag: "SessionRunnerModel.NativeModelError",
        modelID: "gpt-5.6-sol-pro",
        apiID: "gpt-5.6-sol",
        reason: "reasoning-mode",
      })
      expect(proFailure.message).toContain("use variant max")

      const apiKeyCredential = new Credential.Stored({
        ...credential,
        value: new Credential.Key({ type: "key", key: "api-key" }),
      })
      const apiKeyConnection = {
        type: "credential" as const,
        id: apiKeyCredential.id,
        label: apiKeyCredential.label,
      }
      const basePro = openAI56Model({
        id: "gpt-5.6-pro",
        apiID: "gpt-5.6",
        options: { ...max, reasoning: { mode: "pro" } },
      })
      const baseProModel = yield* fromCatalogModel(basePro, apiKeyConnection, apiKeyCredential)
      const baseProBody = (yield* LLMClient.prepare<OpenAI56Body>(
        LLM.request({ model: baseProModel, prompt: "Hello" }),
      )).body
      expect(baseProBody).toMatchObject({ model: "gpt-5.6" })
      expect(baseProBody.reasoning).toEqual({ effort: "max", summary: "auto", mode: "pro" })
      expect(baseProBody).not.toHaveProperty("store")

      const solProModel = yield* fromCatalogModel(solPro, apiKeyConnection, apiKeyCredential)
      const solProBody = (yield* LLMClient.prepare<OpenAI56Body>(LLM.request({ model: solProModel, prompt: "Hello" })))
        .body
      expect(solProModel.route.endpoint.baseURL).toBe("https://api.openai.com/v1")
      expect(solProBody).toMatchObject({ model: "gpt-5.6-sol" })
      expect(solProBody.reasoning).toEqual({ effort: "max", summary: "auto", mode: "pro" })
      expect(solProBody).not.toHaveProperty("store")
    }),
  )

  it.effect("uses merged API settings for OpenAI-compatible auth and request defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* fromCatalogModel(
        new ModelV2.Info({
          ...model({
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://compatible.example/v1",
            settings: { apiKey: "settings-secret", compatibility: "strict" },
          }),
          request: { headers: {}, body: {}, generation: {}, options: {} },
        }),
      )
      const request = LLM.request({ model: resolved, prompt: "Hello" })
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://compatible.example/v1/chat/completions",
        body: "{}",
        headers: Headers.empty,
      })

      expect(headers.authorization).toBe("Bearer settings-secret")
      expect(resolved.route.defaults.http?.body).toEqual({})
    }),
  )

  it.effect("lowers selected OpenAI Session variants into Responses options", () =>
    Effect.gen(function* () {
      const base = model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }, [
        {
          id: ModelV2.VariantID.make("high"),
          headers: { "x-variant": "high" },
          body: {},
          generation: { temperature: 0.2 },
          options: { reasoning: { mode: "pro" }, reasoningEffort: "high" },
        },
      ])
      const catalog = new ModelV2.Info({
        ...base,
        request: { ...base.request, options: { ...base.request.options, reasoningEffort: "medium" } },
      })
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_model_variant"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: {
          id: catalog.id,
          providerID: catalog.providerID,
          variant: ModelV2.VariantID.make("high"),
        },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = yield* SessionRunnerModel.resolve(session, catalog, nativeModels)
      const prepared = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" }))

      expect(resolved.route.defaults.headers).toMatchObject({ "x-test": "header", "x-variant": "high" })
      expect(resolved.route.defaults.http?.body).toEqual({ custom_extension: { enabled: true } })
      expect(prepared.body).toMatchObject({
        store: false,
        service_tier: "priority",
        temperature: 0.2,
        reasoning: { effort: "high", mode: "pro" },
      })
      expect(prepared.body).not.toHaveProperty("reasoningEffort")
    }),
  )

  it.effect("lowers selected OpenAI-compatible Session variants into Chat options", () =>
    Effect.gen(function* () {
      const catalog = model(
        { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://compatible.example/v1" },
        [
          {
            id: ModelV2.VariantID.make("high"),
            headers: {},
            body: {},
            generation: {},
            options: { reasoningEffort: "high" },
          },
        ],
      )
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_compatible_variant"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: { id: catalog.id, providerID: catalog.providerID, variant: ModelV2.VariantID.make("high") },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = yield* SessionRunnerModel.resolve(session, catalog, nativeModels)
      const prepared = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" }))

      expect(resolved.route.defaults.http?.body).toEqual({ custom_extension: { enabled: true } })
      expect(prepared.body).toMatchObject({
        store: false,
        reasoning_effort: "high",
      })
      expect(prepared.body).not.toHaveProperty("reasoningEffort")
    }),
  )

  it.effect("lowers selected Anthropic Session variants into Messages options", () =>
    Effect.gen(function* () {
      const catalog = model({ type: "aisdk", package: "@ai-sdk/anthropic", url: "https://anthropic.example/v1" }, [
        {
          id: ModelV2.VariantID.make("high"),
          headers: {},
          body: {},
          generation: {},
          options: { thinking: { type: "enabled", budgetTokens: 12000 } },
        },
      ])
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_anthropic_variant"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: { id: catalog.id, providerID: catalog.providerID, variant: ModelV2.VariantID.make("high") },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = yield* SessionRunnerModel.resolve(session, catalog, nativeModels)
      const prepared = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" }))

      expect(resolved.route.defaults.http?.body).toEqual({ custom_extension: { enabled: true } })
      expect(prepared.body).toMatchObject({
        thinking: { type: "enabled", budget_tokens: 12000 },
      })
      expect(JSON.stringify(prepared.body)).not.toContain("budgetTokens")
    }),
  )

  it.effect("maps catalog Anthropic AI SDK models into native routes", () =>
    Effect.gen(function* () {
      const resolved = yield* fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/anthropic", url: "https://anthropic.example/v1" }),
      )

      expect(resolved.route).toMatchObject({
        id: "anthropic-messages",
        endpoint: { baseURL: "https://anthropic.example/v1" },
      })
    }),
  )

  it.effect("maps catalog OpenRouter AI SDK models into the native OpenRouter route", () =>
    Effect.gen(function* () {
      const base = model({ type: "aisdk", package: "@openrouter/ai-sdk-provider" })
      const catalog = new ModelV2.Info({
        ...base,
        providerID: ProviderV2.ID.openrouter,
        api: { ...base.api, id: ModelV2.ID.make("anthropic/claude-sonnet-4") },
        request: {
          ...base.request,
          body: { apiKey: "openrouter-secret" },
          options: {
            usage: true,
            reasoning: { effort: "high" },
            promptCacheKey: "session_123",
          },
        },
      })
      const resolved = yield* fromCatalogModel(catalog)
      const request = LLM.request({ model: resolved, prompt: "Think briefly." })
      const prepared = yield* LLMClient.prepare(request)
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://openrouter.ai/api/v1/chat/completions",
        body: JSON.stringify(prepared.body),
        headers: Headers.empty,
      })

      expect(resolved.route).toMatchObject({
        id: "openrouter",
        endpoint: { baseURL: "https://openrouter.ai/api/v1" },
      })
      expect(headers.authorization).toBe("Bearer openrouter-secret")
      expect(prepared.body).toMatchObject({
        model: "anthropic/claude-sonnet-4",
        usage: { include: true },
        reasoning: { effort: "high" },
        prompt_cache_key: "session_123",
      })
      expect(JSON.stringify(prepared.body)).not.toContain("openrouter-secret")
    }),
  )

  it.effect("preserves environment-backed bearer auth", () =>
    Effect.gen(function* () {
      const resolved = yield* fromCatalogModel(
        new ModelV2.Info({
          ...model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
          request: { headers: {}, body: {}, generation: {}, options: {} },
        }),
        { type: "env", name: "TEST_PROVIDER_API_KEY" },
      )
      const request = LLM.request({ model: resolved, prompt: "Hello" })
      const headers = yield* resolved.route.auth
        .apply({
          request,
          method: "POST",
          url: "https://openai.example/v1/responses",
          body: "{}",
          headers: Headers.empty,
        })
        .pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { TEST_PROVIDER_API_KEY: "secret" } }))),
        )

      expect(headers.authorization).toBe("Bearer secret")
    }),
  )

  it.effect("prefers stored credentials over configured auth", () =>
    Effect.gen(function* () {
      const credential = new Credential.Stored({
        id: Credential.ID.create(),
        integrationID: Integration.ID.make("test-provider"),
        label: "Work",
        value: new Credential.Key({ type: "key", key: "stored-secret", metadata: { tenant: "work" } }),
      })
      const resolved = yield* fromCatalogModel(
        new ModelV2.Info({
          ...model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
          request: { headers: {}, body: { apiKey: "configured-secret" }, generation: {}, options: {} },
        }),
        { type: "credential", id: credential.id, label: credential.label },
        credential,
      )
      const headers = yield* resolved.route.auth.apply({
        request: LLM.request({ model: resolved, prompt: "Hello" }),
        method: "POST",
        url: "https://openai.example/v1/responses",
        body: "{}",
        headers: Headers.empty,
      })

      expect(headers.authorization).toBe("Bearer stored-secret")
      expect(resolved.route.defaults.http?.body).toEqual({ tenant: "work" })
    }),
  )

  it.effect("rejects catalog APIs without a native route", () =>
    Effect.gen(function* () {
      const failure = yield* fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/google", url: "https://google.example/v1" }),
      ).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.UnsupportedApiError",
        providerID: "test-provider",
        modelID: "test-model",
        api: "aisdk:@ai-sdk/google",
      })
    }),
  )

  it.effect("reports whether a catalog model has a supported executable AISDK route", () =>
    Effect.sync(() => {
      expect(
        SessionRunnerModel.supported(
          model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
        ),
      ).toBe(true)
      expect(SessionRunnerModel.supported(model({ type: "aisdk", package: "@openrouter/ai-sdk-provider" }))).toBe(
        true,
      )
      expect(
        SessionRunnerModel.supported(
          model({ type: "aisdk", package: "@ai-sdk/google", url: "https://google.example/v1" }),
        ),
      ).toBe(true)
      expect(SessionRunnerModel.supported(model({ type: "native", settings: {} }))).toBe(false)
    }),
  )
})
