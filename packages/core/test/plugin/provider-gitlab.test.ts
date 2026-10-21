import { providerModule } from "./provider-helper"
import { createServer } from "node:http"
import { describe, expect, mock } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/core/integration"
import { Database } from "@opencode-ai/core/database/database"
import { Catalog } from "@opencode-ai/core/catalog"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { GitLabPlugin } from "./provider-packages"
import { methodID } from "../../../provider-plugins/gitlab/src/auth"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { it, model, npmLayer, withEnv } from "./provider-helper"

const gitlabSDKOptions: Record<string, unknown>[] = []
const database = Database.layerFromPath(":memory:").pipe(Layer.fresh)
const preferences = Credential.layer.pipe(Layer.provide(database))
const accounts = Layer.merge(
  Credential.layer.pipe(Layer.provide(database), Layer.provide(preferences), Layer.provide(EventV2.defaultLayer)),
  preferences,
)

void mock.module(providerModule("gitlab", "gitlab-ai-provider"), () => ({
  VERSION: "test-version",
  createGitLab: (options: Record<string, unknown>) => {
    gitlabSDKOptions.push(options)
    return {
      agenticChat: (id: string, options: unknown) => ({ id, options, type: "agentic" }),
      workflowChat: (id: string, options: unknown) => ({ id, options, type: "workflow" }),
    }
  },
  discoverWorkflowModels: async () => ({ models: [], project: undefined }),
  isWorkflowModel: (id: string) => id === "duo-workflow" || id === "duo-workflow-exact",
}))

const itWithAccount = testEffect(
  Catalog.locationLayer.pipe(
    Layer.provideMerge(accounts),
    Layer.provideMerge(EventV2.defaultLayer),
    Layer.provideMerge(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/") }))),
    ),
    Layer.provideMerge(npmLayer),
  ),
)

async function oauthServer() {
  const requests: string[] = []
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    requests.push(body)
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(
      JSON.stringify({
        access_token: `fresh-access-${requests.length}`,
        refresh_token: `fresh-refresh-${requests.length}`,
        expires_in: 3600,
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("OAuth test server did not bind a TCP port")
  return {
    instanceUrl: `http://127.0.0.1:${address.port}`,
    requests,
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}

describe("GitLabPlugin", () => {
  it.effect("creates SDKs with legacy default instance URL, token env, headers, and feature flags", () =>
    withEnv(
      {
        GITLAB_INSTANCE_URL: undefined,
        GITLAB_TOKEN: "env-token",
      },
      () =>
        Effect.gen(function* () {
          gitlabSDKOptions.length = 0
          const plugin = yield* PluginV2.Service
          yield* plugin.add(GitLabPlugin)
          yield* plugin.trigger(
            "aisdk.sdk",
            { model: model("gitlab", "claude"), package: "gitlab-ai-provider", options: { name: "gitlab" } },
            {},
          )
          expect(gitlabSDKOptions).toHaveLength(1)
          expect(gitlabSDKOptions[0].instanceUrl).toBe("https://gitlab.com")
          expect(gitlabSDKOptions[0].apiKey).toBe("env-token")
          expect(gitlabSDKOptions[0].aiGatewayHeaders).toMatchObject({
            "anthropic-beta": "context-1m-2025-08-07",
          })
          expect(String((gitlabSDKOptions[0].aiGatewayHeaders as Record<string, string>)["User-Agent"])).toContain(
            "gitlab-ai-provider/test-version",
          )
          expect(gitlabSDKOptions[0].featureFlags).toEqual({
            duo_agent_platform_agentic_chat: true,
            duo_agent_platform: true,
          })
        }),
    ),
  )

  it.effect("uses GITLAB_INSTANCE_URL when instanceUrl is not configured", () =>
    withEnv(
      {
        GITLAB_INSTANCE_URL: "https://env.gitlab.example",
        GITLAB_TOKEN: undefined,
      },
      () =>
        Effect.gen(function* () {
          gitlabSDKOptions.length = 0
          const plugin = yield* PluginV2.Service
          yield* plugin.add(GitLabPlugin)
          yield* plugin.trigger(
            "aisdk.sdk",
            { model: model("gitlab", "claude"), package: "gitlab-ai-provider", options: { name: "gitlab" } },
            {},
          )
          expect(gitlabSDKOptions[0].instanceUrl).toBe("https://env.gitlab.example")
        }),
    ),
  )

  it.effect("keeps configured instance URL, apiKey, aiGatewayHeaders, and featureFlags over env/defaults", () =>
    withEnv(
      {
        GITLAB_INSTANCE_URL: "https://env.gitlab.example",
        GITLAB_TOKEN: "env-token",
      },
      () =>
        Effect.gen(function* () {
          gitlabSDKOptions.length = 0
          const plugin = yield* PluginV2.Service
          yield* plugin.add(GitLabPlugin)
          yield* plugin.trigger(
            "aisdk.sdk",
            {
              model: model("gitlab", "claude"),
              package: "gitlab-ai-provider",
              options: {
                name: "gitlab",
                instanceUrl: "https://configured.gitlab.example",
                apiKey: "configured-token",
                aiGatewayHeaders: {
                  "anthropic-beta": "configured-beta",
                  "x-gitlab-test": "1",
                },
                featureFlags: {
                  duo_agent_platform: false,
                  custom_flag: true,
                },
              },
            },
            {},
          )
          expect(gitlabSDKOptions[0].instanceUrl).toBe("https://configured.gitlab.example")
          expect(gitlabSDKOptions[0].apiKey).toBe("configured-token")
          expect(gitlabSDKOptions[0].aiGatewayHeaders).toMatchObject({
            "anthropic-beta": "configured-beta",
            "x-gitlab-test": "1",
          })
          expect(gitlabSDKOptions[0].featureFlags).toEqual({
            duo_agent_platform_agentic_chat: true,
            duo_agent_platform: false,
            custom_flag: true,
          })
        }),
    ),
  )

  it.effect("ignores non-GitLab SDK packages", () =>
    Effect.gen(function* () {
      gitlabSDKOptions.length = 0
      const plugin = yield* PluginV2.Service
      yield* plugin.add(GitLabPlugin)
      const result = yield* plugin.trigger(
        "aisdk.sdk",
        { model: model("gitlab", "claude"), package: "@ai-sdk/openai", options: { name: "gitlab" } },
        {},
      )
      expect(result.sdk).toBeUndefined()
      expect(gitlabSDKOptions).toHaveLength(0)
    }),
  )

  itWithAccount.effect("uses active account API token over GITLAB_TOKEN", () =>
    withEnv(
      {
        GITLAB_TOKEN: "env-token",
      },
      () =>
        Effect.gen(function* () {
          gitlabSDKOptions.length = 0
          const plugin = yield* PluginV2.Service
          const credentials = yield* Credential.Service
          const catalog = yield* Catalog.Service
          yield* credentials.create({
            integrationID: Integration.ID.make("gitlab"),
            value: new Credential.Key({
              type: "key",
              key: "account-token",
              metadata: { instanceUrl: "https://gitlab.company.test" },
            }),
          })
          yield* plugin.add(GitLabPlugin)
          const transform = yield* catalog.transform()
          yield* transform((catalog) => catalog.provider.update(ProviderV2.ID.make("gitlab"), () => {}))
          const provider = yield* catalog.provider.get(ProviderV2.ID.make("gitlab"))
          yield* plugin.trigger(
            "aisdk.sdk",
            {
              model: model("gitlab", "claude"),
              package: "gitlab-ai-provider",
              options: provider.request.body,
            },
            {},
          )
          expect(gitlabSDKOptions[0].apiKey).toBe("account-token")
          expect(gitlabSDKOptions[0].instanceUrl).toBe("https://gitlab.company.test")
        }),
    ),
  )

  itWithAccount.effect("uses active account OAuth access token over GITLAB_TOKEN", () =>
    withEnv(
      {
        GITLAB_TOKEN: "env-token",
      },
      () =>
        Effect.gen(function* () {
          gitlabSDKOptions.length = 0
          const plugin = yield* PluginV2.Service
          const credentials = yield* Credential.Service
          const catalog = yield* Catalog.Service
          yield* credentials.create({
            integrationID: Integration.ID.make("gitlab"),
            value: new Credential.OAuth({
              type: "oauth",
              methodID: Integration.MethodID.make(methodID),
              refresh: "refresh-token",
              access: "account-oauth-token",
              expires: 9999999999999,
              metadata: { instanceUrl: "https://gitlab.company.test" },
            }),
          })
          yield* plugin.add(GitLabPlugin)
          const transform = yield* catalog.transform()
          yield* transform((catalog) => catalog.provider.update(ProviderV2.ID.make("gitlab"), () => {}))
          const provider = yield* catalog.provider.get(ProviderV2.ID.make("gitlab"))
          yield* plugin.trigger(
            "aisdk.sdk",
            {
              model: model("gitlab", "claude"),
              package: "gitlab-ai-provider",
              options: provider.request.body,
            },
            {},
          )
          expect(gitlabSDKOptions[0].apiKey).toBe("account-oauth-token")
          expect(gitlabSDKOptions[0].instanceUrl).toBe("https://gitlab.company.test")
        }),
    ),
  )

  itWithAccount.effect("short-circuits stale account lookup when apiKey is explicitly configured", () =>
    Effect.gen(function* () {
      gitlabSDKOptions.length = 0
      const plugin = yield* PluginV2.Service
      const credentials = yield* Credential.Service
      yield* credentials.create({
        integrationID: Integration.ID.make("gitlab"),
        value: new Credential.OAuth({
          type: "oauth",
          methodID: Integration.MethodID.make(methodID),
          refresh: "stale-refresh",
          access: "stale-access",
          expires: 0,
          metadata: { instanceUrl: "https://unreachable.gitlab.invalid" },
        }),
      })
      yield* plugin.add(GitLabPlugin)
      yield* plugin.trigger(
        "aisdk.sdk",
        {
          model: model("gitlab", "claude"),
          package: "gitlab-ai-provider",
          options: {
            apiKey: "configured-token",
            instanceUrl: "https://configured.gitlab.example",
          },
        },
        {},
      )

      expect(gitlabSDKOptions[0].apiKey).toBe("configured-token")
      expect(gitlabSDKOptions[0].instanceUrl).toBe("https://configured.gitlab.example")
    }),
  )

  itWithAccount.effect("rejects account credentials without a validated instance origin", () =>
    withEnv({ GITLAB_INSTANCE_URL: undefined, GITLAB_TOKEN: "env-token" }, () =>
      Effect.gen(function* () {
        gitlabSDKOptions.length = 0
        const plugin = yield* PluginV2.Service
        const credentials = yield* Credential.Service
        yield* credentials.create({
          integrationID: Integration.ID.make("gitlab"),
          value: new Credential.Key({
            type: "key",
            key: "account-token",
            metadata: { instanceUrl: "https://gitlab.company.test/untrusted-path" },
          }),
        })
        yield* plugin.add(GitLabPlugin)
        const result = yield* plugin
          .trigger("aisdk.sdk", { model: model("gitlab", "claude"), package: "gitlab-ai-provider", options: {} }, {})
          .pipe(Effect.exit)

        expect(Exit.isFailure(result)).toBe(true)
        expect(gitlabSDKOptions).toEqual([])
      }),
    ),
  )

  itWithAccount.live("refreshes near-expiry and expired OAuth on the credential's self-hosted origin", () =>
    Effect.acquireRelease(Effect.promise(oauthServer), (server) =>
      Effect.promise(() => server[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((server) =>
        Effect.gen(function* () {
          gitlabSDKOptions.length = 0
          const plugin = yield* PluginV2.Service
          const credentials = yield* Credential.Service
          const integrations = yield* Integration.Service
          yield* plugin.add(GitLabPlugin)

          expect((yield* integrations.get(Integration.ID.make("gitlab")))?.methods).toContainEqual(
            expect.objectContaining({ id: methodID, type: "oauth" }),
          )

          yield* Effect.forEach([Date.now() + 5_000, Date.now() - 1_000], (expires, index) =>
            Effect.gen(function* () {
              yield* credentials.create({
                integrationID: Integration.ID.make("gitlab"),
                value: new Credential.OAuth({
                  type: "oauth",
                  methodID: Integration.MethodID.make(methodID),
                  refresh: `old-refresh-${index}`,
                  access: `old-access-${index}`,
                  expires,
                  metadata: { instanceUrl: server.instanceUrl },
                }),
              })
              yield* plugin.trigger(
                "aisdk.sdk",
                { model: model("gitlab", "claude"), package: "gitlab-ai-provider", options: {} },
                {},
              )
              expect(gitlabSDKOptions[index].apiKey).toBe(`fresh-access-${index + 1}`)
              expect(gitlabSDKOptions[index].instanceUrl).toBe(server.instanceUrl)
            }),
          )

          expect(server.requests).toHaveLength(2)
          expect(new URLSearchParams(server.requests[0]).get("refresh_token")).toBe("old-refresh-0")
          expect(new URLSearchParams(server.requests[1]).get("refresh_token")).toBe("old-refresh-1")
          expect(server.requests.every((body) => new URLSearchParams(body).get("grant_type") === "refresh_token")).toBe(
            true,
          )
        }),
      ),
    ),
  )

  it.effect("uses workflowChat for duo workflow models and preserves selectedModelRef", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const calls: [string, unknown][] = []
      yield* plugin.add(GitLabPlugin)
      const result = yield* plugin.trigger(
        "aisdk.language",
        {
          model: model("gitlab", "duo-workflow-custom", {
            request: {
              headers: {},
              body: { workflowRef: "ref", workflowDefinition: "definition" },
            },
          }),
          sdk: {
            workflowChat: (id: string, options: unknown) => {
              calls.push([id, options])
              return { id, options }
            },
            agenticChat: () => undefined,
          },
          options: { featureFlags: { configured: true } },
        },
        {},
      )
      expect(calls).toEqual([
        ["duo-workflow", { featureFlags: { configured: true }, workflowDefinition: "definition" }],
      ])
      expect(result.language as unknown).toEqual({
        id: "duo-workflow",
        options: calls[0]?.[1],
        selectedModelRef: "ref",
      })
    }),
  )

  it.effect("uses exact static workflow model ids when the provider recognizes them", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const calls: [string, unknown][] = []
      yield* plugin.add(GitLabPlugin)
      const result = yield* plugin.trigger(
        "aisdk.language",
        {
          model: model("gitlab", "duo-workflow-exact"),
          sdk: {
            workflowChat: (id: string, options: unknown) => {
              calls.push([id, options])
              return { id, options }
            },
            agenticChat: () => undefined,
          },
          options: { featureFlags: { configured: true } },
        },
        {},
      )
      expect(calls).toEqual([
        ["duo-workflow-exact", { featureFlags: { configured: true }, workflowDefinition: undefined }],
      ])
      expect(result.language as unknown).toEqual({ id: "duo-workflow-exact", options: calls[0]?.[1] })
    }),
  )

  it.effect("uses provider feature flags instead of request feature flags", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const calls: [string, unknown][] = []
      yield* plugin.add(GitLabPlugin)
      yield* plugin.trigger(
        "aisdk.language",
        {
          model: model("gitlab", "duo-workflow-custom", {
            request: {
              headers: {},
              body: { featureFlags: { request_flag: true } },
            },
          }),
          sdk: {
            workflowChat: (id: string, options: unknown) => {
              calls.push([id, options])
              return { id, options }
            },
            agenticChat: () => undefined,
          },
          options: { featureFlags: { configured: true } },
        },
        {},
      )
      expect(calls).toEqual([["duo-workflow", { featureFlags: { configured: true }, workflowDefinition: undefined }]])
    }),
  )

  it.effect("uses agenticChat with provider aiGatewayHeaders and feature flags for normal models", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const calls: [string, unknown][] = []
      yield* plugin.add(GitLabPlugin)
      yield* plugin.trigger(
        "aisdk.language",
        {
          model: model("gitlab", "claude", {
            request: { headers: { h: "v" }, body: {} },
          }),
          sdk: {
            workflowChat: () => undefined,
            agenticChat: (id: string, options: unknown) => {
              const selected = options as {
                aiGatewayHeaders?: Record<string, string>
                featureFlags?: Record<string, boolean>
              }
              calls.push([
                id,
                { aiGatewayHeaders: { ...selected.aiGatewayHeaders }, featureFlags: { ...selected.featureFlags } },
              ])
            },
          },
          options: { aiGatewayHeaders: { fallback: "header" }, featureFlags: { duo_agent_platform: true } },
        },
        {},
      )
      expect(calls).toEqual([
        ["claude", { aiGatewayHeaders: { fallback: "header" }, featureFlags: { duo_agent_platform: true } }],
      ])
    }),
  )
})
