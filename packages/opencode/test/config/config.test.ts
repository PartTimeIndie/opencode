import { test, expect, describe, afterEach, beforeEach, spyOn } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Config } from "@/config/config"
import { ConfigManaged } from "@/config/managed"
import { ConfigParse } from "../../src/config/parse"
import { ConfigPaths } from "../../src/config/paths"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"

import { InstanceRef } from "../../src/effect/instance-ref"
import type { InstanceContext } from "../../src/project/instance-context"
import { Auth } from "../../src/auth"
import { Account } from "../../src/account/account"
import { AccessToken, AccountID, OrgID } from "../../src/account/schema"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Env } from "../../src/env"
import {
  provideTmpdirInstance,
  TestInstance,
  tmpdir,
  tmpdirScoped,
  withTestInstance,
  provideInstanceEffect,
  testInstanceStoreLayer,
} from "../fixture/fixture"
import { InstanceRuntime } from "@/project/instance-runtime"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import path from "path"
import fs from "fs/promises"
import os from "os"
import { pathToFileURL } from "url"
import { Global } from "@opencode-ai/core/global"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Filesystem } from "@/util/filesystem"
import { ConfigPlugin } from "@/config/plugin"
import { ConfigPluginV1 } from "@opencode-ai/core/v1/config/plugin"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { Npm } from "@opencode-ai/core/npm"

/** Infra layer that provides FileSystem, Path, ChildProcessSpawner for test fixtures */
const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const testFlock = EffectFlock.defaultLayer

const unexpectedHttp = HttpClient.make((request) =>
  Effect.die(`unexpected http request: ${request.method} ${request.url}`),
)

const json = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const wellKnownAuth = (url: string) =>
  Layer.mock(Auth.Service)({
    all: () =>
      Effect.succeed({
        [url]: new Auth.WellKnown({ type: "wellknown", key: "TEST_TOKEN", token: "test-token" }),
      }),
  })

function remoteConfigClient(input: {
  wellKnown: unknown
  remote?: unknown
  remoteHtml?: string
  seen: { wellKnown?: string; remote?: string; authorization?: string }
}) {
  return HttpClient.make((request) => {
    if (request.url.includes(".well-known/opencode")) {
      input.seen.wellKnown = request.url
      return Effect.succeed(json(request, input.wellKnown))
    }
    if (request.url.includes("config.example.com") && (input.remote !== undefined || input.remoteHtml !== undefined)) {
      input.seen.remote = request.url
      input.seen.authorization = request.headers.authorization
      if (input.remoteHtml !== undefined) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(input.remoteHtml, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
          ),
        )
      }
      return Effect.succeed(json(request, input.remote))
    }
    return Effect.succeed(json(request, {}, 404))
  })
}

const configLayer = (
  options: {
    auth?: Layer.Layer<Auth.Service>
    account?: Layer.Layer<Account.Service>
    client?: HttpClient.HttpClient
    npm?: Layer.Layer<Npm.Service>
    maxDependencyRetireRetries?: number
  } = {},
) => {
  const base = Config.layer.pipe(
    Layer.provide(testFlock),
    Layer.provide(Env.defaultLayer),
    Layer.provide(options.auth ?? AuthTest.empty),
    Layer.provide(options.account ?? AccountTest.empty),
    Layer.provideMerge(infra),
    Layer.provide(options.npm ?? NpmTest.noop),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, options.client ?? unexpectedHttp)),
    Layer.provideMerge(FSUtil.defaultLayer),
  )
  // The seam is read at Config layer build, so the override must be wired
  // into the layer itself — a provideService on the waiter effect would be too
  // late and silently ineffective. The real option value is honored.
  return options.maxDependencyRetireRetries === undefined
    ? base
    : base.pipe(
        Layer.provide(
          Layer.succeed(Config.MaxDependencyRetireRetries, { retries: options.maxDependencyRetireRetries }),
        ),
      )
}

const layer = configLayer()

const it = testEffect(layer)
const configIt = (options?: Parameters<typeof configLayer>[0]) => testEffect(configLayer(options))

const schemaConfig = (config: object) => ({ $schema: "https://opencode.ai/config.json", ...config })

const provideCurrentInstance = <A, E, R>(effect: Effect.Effect<A, E, R>, ctx: InstanceContext) =>
  effect.pipe(Effect.provideService(InstanceRef, ctx))

const load = (ctx: InstanceContext) =>
  Effect.runPromise(
    Config.Service.use((svc) => provideCurrentInstance(svc.get(), ctx)).pipe(Effect.scoped, Effect.provide(layer)),
  )
const clearEffect = (wait = false) =>
  Config.use
    .invalidate()
    .pipe(
      Effect.scoped,
      Effect.provide(layer),
      Effect.andThen(wait ? Effect.promise(() => InstanceRuntime.disposeAllInstances()) : Effect.void),
    )
const clear = (wait = false) => Effect.runPromise(clearEffect(wait))
// Get managed config directory from environment (set in preload.ts)
const managedConfigDir = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR!
const originalTestToken = process.env.TEST_TOKEN
const originalConsoleToken = process.env.OPENCODE_CONSOLE_TOKEN

beforeEach(async () => {
  await clear(true)
})

afterEach(async () => {
  await fs.rm(managedConfigDir, { force: true, recursive: true }).catch(() => {})
  if (originalTestToken === undefined) delete process.env.TEST_TOKEN
  else process.env.TEST_TOKEN = originalTestToken
  if (originalConsoleToken === undefined) delete process.env.OPENCODE_CONSOLE_TOKEN
  else process.env.OPENCODE_CONSOLE_TOKEN = originalConsoleToken
  await clear(true)
})

const writeManagedSettingsEffect = (settings: object, filename?: string) =>
  FSUtil.use.writeWithDirs(path.join(managedConfigDir, filename ?? "opencode.json"), JSON.stringify(settings))

async function writeConfig(dir: string, config: object, name = "opencode.json") {
  await Filesystem.write(path.join(dir, name), JSON.stringify(config))
}

const writeConfigEffect = (dir: string, config: object, name = "opencode.json") =>
  FSUtil.use.writeWithDirs(path.join(dir, name), JSON.stringify(config))

const withInstanceDir = <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(TestInstance, { directory: dir }),
    provideInstanceEffect(dir),
    Effect.provide(testInstanceStoreLayer),
    Effect.provide(CrossSpawnSpawner.defaultLayer),
  )

const withGlobalConfigDir = <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const previous = Global.Path.config
      ;(Global.Path as { config: string }).config = dir
      yield* clearEffect(true)
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.gen(function* () {
        ;(Global.Path as { config: string }).config = previous
        yield* clearEffect(true)
      }),
  )

const withGlobalConfig = <A, E, R>(
  input: { config?: object; name?: string },
  fn: (input: { dir: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    if (input.config) yield* writeConfigEffect(dir, schemaConfig(input.config), input.name)
    return yield* withGlobalConfigDir(dir, fn({ dir }))
  })

const withConfigTree = <A, E, R>(
  input: { global?: object; project?: object; local?: object },
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const global = yield* tmpdirScoped()
    const directory = path.join(root, "project")
    yield* Effect.all(
      [
        input.global ? writeConfigEffect(global, schemaConfig(input.global)) : undefined,
        input.project ? writeConfigEffect(directory, schemaConfig(input.project)) : undefined,
        input.local ? writeConfigEffect(path.join(directory, ".opencode"), schemaConfig(input.local)) : undefined,
      ].filter((effect): effect is Effect.Effect<void, FSUtil.Error, FSUtil.Service> => effect !== undefined),
      { concurrency: "unbounded" },
    )
    return yield* withGlobalConfigDir(global, withInstanceDir(directory, effect))
  })

const wellKnown = (input: {
  authUrl?: string
  config?: unknown
  remoteConfig?: { url: string; headers?: Record<string, string> }
  remote?: unknown
  remoteHtml?: string
  wellKnown?: unknown
}) => {
  const seen: { wellKnown?: string; remote?: string; authorization?: string } = {}
  const client = remoteConfigClient({
    seen,
    wellKnown: input.wellKnown ?? {
      ...(input.config !== undefined ? { config: input.config } : {}),
      ...(input.remoteConfig !== undefined ? { remote_config: input.remoteConfig } : {}),
    },
    remote: input.remote,
    remoteHtml: input.remoteHtml,
  })
  return {
    seen,
    it: configIt({ auth: wellKnownAuth(input.authUrl ?? "https://example.com"), client }),
  }
}

function withProcessEnv<A, E, R>(key: string, value: string | undefined, effect: Effect.Effect<A, E, R>) {
  return withProcessEnvs({ [key]: value }, effect)
}

function withProcessEnvs<A, E, R>(entries: Record<string, string | undefined>, effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const originals: Record<string, string | undefined> = {}
      for (const [key, value] of Object.entries(entries)) {
        originals[key] = process.env[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      return originals
    }),
    () => effect,
    (originals) =>
      Effect.sync(() => {
        for (const [key, original] of Object.entries(originals)) {
          if (original !== undefined) process.env[key] = original
          else delete process.env[key]
        }
      }),
  )
}

async function check(map: (dir: string) => string) {
  if (process.platform !== "win32") return
  await using globalTmp = await tmpdir()
  await using tmp = await tmpdir({ git: true, config: { snapshot: true } })
  const prev = Global.Path.config
  ;(Global.Path as { config: string }).config = globalTmp.path
  await clear()
  try {
    await writeConfig(globalTmp.path, {
      $schema: "https://opencode.ai/config.json",
      snapshot: false,
    })
    await withTestInstance({
      directory: map(tmp.path),
      fn: async (ctx) => {
        const cfg = await load(ctx)
        expect(cfg.snapshot).toBe(true)
        expect(ctx.directory).toBe(Filesystem.resolve(tmp.path))
        expect(ctx.project.id).not.toBe(ProjectV2.ID.global)
      },
    })
  } finally {
    await InstanceRuntime.disposeAllInstances()
    ;(Global.Path as { config: string }).config = prev
    await clear()
  }
}

it.instance("loads config with defaults when no files exist", () =>
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.username).toBeDefined()
  }),
)

it.instance("falls back to generic username when system user info is unavailable", () =>
  Effect.gen(function* () {
    const userInfo = spyOn(os, "userInfo").mockImplementation(() => {
      throw Object.assign(new Error("missing passwd entry"), { code: "ENOENT" })
    })
    try {
      const config = yield* Config.use.get()
      expect(config.username).toBe("user")
    } finally {
      userInfo.mockRestore()
    }
  }),
)

it.effect("creates global jsonc config with schema when no global configs exist", () =>
  withGlobalConfig({}, ({ dir }) =>
    Effect.gen(function* () {
      yield* Config.use.get().pipe(provideInstanceEffect(dir))

      const content = yield* FSUtil.use.readFileString(path.join(dir, "opencode.jsonc"))
      expect(content).toContain('"$schema": "https://opencode.ai/config.json"')
    }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
  ),
)

it.effect("does not create global config when OPENCODE_CONFIG_DIR is set", () =>
  Effect.gen(function* () {
    const custom = yield* tmpdirScoped()
    yield* withGlobalConfig({}, ({ dir }) =>
      withProcessEnv(
        "OPENCODE_CONFIG_DIR",
        custom,
        Effect.gen(function* () {
          yield* Config.use.get().pipe(provideInstanceEffect(dir))

          expect(yield* FSUtil.use.existsSafe(path.join(dir, "opencode.jsonc"))).toBe(false)
        }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
      ),
    )
  }),
)

it.instance(
  "loads JSON config file",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.model).toBe("test/model")
    expect(config.username).toBe("testuser")
  }),
  { config: { model: "test/model", username: "testuser" } },
)

it.instance(
  "preserves model provider endpoint overrides",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.provider?.["github-copilot"]?.models?.["gpt-5-test"]?.provider?.endpoint).toBe("chat")
  }),
  {
    config: {
      provider: {
        "github-copilot": {
          npm: "@ai-sdk/github-copilot",
          api: "https://api.githubcopilot.com",
          models: {
            "gpt-5-test": {
              name: "GPT 5 Test",
              provider: {
                npm: "@ai-sdk/github-copilot",
                api: "https://api.githubcopilot.com",
                endpoint: "chat",
              },
            },
          },
        },
      },
    },
  },
)

it.instance(
  "loads shell config field",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.shell).toBe("bash")
  }),
  { config: { shell: "bash" } },
)

it.instance("updates config and preserves empty shell sentinel", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(
      path.join(test.directory, ".opencode"),
      { $schema: "https://opencode.ai/config.json", shell: "bash" },
      "opencode.json",
    )

    yield* Config.Service.use((svc) => svc.update(ConfigParse.schema(ConfigV1.Info, { shell: "" }, "test:config")))

    const writtenConfig = yield* FSUtil.use.readJson(path.join(test.directory, ".opencode", "opencode.json"))
    expect(writtenConfig).toMatchObject({ shell: "" })
  }),
)

it.effect("updates global config and omits empty shell key in json", () =>
  withGlobalConfig({ config: { shell: "bash" } }, ({ dir }) =>
    Effect.gen(function* () {
      yield* Config.use.updateGlobal({ shell: "" })

      const writtenConfig = yield* FSUtil.use.readJson(path.join(dir, "opencode.json"))
      expect(writtenConfig).not.toHaveProperty("shell")
    }),
  ),
)

it.effect("updates global config and omits empty shell key in jsonc", () =>
  withGlobalConfig({ config: { shell: "bash", model: "test/model" }, name: "opencode.jsonc" }, ({ dir }) =>
    Effect.gen(function* () {
      yield* Config.use.updateGlobal({ shell: "" })

      const file = path.join(dir, "opencode.jsonc")
      const writtenConfig = yield* FSUtil.use.readFileString(file)
      const parsed = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(writtenConfig, file), file)
      expect(writtenConfig).not.toContain('"shell"')
      expect(parsed.shell).toBeUndefined()
      expect(parsed.model).toBe("test/model")
    }),
  ),
)

  it.effect("clears the stored default model chain through an explicit null update", () =>
    withGlobalConfig(
      {
        config: {
          model_chains: [{ id: "chain-a", name: "A", steps: [{ providerID: "p", modelID: "m" }] }],
          default_model_chain: "chain-a",
        },
      },
      ({ dir }) =>
        Effect.gen(function* () {
          const result = yield* Config.use.updateGlobal({ default_model_chain: null })
          expect(result.changed).toBe(true)
          expect(result.info.default_model_chain).toBeUndefined()
          const written = yield* FSUtil.use.readJson(path.join(dir, "opencode.json"))
          expect(written).not.toHaveProperty("default_model_chain")
          expect(written).toMatchObject({ model_chains: [{ id: "chain-a" }] })
        }),
    ),
  )

  it.effect("clears the stored default model chain in jsonc while preserving comments", () =>
    withGlobalConfig(
      {
        name: "opencode.jsonc",
        config: {
          model: "test/model",
          model_chains: [{ id: "chain-a", name: "A", steps: [{ providerID: "p", modelID: "m" }] }],
          default_model_chain: "chain-a",
        },
      },
      ({ dir }) =>
        Effect.gen(function* () {
          const file = path.join(dir, "opencode.jsonc")
          yield* FSUtil.use.writeFileString(
            file,
            (yield* FSUtil.use.readFileString(file)).replace('"model":', '// keep this comment\n  "model":'),
          )

          yield* Config.use.updateGlobal({ default_model_chain: null })

          const written = yield* FSUtil.use.readFileString(file)
          const parsed = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(written, file), file)
          expect(written).toContain("// keep this comment")
          expect(written).not.toContain('"default_model_chain"')
          expect(parsed.default_model_chain).toBeUndefined()
          expect(parsed.model).toBe("test/model")
          expect(parsed.model_chains).toHaveLength(1)
        }),
    ),
  )

  it.effect("applies skill policy patches in global json: set, null-delete, entry cleanup, no null persisted", () =>
    withGlobalConfig(
      {
        config: {
          model: "test/model",
          agent: {
            build: {
              name: "build",
              tools: { mode: "explicit", entries: { bash: { visible: true, permission: "allow" } } },
              skills: { effect: { visible: true, invocation: "ask" } },
            },
          },
        },
      },
      ({ dir }) =>
        Effect.gen(function* () {
          const result = yield* Config.use.updateGlobal({
            skill_policy: {
              global: {
                effect: { visible: false, invocation: "allow" },
                locked: { visible: false, invocation: "deny" },
              },
              agents: {
                build: { effect: { visible: null, invocation: "allow" } },
              },
            },
          })
          expect(result.changed).toBe(true)
          expect(result.info.skill_invocation).toEqual({
            entries: {
              effect: { visible: false, invocation: "allow" },
              locked: { visible: false, invocation: "deny" },
            },
          })
          expect(result.info.agent?.build?.skills).toEqual({ effect: { invocation: "allow" } })

          // null deletes exactly the stored field; empty entries disappear.
          yield* Config.use.updateGlobal({
            skill_policy: {
              global: { locked: { visible: null, invocation: null } },
              agents: { build: { effect: { invocation: null } } },
            },
          })
          const written = (yield* FSUtil.use.readJson(path.join(dir, "opencode.json"))) as Record<string, any>
          expect(written.skill_invocation).toEqual({ entries: { effect: { visible: false, invocation: "allow" } } })
          expect(written.agent.build.skills).toBeUndefined()
          // Unrelated stored fields survive untouched.
          expect(written.agent.build.tools).toEqual({ mode: "explicit", entries: { bash: { visible: true, permission: "allow" } } })
          expect(written.model).toBe("test/model")
          const serialized = JSON.stringify(written)
          expect(serialized).not.toContain("skill_policy")
          expect(serialized).not.toContain(": null")
        }),
    ),
  )

  it.effect("applies skill policy patches in global jsonc while preserving comments", () =>
    withGlobalConfig(
      {
        name: "opencode.jsonc",
        config: {
          model: "test/model",
          skill_invocation: { manual: ["legacy-skill"] },
          agent: {
            build: {
              name: "build",
              skills: { effect: { visible: true, invocation: "ask" } },
            },
          },
        },
      },
      ({ dir }) =>
        Effect.gen(function* () {
          const file = path.join(dir, "opencode.jsonc")
          yield* FSUtil.use.writeFileString(
            file,
            (yield* FSUtil.use.readFileString(file)).replace('"model":', '// keep this comment\n  "model":'),
          )

          yield* Config.use.updateGlobal({
            skill_policy: {
              global: { "toolbar-skill": { visible: false, invocation: "allow" }, "legacy-skill": { invocation: null } },
              agents: { build: { effect: { invocation: "allow" } } },
            },
          })

          const written = yield* FSUtil.use.readFileString(file)
          const parsed = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(written, file), file)
          expect(written).toContain("// keep this comment")
          expect(parsed.skill_invocation?.manual).toEqual(["legacy-skill"])
          expect(parsed.skill_invocation?.entries).toEqual({
            "toolbar-skill": { visible: false, invocation: "allow" },
          })
          expect(parsed.agent?.build?.skills).toEqual({ effect: { visible: true, invocation: "allow" } })
          expect(written).not.toContain("null")
        }),
    ),
  )

  it.effect("preserves unrecognized global keys while saving known settings", () =>
    withGlobalConfig({ config: { model: "test/model" } }, ({ dir }) => Effect.gen(function* () {
      const file = path.join(dir, "opencode.json")
      yield* FSUtil.use.writeFileString(file, JSON.stringify({ model: "test/model", future_setting: { keep: true } }))
      yield* Config.use.updateGlobal({ username: "saved" })
      expect(yield* FSUtil.use.readJson(file)).toMatchObject({ model: "test/model", username: "saved", future_setting: { keep: true } })
    })),
  )

  it.effect("serializes concurrent global config writes from multiple clients", () =>
    withGlobalConfig(
      {
        config: {
          model: "test/model",
          model_chains: [{ id: "chain-a", name: "A", steps: [{ providerID: "p", modelID: "m" }] }],
          default_model_chain: "chain-a",
        },
      },
      ({ dir }) =>
        Effect.gen(function* () {
          // Three clients race one shared global config file. The write lock
          // serializes the read-merge-write so every patch survives; without it,
          // writers reading the same base silently revert each other.
          yield* Effect.all(
            [
              Config.use.updateGlobal({ default_model_chain: null }),
              Config.use.updateGlobal({ model: "other/model" }),
              Config.use.updateGlobal({ username: "second-window" }),
            ],
            { concurrency: "unbounded", discard: true },
          )

          const written = yield* FSUtil.use.readJson(path.join(dir, "opencode.json"))
          expect(written).not.toHaveProperty("default_model_chain")
          expect(written).toMatchObject({
            model: "other/model",
            username: "second-window",
            model_chains: [{ id: "chain-a" }],
          })
        }),
    ),
  )

  it.effect("replaces complete nested settings sections in global json config", () =>
  withGlobalConfig(
    {
      config: {
        model: "test/model",
        access_control: {
          mode: "ask",
          safety_review: {
            model: "test/reviewer",
            fallback: { model: "test/fallback" },
            prompt: "custom prompt",
          },
        },
        vision: {
          enabled: true,
          primary: { model: "test/vision", variant: "high" },
          prompt_template: "custom template",
        },
      },
    },
    ({ dir }) =>
      Effect.gen(function* () {
        yield* Config.use.updateGlobal({
          access_control: { safety_review: { fallback: { model: "test/fallback" } } },
          vision: { enabled: true },
        })

        const file = path.join(dir, "opencode.json")
        const writtenConfig = ConfigParse.schema(
          ConfigV1.Info,
          ConfigParse.jsonc(yield* FSUtil.use.readFileString(file), file),
          file,
        )
        expect(writtenConfig).toMatchObject({
          model: "test/model",
          access_control: {
            mode: "ask",
            safety_review: { fallback: { model: "test/fallback" } },
          },
          vision: { enabled: true },
        })
        expect(writtenConfig).not.toHaveProperty("access_control.safety_review.model")
        expect(writtenConfig).not.toHaveProperty("access_control.safety_review.prompt")
        expect(writtenConfig).not.toHaveProperty("vision.primary")
        expect(writtenConfig).not.toHaveProperty("vision.prompt_template")
      }),
  ),
)

it.effect("replaces complete nested settings sections while preserving unrelated jsonc content", () =>
  withGlobalConfig(
    {
      name: "opencode.jsonc",
      config: {
        model: "test/model",
        access_control: {
          mode: "ask",
          safety_review: { model: "test/reviewer", prompt: "custom prompt" },
        },
        vision: {
          enabled: true,
          primary: { model: "test/vision", variant: "high" },
          prompt_template: "custom template",
        },
      },
    },
    ({ dir }) =>
      Effect.gen(function* () {
        const file = path.join(dir, "opencode.jsonc")
        yield* FSUtil.use.writeFileString(file, (yield* FSUtil.use.readFileString(file)).replace('"model":', '// keep this comment\n  "model":'))

        yield* Config.use.updateGlobal({
          access_control: { safety_review: {} },
          vision: { enabled: true },
        })

        const written = yield* FSUtil.use.readFileString(file)
        const parsed = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(written, file), file)
        expect(written).toContain("// keep this comment")
        expect(parsed.model).toBe("test/model")
        expect(parsed.access_control).toEqual({ mode: "ask", safety_review: {} })
        expect(parsed.vision).toEqual({ enabled: true })
      }),
  ),
)

it.effect("updates global optimization config", () =>
  withGlobalConfig({ config: { model: "test/model" }, name: "opencode.jsonc" }, ({ dir }) =>
    Effect.gen(function* () {
      yield* Config.use.updateGlobal({
        optimization: {
          profile: "off",
          features: {
            read_deduplication: false,
          },
        },
      })

      const file = path.join(dir, "opencode.jsonc")
      const parsed = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(yield* FSUtil.use.readFileString(file), file), file)
      expect(parsed.optimization?.profile).toBe("off")
      expect(parsed.optimization?.features?.read_deduplication).toBe(false)
      expect(parsed.model).toBe("test/model")
    }),
  ),
)

it.effect("canonicalizes a migrated agent tool policy without changing other agents", () =>
  withGlobalConfig(
    {
      config: {
        agent: {
          build: {
            tools: {},
            options: {
              __agentTools: {
                mode: "explicit",
                entries: {
                  read: { visible: true, permission: "allow" },
                  websearch: { visible: false, permission: "deny" },
                },
              },
            },
            permission: { "*": "deny", read: "allow" },
          },
          helper: { description: "keep me" },
        },
      },
    },
    ({ dir }) =>
      Effect.gen(function* () {
        yield* Config.use.updateGlobal(
          ConfigParse.schema(
            ConfigV1.Info,
            {
              agent: {
                build: {
                  tools: {
                    mode: "explicit",
                    entries: {
                      read: { visible: true, permission: "allow" },
                      webfetch: { visible: false, permission: "deny" },
                    },
                  },
                },
              },
            },
            "test:agent-tools",
          ),
        )

        const written = (yield* FSUtil.use.readJson(path.join(dir, "opencode.json"))) as {
          agent: Record<string, { tools?: unknown; options?: Record<string, unknown>; description?: string }>
        }
        expect(written.agent.build.tools).toEqual({
          mode: "explicit",
          entries: {
            read: { visible: true, permission: "allow" },
            webfetch: { visible: false, permission: "deny" },
          },
        })
        expect(written.agent.build.options?.__agentTools).toBeUndefined()
        expect((written.agent.build as { permission?: Record<string, unknown> }).permission).toEqual({ "*": "deny" })
        expect(written.agent.helper).toEqual({ description: "keep me" })
      }),
  ),
)

test("structured tool permissions override legacy values only in explicit mode", () => {
  const explicit = ConfigParse.schema(
    ConfigV1.Info,
    {
      agent: {
        build: {
          permission: { read: "allow", glob: "deny" },
          tools: {
            mode: "explicit",
            entries: {
              read: { visible: true, permission: "ask" },
              glob: { visible: true, permission: "allow" },
              webfetch: { visible: true },
            },
          },
        },
      },
    },
    "test:explicit-agent-tool-permissions",
  )
  const inherit = ConfigParse.schema(
    ConfigV1.Info,
    {
      agent: {
        build: {
          permission: { read: "allow" },
          tools: {
            mode: "inherit",
            entries: { read: { visible: true, permission: "ask" } },
          },
        },
      },
    },
    "test:inherited-agent-tool-permissions",
  )

  expect(explicit.agent?.build?.permission).toEqual({ read: "ask", glob: "allow", webfetch: "ask" })
  expect(inherit.agent?.build?.permission).toEqual({ read: "allow" })
  expect(ConfigAgentV1.persisted(inherit.agent!.build!).permission).toEqual({ read: "allow" })
})

describe("agent tool policy precedence", () => {
  const global = {
    agent: {
      build: {
        description: "Global build",
        options: { custom: "preserved" },
        tools: {
          mode: "explicit",
          entries: {
            read: { visible: true, permission: "allow" },
            surface: { visible: true, permission: "allow" },
            switch_agent: { visible: true, permission: "allow" },
            multi_agent_fanout: { visible: true, permission: "allow" },
          },
        },
      },
    },
  } as const

  for (const mode of ["explicit", "inherit"] as const) {
    it.live(`merges inherited overrides and replaces explicit project JSON policies (${mode})`, () =>
      withConfigTree(
        {
          global,
          local: {
            agent: {
              build: {
                tools: { mode, entries: { read: { visible: true, permission: "ask" } } },
              },
            },
          },
        },
        Effect.gen(function* () {
          const build = (yield* Config.use.get()).agent?.build
          const tools = { mode, entries: {
            ...(mode === "inherit" ? global.agent.build.tools.entries : {}),
            read: { visible: true, permission: "ask" },
          } } as const
          expect(build?.tools).toEqual(tools)
          expect(build?.options?.__agentTools).toEqual(tools)
          expect(build?.options?.custom).toBe("preserved")
          expect(build?.description).toBe("Global build")
        }),
      ),
    )
  }

  for (const mode of ["explicit", "inherit"] as const) {
    for (const normalized of [false, true]) {
      it.live(`replaces a policy with omitted entries (${mode}, normalized=${normalized})`, () =>
        withConfigTree(
          {
            global,
            local: {
              agent: {
                build: normalized ? { options: { __agentTools: { mode } } } : { tools: { mode } },
              },
            },
          },
          Effect.gen(function* () {
            const build = (yield* Config.use.get()).agent?.build
            const tools = mode === "inherit" ? { mode, entries: global.agent.build.tools.entries } : { mode }
            expect(build?.tools).toEqual(tools)
            expect(build?.options?.__agentTools).toEqual(tools)
            expect(build?.options?.custom).toBe("preserved")
          }),
        ),
      )
    }
  }

  for (const folder of ["agents", "modes"]) {
    it.live(`replaces structured tool policies from project ${folder} Markdown`, () =>
      withGlobalConfig({ config: global }, () =>
        Effect.gen(function* () {
          const dir = yield* tmpdirScoped()
          yield* FSUtil.use.writeWithDirs(
            path.join(dir, ".opencode", folder, "build.md"),
            `---
model: test/project-model
tools:
  mode: explicit
  entries:
    read:
      visible: true
      permission: ask
---
Project instructions
`,
          )
          return yield* withInstanceDir(
            dir,
            Effect.gen(function* () {
              const build = (yield* Config.use.get()).agent?.build
              const tools = { mode: "explicit", entries: { read: { visible: true, permission: "ask" } } } as const
              expect(build?.tools).toEqual(tools)
              expect(build?.options?.__agentTools).toEqual(tools)
              expect(build?.options?.custom).toBe("preserved")
              expect(build?.model).toBe("test/project-model")
            }),
          )
        }),
      ),
    )
  }

  it.live("preserves a tool policy when a project only overrides agent metadata", () =>
    withConfigTree(
      { global, local: { agent: { build: { description: "Local build" } } } },
      Effect.gen(function* () {
        const build = (yield* Config.use.get()).agent?.build
        expect(build?.tools).toEqual(global.agent.build.tools)
        expect(build?.options?.__agentTools).toEqual(global.agent.build.tools)
        expect(build?.description).toBe("Local build")
      }),
    ),
  )

  it.live("allows an explicit empty policy to hide all inherited tools", () =>
    withConfigTree(
      { global, local: { agent: { build: { tools: { mode: "explicit", entries: {} } } } } },
      Effect.gen(function* () {
        const build = (yield* Config.use.get()).agent?.build
        expect(build?.tools).toEqual({ mode: "explicit", entries: {} })
        expect(build?.options?.__agentTools).toEqual({ mode: "explicit", entries: {} })
      }),
    ),
  )

  it.live("replaces the legacy normalized tool policy without reviving its old entries", () =>
    withConfigTree(
      {
        global,
        local: { agent: { build: { options: { __agentTools: { mode: "explicit", entries: {} } } } } },
      },
      Effect.gen(function* () {
        const build = (yield* Config.use.get()).agent?.build
        expect(build?.tools).toEqual({ mode: "explicit", entries: {} })
        expect(build?.options?.__agentTools).toEqual({ mode: "explicit", entries: {} })
        expect(build?.options?.custom).toBe("preserved")
      }),
    ),
  )

  it.live("keeps a legacy inline mode policy atomic when converting it to an agent", () =>
    withConfigTree(
      {
        global,
        local: { mode: { build: { tools: { mode: "explicit", entries: {} } } } },
      },
      Effect.gen(function* () {
        const build = (yield* Config.use.get()).agent?.build
        expect(build?.tools).toEqual({ mode: "explicit", entries: {} })
        expect(build?.options?.__agentTools).toEqual({ mode: "explicit", entries: {} })
        expect(build?.mode).toBe("primary")
      }),
    ),
  )

  for (const source of [
    { mode: "explicit", entries: {} },
    { mode: "explicit" },
    { mode: "explicit", entries: { read: { visible: true, permission: "ask" } } },
  ] as const) {
    const tools = ConfigParse.schema(ConfigAgentV1.Info, { tools: source }, "test:migrated-policy").tools
    it.live(`honors a migrated normalized policy beside an empty legacy map (${JSON.stringify(tools)})`, () =>
      withConfigTree(
        { global, local: { agent: { build: { tools: {}, options: { __agentTools: tools } } } } },
        Effect.gen(function* () {
          const build = (yield* Config.use.get()).agent?.build
          expect(build?.tools).toEqual(tools)
          expect(build?.options?.__agentTools).toEqual(tools)
        }),
      ),
    )
  }

  it.live("does not replay a global legacy mode over a project JSON agent", () =>
    withConfigTree(
      {
        global: { mode: global.agent },
        local: { agent: { build: { tools: { mode: "explicit", entries: {} } } } },
      },
      Effect.gen(function* () {
        const build = (yield* Config.use.get()).agent?.build
        expect(build?.tools).toEqual({ mode: "explicit", entries: {} })
        expect(build?.options?.__agentTools).toEqual({ mode: "explicit", entries: {} })
      }),
    ),
  )

  it.live("does not replay global legacy mode metadata over a later project agent", () =>
    withConfigTree(
      { global: { mode: global.agent }, local: { agent: { build: { description: "Project build" } } } },
      Effect.gen(function* () {
        const build = (yield* Config.use.get()).agent?.build
        expect(build?.tools).toEqual(global.agent.build.tools)
        expect(build?.description).toBe("Project build")
        expect(build?.mode).toBe("primary")
      }),
    ),
  )

  it.live("does not replay a global legacy mode over a project Markdown agent", () =>
    withGlobalConfig({ config: { mode: global.agent } }, () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        yield* FSUtil.use.writeWithDirs(
          path.join(dir, ".opencode", "agents", "build.md"),
          `---
description: Project build
tools:
  mode: explicit
  entries: {}
---
`,
        )
        return yield* withInstanceDir(
          dir,
          Effect.gen(function* () {
            const build = (yield* Config.use.get()).agent?.build
            expect(build?.tools).toEqual({ mode: "explicit", entries: {} })
            expect(build?.options?.__agentTools).toEqual({ mode: "explicit", entries: {} })
            expect(build?.description).toBe("Project build")
          }),
        )
      }),
    ),
  )

  it.live("normalizes legacy modes separately across global config documents", () =>
    withGlobalConfig({ config: { mode: global.agent }, name: "config.json" }, ({ dir }) =>
      Effect.gen(function* () {
        yield* writeConfigEffect(dir, schemaConfig({ agent: { build: { tools: { mode: "explicit", entries: {} } } } }))
        const project = yield* tmpdirScoped()
        return yield* withInstanceDir(
          project,
          Effect.gen(function* () {
            const build = (yield* Config.use.get()).agent?.build
            expect(build?.tools).toEqual({ mode: "explicit", entries: {} })
            expect(build?.options?.__agentTools).toEqual({ mode: "explicit", entries: {} })
          }),
        )
      }),
    ),
  )

  it.live("preserves legacy mode precedence within the same document", () =>
    withConfigTree(
      { local: { agent: global.agent, mode: { build: { tools: { mode: "explicit", entries: {} } } } } },
      Effect.gen(function* () {
        const build = (yield* Config.use.get()).agent?.build
        expect(build?.tools).toEqual({ mode: "explicit", entries: {} })
        expect(build?.mode).toBe("primary")
      }),
    ),
  )

  it.live("saves project tool policies atomically without persisting normalized aliases", () =>
    withConfigTree(
      { local: global },
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const tools = { mode: "explicit", entries: { read: { visible: true, permission: "ask" } } } as const
        yield* Config.use.update(
          ConfigParse.schema(ConfigV1.Info, { agent: { build: { tools } } }, "test:project-save"),
        )
        const written = (yield* FSUtil.use.readJson(path.join(instance.directory, ".opencode", "opencode.json"))) as {
          agent: Record<string, { tools?: unknown; options?: Record<string, unknown> }>
        }
        expect(written.agent.build.tools).toEqual(tools)
        expect(written.agent.build.options?.__agentTools).toBeUndefined()
        const reloaded = (yield* Config.use.get()).agent?.build
        expect(reloaded?.tools).toEqual(tools)
        expect(reloaded?.options?.__agentTools).toEqual(tools)
      }),
    ),
  )

  it.live("does not mutate cached global agents while materializing an instance", () =>
    withConfigTree(
      { global },
      Effect.gen(function* () {
        const cached = (yield* Config.use.getGlobal()).agent?.build
        const options = cached?.options
        yield* Config.use.get()
        expect(cached?.options).toBe(options)
        expect(cached?.tools).toEqual(global.agent.build.tools)
      }),
    ),
  )

  it.live("keeps legacy boolean maps as permission overrides without changing an explicit list", () =>
    withConfigTree(
      { global, local: { agent: { build: { tools: { bash: false } } } } },
      Effect.gen(function* () {
        const build = (yield* Config.use.get()).agent?.build
        expect(build?.options?.__agentTools).toEqual(global.agent.build.tools)
        expect(build?.permission?.bash).toBe("deny")
      }),
    ),
  )

  it.live("inherits tool-policy restrictions alongside sparse project overrides", () =>
    withConfigTree(
      {
        global: {
          agent: {
            build: {
              permission: { bash: "deny" },
              tools: { mode: "inherit", entries: { bash: { permission: "deny" } } },
            },
          },
        },
        local: { agent: { build: { tools: { mode: "inherit", entries: { read: { permission: "ask" } } } } } },
      },
      Effect.gen(function* () {
        const build = (yield* Config.use.get()).agent?.build
        expect(build?.tools).toEqual({ mode: "inherit", entries: { bash: { permission: "deny" }, read: { permission: "ask" } } })
        expect(build?.options?.__agentTools).toEqual(build?.tools)
        expect(build?.permission?.bash).toBe("deny")
      }),
    ),
  )

  for (const tools of ["all", true]) {
    const remote = wellKnown({
      remoteConfig: { url: "https://config.example.com/opencode.json" },
      remote: { agent: { build: { tools } } },
    })
    remote.it.live(`reports malformed remote tools as a config error (${JSON.stringify(tools)})`, () =>
      withConfigTree(
        {},
        Effect.gen(function* () {
          const exit = yield* Config.use.get().pipe(Effect.exit)
          const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
          expect(NamedError.hasName(error, "ConfigInvalidError")).toBe(true)
        }),
      ),
    )
  }

  for (const tools of ["all", { mode: "bogus" }]) {
    it.live(`rejects a malformed normalized policy with a readable config error (${JSON.stringify(tools)})`, () =>
      withConfigTree(
        { local: { agent: { build: { options: { __agentTools: tools } } } } },
        Effect.gen(function* () {
          const exit = yield* Config.use.get().pipe(Effect.exit)
          const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
          expect(NamedError.hasName(error, "ConfigInvalidError")).toBe(true)
          expect((error as { data?: { path?: string } }).data?.path).toBe("agent:build:tools")
        }),
      ),
    )
  }

  const remotePolicies = wellKnown({
    config: { mode: global.agent },
    remoteConfig: { url: "https://config.example.com/opencode.json" },
    remote: { agent: { build: { tools: { mode: "explicit", entries: {} } } } },
  })
  remotePolicies.it.live("normalizes embedded and fetched remote modes before merging policies", () =>
    withConfigTree(
      {},
      Effect.gen(function* () {
        const build = (yield* Config.use.get()).agent?.build
        expect(build?.tools).toEqual({ mode: "explicit", entries: {} })
        expect(build?.options?.__agentTools).toEqual({ mode: "explicit", entries: {} })
      }),
    ),
  )

  const remotePartial = wellKnown({
    config: { command: { review: { template: "Review changes", description: "Original" } } },
    remoteConfig: { url: "https://config.example.com/opencode.json" },
    remote: { command: { review: { description: "Updated" } } },
  })
  remotePartial.it.live("preserves remote partial patches until combined-config validation", () =>
    withConfigTree(
      {},
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config.command?.review?.template).toBe("Review changes")
        expect(config.command?.review?.description).toBe("Updated")
      }),
    ),
  )

  for (const mode of ["invalid", { build: null }]) {
    const remote = wellKnown({
      remoteConfig: { url: "https://config.example.com/opencode.json" },
      remote: { mode },
    })
    remote.it.live(`validates malformed remote legacy modes (${JSON.stringify(mode)})`, () =>
      withConfigTree(
        {},
        Effect.gen(function* () {
          const exit = yield* Config.use.get().pipe(Effect.exit)
          const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
          expect(NamedError.hasName(error, "ConfigInvalidError")).toBe(true)
        }),
      ),
    )
  }

  it.live("keeps legacy boolean tool maps as partial permission overrides", () =>
    withConfigTree(
      {
        global: { agent: { build: { tools: { read: true, bash: true } } } },
        local: { agent: { build: { tools: { bash: false } } } },
      },
      Effect.gen(function* () {
        const build = (yield* Config.use.get()).agent?.build
        expect(build?.tools).toEqual({ read: true, bash: false })
        expect(build?.options?.__agentTools).toBeUndefined()
      }),
    ),
  )
})

it.effect("replaces structured agent tools in jsonc while preserving comments", () =>
  withGlobalConfig({ name: "opencode.jsonc" }, ({ dir }) =>
    Effect.gen(function* () {
      const file = path.join(dir, "opencode.jsonc")
      yield* FSUtil.use.writeFileString(
        file,
        `{
  // keep this comment
  "agent": {
    "build": {
      "tools": { "mode": "explicit", "entries": { "websearch": { "visible": true, "permission": "allow" } } },
      "options": { "__agentTools": { "mode": "explicit", "entries": { "websearch": { "visible": true, "permission": "allow" } } } }
    }
  }
}`,
      )
      yield* Config.use.updateGlobal(
        ConfigParse.schema(
          ConfigV1.Info,
          {
            agent: {
              build: {
                tools: {
                  mode: "explicit",
                  entries: { read: { visible: true, permission: "allow" } },
                },
              },
            },
          },
          "test:agent-tools-jsonc",
        ),
      )

      const written = yield* FSUtil.use.readFileString(file)
      const raw = ConfigParse.jsonc(written, file) as Record<string, Record<string, Record<string, unknown>>>
      expect(written).toContain("// keep this comment")
      expect(raw.agent.build.tools).toEqual({
        mode: "explicit",
        entries: { read: { visible: true, permission: "allow" } },
      })
      expect((raw.agent.build.options as Record<string, unknown> | undefined)?.__agentTools).toBeUndefined()
    }),
  ),
)

test("classifies runtime-safe config patches as non-reloading", () => {
  expect(Config.requiresInstanceReload({ optimization: { profile: "off" } })).toBe(false)
  expect(Config.requiresInstanceReload({ logging: { profile: "off" } })).toBe(false)
  expect(Config.requiresInstanceReload({ project_icon_generation: { enabled: true } })).toBe(false)
  expect(Config.requiresInstanceReload({ access_control: { mode: "full_access" } })).toBe(false)
  expect(Config.requiresInstanceReload({ access_control: { mode: "approve_for_me" } })).toBe(false)
  expect(
    Config.requiresInstanceReload({
      access_control: { mode: "approve_for_me", safety_review: { model: "openai/gpt-5.5" } },
    }),
  ).toBe(true)
  expect(Config.requiresInstanceReload({ multi_agent: { review: { reviewers: [{ model: "openai/gpt-5.5" }] } } })).toBe(false)
  expect(Config.requiresInstanceReload({ optimization: { profile: "off" }, disabled_providers: ["anthropic"] })).toBe(true)
  expect(Config.requiresInstanceReload({ agent: { build: { description: "updated" } } })).toBe(true)
  expect(Config.requiresAgentRefresh({})).toBe(false)
  expect(Config.requiresAgentRefresh({ agent: { build: { description: "updated" } } })).toBe(true)
  expect(Config.requiresAgentRefresh({ mode: { build: { description: "updated" } } })).toBe(true)
  expect(Config.requiresAgentRefresh({ agent: { build: { description: "updated" } }, optimization: { profile: "off" } })).toBe(true)
  expect(
    Config.requiresAgentRefresh({
      agent: { build: { description: "updated" } },
      access_control: { mode: "approve_for_me", safety_review: { model: "m" } },
    }),
  ).toBe(false)
  expect(Config.requiresAgentRefresh({ mode: { build: { description: "updated" } }, disabled_providers: ["anthropic"] })).toBe(false)
})

test("parses logging config", () => {
  const config = ConfigParse.schema(
    ConfigV1.Info,
    {
      $schema: "https://opencode.ai/config.json",
      logging: {
        profile: "verbose",
        features: {
          trace: true,
          performance: true,
          interrupts: true,
          optimization: true,
          ui: true,
        },
      },
    },
    "test:config",
  )

  expect(config.logging?.profile).toBe("verbose")
  expect(config.logging?.features?.performance).toBe(true)
})

it.live("global config recovers after its first reader is cancelled", () =>
  withConfigTree(
    { global: { optimization: { profile: "safe" } } },
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const read = fs.readFileStringSafe
      const started = yield* Deferred.make<void>()
      let paused = false
      const spy = spyOn(fs, "readFileStringSafe").mockImplementation((file) => {
        if (paused || file !== path.join(Global.Path.config, "opencode.json")) return read(file)
        paused = true
        return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()))
      const first = yield* Config.use.getGlobal().pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(first)

      const recovered = yield* Config.use.getGlobal().pipe(Effect.exit)
      expect(Exit.isSuccess(recovered)).toBe(true)
      if (Exit.isSuccess(recovered)) expect(recovered.value.optimization?.profile).toBe("safe")
    }),
  ),
)

it.live("global config update cannot be overwritten by an older in-flight read", () =>
  withConfigTree(
    { global: { optimization: { profile: "safe" } } },
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const read = fs.readFileStringSafe
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let paused = false
      const spy = spyOn(fs, "readFileStringSafe").mockImplementation((file) => {
        if (paused || file !== path.join(Global.Path.config, "opencode.json")) return read(file)
        paused = true
        return read(file).pipe(
          Effect.tap(() => Deferred.succeed(started, undefined)),
          Effect.tap(() => Deferred.await(release)),
        )
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()))
      const first = yield* Config.use.getGlobal().pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Config.use.updateGlobal({ optimization: { profile: "off" } })
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)

      expect((yield* Config.use.getGlobal()).optimization?.profile).toBe("off")
    }),
  ),
)

it.effect("global config update invalidates loaded instance config", () =>
  withConfigTree(
    { global: { optimization: { profile: "safe" } } },
    Effect.gen(function* () {
      expect((yield* Config.use.get()).optimization?.profile).toBe("safe")

      yield* Config.use.updateGlobal({ optimization: { profile: "off" } })

      expect((yield* Config.use.get()).optimization?.profile).toBe("off")
    }),
  ),
)

it.instance(
  "project saves preserve unknown keys and JSONC comments in the same document",
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const file = path.join(instance.directory, ".opencode", "opencode.json")
    yield* FSUtil.use.writeWithDirs(file, '// keep future settings\n{ "future_setting": { "keep": true }, "username": "before" }')
    yield* Config.use.update({ username: "after" })
    const written = yield* FSUtil.use.readFileString(file)
    expect(written).toContain("// keep future settings")
    expect(ConfigParse.jsonc(written, file)).toMatchObject({ username: "after", future_setting: { keep: true } })
  }),
)

it.instance(
  "project config update invalidates loaded instance config",
  Effect.gen(function* () {
    expect((yield* Config.use.get()).optimization?.profile).toBe("safe")

    yield* Config.use.update({ optimization: { profile: "off" } })

    expect((yield* Config.use.get()).optimization?.profile).toBe("off")
  }),
  { config: { optimization: { profile: "safe" } } },
)

it.instance(
  "loads formatter boolean config",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.formatter).toBe(true)
  }),
  { config: { formatter: true } },
)

it.instance(
  "loads lsp boolean config",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.lsp).toBe(true)
  }),
  { config: { lsp: true } },
)

test("loads project config from Git Bash and MSYS2 paths on Windows", async () => {
  // Git Bash and MSYS2 both use /<drive>/... paths on Windows.
  await check((dir) => {
    const drive = dir[0].toLowerCase()
    const rest = dir.slice(2).replaceAll("\\", "/")
    return `/${drive}${rest}`
  })
}, 60_000)

test("loads project config from Cygwin paths on Windows", async () => {
  await check((dir) => {
    const drive = dir[0].toLowerCase()
    const rest = dir.slice(2).replaceAll("\\", "/")
    return `/cygdrive/${drive}${rest}`
  })
})

it.instance("ignores legacy tui keys in opencode config", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      model: "test/model",
      theme: "legacy",
      tui: { scroll_speed: 4 },
    })

    const config = yield* Config.use.get()
    expect(config.model).toBe("test/model")
    expect((config as Record<string, unknown>).theme).toBeUndefined()
    expect((config as Record<string, unknown>).tui).toBeUndefined()
  }),
)

it.instance("loads JSONC config file", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, "opencode.jsonc"),
      `{
        // This is a comment
        "$schema": "https://opencode.ai/config.json",
        "model": "test/model",
        "username": "testuser"
      }`,
    )
    const config = yield* Config.use.get()
    expect(config.model).toBe("test/model")
    expect(config.username).toBe("testuser")
  }),
)

it.instance("jsonc overrides json in the same directory", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(
      test.directory,
      {
        $schema: "https://opencode.ai/config.json",
        model: "base",
        username: "base",
      },
      "opencode.jsonc",
    )
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      model: "override",
    })
    const config = yield* Config.use.get()
    expect(config.model).toBe("base")
    expect(config.username).toBe("base")
  }),
)

it.instance("handles environment variable substitution", () =>
  withProcessEnv(
    "TEST_VAR",
    "test-user",
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* writeConfigEffect(test.directory, {
        $schema: "https://opencode.ai/config.json",
        username: "{env:TEST_VAR}",
      })
      const config = yield* Config.use.get()
      expect(config.username).toBe("test-user")
    }),
  ),
)

it.instance("preserves env variables when adding $schema to config", () =>
  withProcessEnv(
    "PRESERVE_VAR",
    "secret_value",
    Effect.gen(function* () {
      const test = yield* TestInstance
      // Config without $schema - should trigger auto-add
      yield* FSUtil.use.writeWithDirs(
        path.join(test.directory, "opencode.json"),
        JSON.stringify({ username: "{env:PRESERVE_VAR}" }),
      )
      const config = yield* Config.use.get()
      expect(config.username).toBe("secret_value")

      // Read the file to verify the env variable was preserved
      const content = yield* FSUtil.use.readFileString(path.join(test.directory, "opencode.json"))
      expect(content).toContain("{env:PRESERVE_VAR}")
      expect(content).not.toContain("secret_value")
      expect(content).toContain("$schema")
    }),
  ),
)

it.instance("handles file inclusion substitution", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(path.join(test.directory, "included.txt"), "test-user")
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      username: "{file:included.txt}",
    })
    const config = yield* Config.use.get()
    expect(config.username).toBe("test-user")
  }),
)

it.instance("handles file inclusion with replacement tokens", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(path.join(test.directory, "included.md"), "const out = await Bun.$`echo hi`")
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      username: "{file:included.md}",
    })
    const config = yield* Config.use.get()
    expect(config.username).toBe("const out = await Bun.$`echo hi`")
  }),
)

const accountTokenIt = configIt({
  account: Layer.mock(Account.Service)({
    active: () =>
      Effect.succeed(
        Option.some({
          id: AccountID.make("account-1"),
          email: "user@example.com",
          url: "https://control.example.com",
          active_org_id: OrgID.make("org-1"),
        }),
      ),
    activeOrg: () =>
      Effect.succeed(
        Option.some({
          account: {
            id: AccountID.make("account-1"),
            email: "user@example.com",
            url: "https://control.example.com",
            active_org_id: OrgID.make("org-1"),
          },
          org: {
            id: OrgID.make("org-1"),
            name: "Example Org",
          },
        }),
      ),
    config: () =>
      Effect.succeed(
        Option.some({
          provider: { opencode: { options: { apiKey: "{env:OPENCODE_CONSOLE_TOKEN}" } } },
        }),
      ),
    token: () => Effect.succeed(Option.some(AccessToken.make("st_test_token"))),
  }),
})

accountTokenIt.instance("resolves env templates in account config with account token", () =>
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.provider?.["opencode"]?.options?.apiKey).toBe("st_test_token")
  }),
)

it.instance("validates config schema and throws on invalid values", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      share: "not-a-valid-share-mode",
    })
    const exit = yield* Config.use.get().pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
  }),
)

it.instance("loads skill_capabilities and ignores unknown project config keys", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      skill_capabilities: { "spawn-new-agent": ["spawn_agent"] },
      unknown_future_key: true,
    })
    const config = yield* Config.use.get()
    expect(config.skill_capabilities).toEqual({ "spawn-new-agent": ["spawn_agent"] })
    expect("unknown_future_key" in config).toBe(false)
  }),
)

it.instance("throws error for invalid JSON", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(path.join(test.directory, "opencode.json"), "{ invalid json }")
    const exit = yield* Config.use.get().pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
  }),
)

it.instance("handles agent configuration", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: {
        test_agent: {
          model: "test/model",
          temperature: 0.7,
          description: "test agent",
        },
      },
    })
    const config = yield* Config.use.get()
    expect(config.agent?.["test_agent"]).toEqual(
      expect.objectContaining({
        model: "test/model",
        temperature: 0.7,
        description: "test agent",
      }),
    )
  }),
)

it.instance("treats agent variant as model-scoped setting (not provider option)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: {
        test_agent: {
          model: "openai/gpt-5.2",
          variant: "xhigh",
          max_tokens: 123,
        },
      },
    })
    const config = yield* Config.use.get()
    const agent = config.agent?.["test_agent"]

    expect(agent?.variant).toBe("xhigh")
    expect(agent?.options).toMatchObject({
      max_tokens: 123,
    })
    expect(agent?.options).not.toHaveProperty("variant")
  }),
)

it.instance("handles command configuration", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      command: {
        test_command: {
          template: "test template",
          description: "test command",
          agent: "test_agent",
        },
      },
    })
    const config = yield* Config.use.get()
    expect(config.command?.["test_command"]).toEqual({
      template: "test template",
      description: "test command",
      agent: "test_agent",
    })
  }),
)

it.instance("migrates autoshare to share field", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      autoshare: true,
    })
    const config = yield* Config.use.get()
    expect(config.share).toBe("auto")
    expect(config.autoshare).toBe(true)
  }),
)

it.instance("migrates mode field to agent field", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      mode: {
        test_mode: {
          model: "test/model",
          temperature: 0.5,
        },
      },
    })
    const config = yield* Config.use.get()
    expect(config.agent?.["test_mode"]).toEqual({
      model: "test/model",
      temperature: 0.5,
      mode: "primary",
      options: {},
      permission: {},
    })
  }),
)

it.instance("accepts the deprecated reference field", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      reference: {
        local: { path: "../library" },
        sdk: { repository: "github.com/example/sdk", branch: "main" },
        shorthand: "github.com/example/docs",
      },
    })
    const config = yield* Config.use.get()
    expect(config.reference).toEqual({
      local: { path: "../library" },
      sdk: { repository: "github.com/example/sdk", branch: "main" },
      shorthand: "github.com/example/docs",
    })
  }),
)

it.instance("loads config from .opencode directory", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".opencode", "agent", "test.md"),
      `---
model: test/model
---
Test agent prompt`,
    )

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]).toEqual(
      expect.objectContaining({
        name: "test",
        model: "test/model",
        prompt: "Test agent prompt",
      }),
    )
  }),
)

it.instance("agent markdown permission config preserves user key order", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".opencode", "agent", "ordered.md"),
      `---
permission:
  bash: allow
  "*": deny
  edit: ask
---
Ordered permissions`,
    )

    const config = yield* Config.use.get()
    expect(Object.keys(config.agent?.ordered?.permission ?? {})).toEqual(["bash", "*", "edit"])
  }),
)

it.instance("loads agents from .opencode/agents (plural)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".opencode", "agents", "helper.md"),
      `---
model: test/model
mode: subagent
---
Helper agent prompt`,
    )

    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".opencode", "agents", "nested", "child.md"),
      `---
model: test/model
mode: subagent
---
Nested agent prompt`,
    )

    const config = yield* Config.use.get()

    expect(config.agent?.["helper"]).toMatchObject({
      name: "helper",
      model: "test/model",
      mode: "subagent",
      prompt: "Helper agent prompt",
    })

    expect(config.agent?.["nested/child"]).toMatchObject({
      name: "nested/child",
      model: "test/model",
      mode: "subagent",
      prompt: "Nested agent prompt",
    })
  }),
)

it.instance("loads commands from .opencode/command (singular)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".opencode", "command", "hello.md"),
      `---
description: Test command
---
Hello from singular command`,
    )

    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".opencode", "command", "nested", "child.md"),
      `---
description: Nested command
---
Nested command template`,
    )

    const config = yield* Config.use.get()

    expect(config.command?.["hello"]).toEqual({
      description: "Test command",
      template: "Hello from singular command",
    })

    expect(config.command?.["nested/child"]).toEqual({
      description: "Nested command",
      template: "Nested command template",
    })
  }),
)

it.instance("loads commands from .opencode/commands (plural)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".opencode", "commands", "hello.md"),
      `---
description: Test command
---
Hello from plural commands`,
    )

    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".opencode", "commands", "nested", "child.md"),
      `---
description: Nested command
---
Nested command template`,
    )

    const config = yield* Config.use.get()

    expect(config.command?.["hello"]).toEqual({
      description: "Test command",
      template: "Hello from plural commands",
    })

    expect(config.command?.["nested/child"]).toEqual({
      description: "Nested command",
      template: "Nested command template",
    })
  }),
)

it.instance("updates config and writes to file", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* Config.Service.use((svc) =>
      svc.update(ConfigParse.schema(ConfigV1.Info, { model: "updated/model" }, "test:config")),
    )

    const writtenConfig = yield* FSUtil.use.readJson(path.join(test.directory, ".opencode", "opencode.json"))
    expect(writtenConfig).toMatchObject({ model: "updated/model" })
  }),
)

it.instance("gets config directories", () =>
  Effect.gen(function* () {
    const dirs = yield* Config.use.directories()
    expect(dirs.length).toBeGreaterThanOrEqual(1)
  }),
)

it.effect("does not try to install dependencies in read-only OPENCODE_CONFIG_DIR", () =>
  Effect.gen(function* () {
    if (process.platform === "win32") return

    const dir = yield* tmpdirScoped()
    const readonly = path.join(dir, "readonly")
    yield* FSUtil.use.ensureDir(readonly)
    yield* FSUtil.use.chmod(readonly, 0o555)
    yield* Effect.addFinalizer(() => FSUtil.use.chmod(readonly, 0o755).pipe(Effect.ignore))

    yield* withProcessEnv("OPENCODE_CONFIG_DIR", readonly, Config.use.get().pipe(provideInstanceEffect(dir)))
  }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
)

it.effect("installs dependencies in writable OPENCODE_CONFIG_DIR", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const configDir = path.join(dir, "configdir")
    yield* FSUtil.use.ensureDir(configDir)

    yield* withProcessEnv(
      "OPENCODE_CONFIG_DIR",
      configDir,
      Config.Service.use((svc) => svc.get().pipe(Effect.andThen(svc.waitForDependencies()))).pipe(
        provideInstanceEffect(dir),
      ),
    )

    expect(yield* FSUtil.use.readFileString(path.join(configDir, ".gitignore"))).toContain("package-lock.json")
  }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
)

// Fresh gates and a fresh Npm layer per test: shared module-global deferreds
// let a later test see pre-opened gates and pass for the wrong reason.
function gatedDependencyInstall() {
  const started = Deferred.makeUnsafe<void>()
  const released = Deferred.makeUnsafe<void>()
  const interrupted = Deferred.makeUnsafe<void>()
  let calls = 0
  const layer = Layer.mock(Npm.Service)({
    install: () => {
      calls++
      return Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(released)),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      )
    },
  })
  return { layer, started, released, interrupted, calls: () => calls }
}

const cancelGate = gatedDependencyInstall()
configIt({ npm: cancelGate.layer }).live("cancels dependency installs when config is invalidated", () =>
  withConfigTree({}, Effect.gen(function* () {
    expect(yield* Deferred.isDone(cancelGate.started)).toBe(false)
    yield* Effect.addFinalizer(() => Deferred.succeed(cancelGate.released, undefined))
    yield* Config.use.get()
    yield* Deferred.await(cancelGate.started)
    expect(yield* Deferred.isDone(cancelGate.interrupted)).toBe(false)
    yield* Config.use.invalidate()
    yield* Deferred.await(cancelGate.interrupted).pipe(Effect.timeout("5 seconds"))
    expect(yield* Deferred.isDone(cancelGate.interrupted)).toBe(true)
  })),
)

// Snapshot-before-invalidate discriminator: the old entry is fully loaded
// (get returns, old install in flight), the waiter deterministically reaches
// the waitForDependencies snapshot point for that entry (probe fires), and
// only then invalidate fires. The probe orders snapshot-before-invalidate;
// it does NOT by itself prove the waiter already registered a Fiber.join —
// the discriminator is that with retry disabled this exact sequence must
// fail the success assertion, and with the candidate it must pass it.
const surviveGate = gatedDependencyInstall()
configIt({ npm: surviveGate.layer }).live("a still-needed bootstrap survives a concurrent invalidation", () =>
  withConfigTree({}, Effect.gen(function* () {
    expect(yield* Deferred.isDone(surviveGate.started)).toBe(false)
    yield* Effect.addFinalizer(() => Deferred.succeed(surviveGate.released, undefined))
    // 1. Old entry fully loaded: get() returns (lookup finished, entry cached).
    const loaded = yield* Config.use.get()
    expect(loaded.username).toBeDefined()
    // Old entry's real dependency install is in flight (parked, not finished).
    yield* Deferred.await(surviveGate.started)
    // 2. Waiter reaches the snapshot point for the OLD entry: the probe fires
    // after the snapshot, before the Fiber.join below runs.
    const snapshotReached = yield* Deferred.make<void>()
    const waiter = yield* Effect.forkScoped(
      Config.Service.use((svc) => svc.waitForDependencies()).pipe(
        Effect.provideService(Config.WaitJoinProbe, {
          snapshot: () => Deferred.succeed(snapshotReached, undefined),
        }),
      ),
    )
    yield* Deferred.await(snapshotReached)
    // Waiter liveness via the installed pollUnsafe hook: Fiber exposes no
    // exported Effect isDone; the only liveness read is the immediate
    // pollUnsafe runtime hook (undefined = still running).
    expect(waiter.pollUnsafe()).toBeUndefined()
    expect(yield* Deferred.isDone(surviveGate.interrupted)).toBe(false)
    // 3. Only now invalidate: this retires the entry the waiter snapshot.
    yield* Config.use.invalidate()
    yield* Deferred.await(surviveGate.interrupted).pipe(Effect.timeout("5 seconds"))
    yield* Deferred.succeed(surviveGate.released, undefined)
    const exit = yield* Effect.exit(Fiber.join(waiter))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(surviveGate.calls()).toBe(2)
  })),
)

// A waiter interrupted by its own scope before the join finishes must not be
// revived by a later invalidation of the same directory: the join fails with
// interrupt and no replacement install is started. Narrow claim only — this
// does NOT cover cross-directory invalidation (see two-project HTTP repro).
const abortGate = gatedDependencyInstall()
configIt({ npm: abortGate.layer }).live("a self-interrupted wait is never revived by a later invalidation", () =>
  withConfigTree({}, Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Deferred.succeed(abortGate.released, undefined))
    yield* Config.use.get()
    yield* Deferred.await(abortGate.started)
    const snapshotReached = yield* Deferred.make<void>()
    const waiter = yield* Effect.forkScoped(
      Config.Service.use((svc) => svc.waitForDependencies()).pipe(
        Effect.provideService(Config.WaitJoinProbe, {
          snapshot: () => Deferred.succeed(snapshotReached, undefined),
        }),
      ),
    )
    yield* Deferred.await(snapshotReached)
    expect(waiter.pollUnsafe()).toBeUndefined()
    yield* Fiber.interrupt(waiter)
    yield* Config.use.invalidate()
    const exit = yield* Effect.exit(Fiber.join(waiter))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(abortGate.calls()).toBe(1)
  })),
)

// Observed product semantics (config.ts exit-log + asVoid + forkScoped): a
// regular Npm.InstallFailedError in the background install is tolerated — the
// dependency fiber succeeds and waitForDependencies succeeds. Narrow claim:
// this gate pins "no failure surfaces, no retry install" only. It does NOT
// assert a warning was logged (no logger assertion wired); the call-count
// below proves no replacement install ran.
const toleratedGate = { calls: 0 }
configIt({
  npm: Layer.mock(Npm.Service)({
    install: () => {
      toleratedGate.calls++
      return Effect.fail(new Npm.InstallFailedError({ dir: "test-dir", add: [] }))
    },
  }),
}).live("a regular background install failure stays tolerated (no retry install)", () =>
  withConfigTree({}, Effect.gen(function* () {
    toleratedGate.calls = 0
    const exit = yield* Effect.exit(Config.Service.use((svc) => svc.waitForDependencies()))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(toleratedGate.calls).toBe(1)
  })),
)

// Negative control (permanent GREEN regression): same snapshot-before-
// invalidate ordering, retry seam wired to 0 at layer build. Without the
// retry the waiter must die on the pure retired interrupt: the exit is a
// failure, every reason is an interrupt reason, and no replacement install
// runs (calls stay 1). Original RED Exit-1 evidence (success assertion at the
// old line 2036) is preserved in history; this gate never asserts success so
// it stays green without deleting or skipping the RED proof.
const redGate = gatedDependencyInstall()
configIt({ npm: redGate.layer, maxDependencyRetireRetries: 0 }).live(
  "without the retirement retry the same sequence dies on pure interrupt",
  () =>
    withConfigTree({}, Effect.gen(function* () {
      expect(yield* Deferred.isDone(redGate.started)).toBe(false)
      yield* Effect.addFinalizer(() => Deferred.succeed(redGate.released, undefined))
      const loaded = yield* Config.use.get()
      expect(loaded.username).toBeDefined()
      yield* Deferred.await(redGate.started)
      const snapshotReached = yield* Deferred.make<void>()
      const waiter = yield* Effect.forkScoped(
        Config.Service.use((svc) => svc.waitForDependencies()).pipe(
          Effect.provideService(Config.WaitJoinProbe, {
            snapshot: () => Deferred.succeed(snapshotReached, undefined),
          }),
        ),
      )
      yield* Deferred.await(snapshotReached)
      expect(waiter.pollUnsafe()).toBeUndefined()
      expect(yield* Deferred.isDone(redGate.interrupted)).toBe(false)
      yield* Config.use.invalidate()
      yield* Deferred.await(redGate.interrupted).pipe(Effect.timeout("5 seconds"))
      yield* Deferred.succeed(redGate.released, undefined)
      const exit = yield* Effect.exit(Fiber.join(waiter))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.length).toBeGreaterThan(0)
        expect(exit.cause.reasons.every((reason) => Cause.isInterruptReason(reason))).toBe(true)
      }
      expect(redGate.calls()).toBe(1)
    })),
)

// Default seam honesty: explicit retries 2 behaves exactly like the unwired
// production default (success + second install on the same ordering).
const defaultSeamGate = gatedDependencyInstall()
configIt({ npm: defaultSeamGate.layer, maxDependencyRetireRetries: 2 }).live(
  "explicit retries 2 matches the unwired production default",
  () =>
    withConfigTree({}, Effect.gen(function* () {
      expect(yield* Deferred.isDone(defaultSeamGate.started)).toBe(false)
      yield* Effect.addFinalizer(() => Deferred.succeed(defaultSeamGate.released, undefined))
      const loaded = yield* Config.use.get()
      expect(loaded.username).toBeDefined()
      yield* Deferred.await(defaultSeamGate.started)
      const snapshotReached = yield* Deferred.make<void>()
      const waiter = yield* Effect.forkScoped(
        Config.Service.use((svc) => svc.waitForDependencies()).pipe(
          Effect.provideService(Config.WaitJoinProbe, {
            snapshot: () => Deferred.succeed(snapshotReached, undefined),
          }),
        ),
      )
      yield* Deferred.await(snapshotReached)
      expect(waiter.pollUnsafe()).toBeUndefined()
      expect(yield* Deferred.isDone(defaultSeamGate.interrupted)).toBe(false)
      yield* Config.use.invalidate()
      yield* Deferred.await(defaultSeamGate.interrupted).pipe(Effect.timeout("5 seconds"))
      yield* Deferred.succeed(defaultSeamGate.released, undefined)
      const exit = yield* Effect.exit(Fiber.join(waiter))
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(defaultSeamGate.calls()).toBe(2)
    })),
)

it.effect("wires no wait-join probe in production (semantics unchanged)", () =>
  withConfigTree(
    {},
    Effect.gen(function* () {
      const probe = yield* Effect.serviceOption(Config.WaitJoinProbe)
      expect(Option.isNone(probe)).toBe(true)
    }),
  ),
)

it.effect("creates missing OPENCODE_CONFIG_DIR before writing dependency metadata", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const configDir = path.join(dir, "missing-configdir")

    yield* withProcessEnv(
      "OPENCODE_CONFIG_DIR",
      configDir,
      Config.Service.use((svc) => svc.get().pipe(Effect.andThen(svc.waitForDependencies()))).pipe(
        provideInstanceEffect(dir),
      ),
    )

    expect(yield* FSUtil.use.readFileString(path.join(configDir, ".gitignore"))).toContain("package-lock.json")
  }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
)

// Note: deduplication and serialization of npm installs is now handled by the
// core Npm.Service (via EffectFlock). Those behaviors are tested in the core
// package's npm tests, not here.

it.instance("resolves scoped npm plugins in config", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const pluginDir = path.join(test.directory, "node_modules", "@scope", "plugin")
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, "package.json"),
      JSON.stringify({ name: "config-fixture", version: "1.0.0", type: "module" }, null, 2),
    )
    yield* FSUtil.use.writeWithDirs(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "@scope/plugin",
          version: "1.0.0",
          type: "module",
          main: "./index.js",
        },
        null,
        2,
      ),
    )
    yield* FSUtil.use.writeWithDirs(path.join(pluginDir, "index.js"), "export default {}\n")
    yield* writeConfigEffect(test.directory, { plugin: ["@scope/plugin"] })

    const config = yield* Config.use.get()
    expect(config.plugin ?? []).toContain("@scope/plugin")
  }),
)

it.effect("merges plugin arrays from global and local configs", () =>
  withConfigTree(
    {
      global: { plugin: ["global-plugin-1", "global-plugin-2"] },
      local: { plugin: ["local-plugin-1"] },
    },
    Effect.gen(function* () {
      const plugins = (yield* Config.use.get()).plugin ?? []

      expect(plugins.some((p) => p.includes("global-plugin-1"))).toBe(true)
      expect(plugins.some((p) => p.includes("global-plugin-2"))).toBe(true)
      expect(plugins.some((p) => p.includes("local-plugin-1"))).toBe(true)
      expect(
        plugins.filter((p) => p.includes("global-plugin") || p.includes("local-plugin")).length,
      ).toBeGreaterThanOrEqual(3)
    }),
  ),
)

it.effect("global config remains global when project config is disabled", () =>
  withConfigTree(
    {
      global: { model: "global/model", plugin: ["global-plugin"] },
      project: { model: "project/model" },
      local: { model: "local/model" },
    },
    withProcessEnv(
      "OPENCODE_DISABLE_PROJECT_CONFIG",
      "true",
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config.model).toBe("global/model")
        expect(config.plugin_origins?.find((item) => item.spec === "global-plugin")?.scope).toBe("global")
      }),
    ),
  ),
)

it.instance("does not error when only custom agent is a subagent", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".opencode", "agent", "helper.md"),
      `---
model: test/model
mode: subagent
---
Helper subagent prompt`,
    )

    const config = yield* Config.use.get()
    expect(config.agent?.["helper"]).toMatchObject({
      name: "helper",
      model: "test/model",
      mode: "subagent",
      prompt: "Helper subagent prompt",
    })
  }),
)

it.effect("merges instructions arrays from global and local configs", () =>
  withConfigTree(
    {
      global: { instructions: ["global-instructions.md", "shared-rules.md"] },
      local: { instructions: ["local-instructions.md"] },
    },
    Effect.gen(function* () {
      expect((yield* Config.use.get()).instructions).toEqual([
        "global-instructions.md",
        "shared-rules.md",
        "local-instructions.md",
      ])
    }),
  ),
)

it.effect("deduplicates duplicate instructions from global and local configs", () =>
  withConfigTree(
    {
      global: { instructions: ["duplicate.md", "global-only.md"] },
      local: { instructions: ["duplicate.md", "local-only.md"] },
    },
    Effect.gen(function* () {
      expect((yield* Config.use.get()).instructions).toEqual(["duplicate.md", "global-only.md", "local-only.md"])
    }),
  ),
)

it.effect("deduplicates duplicate plugins from global and local configs", () =>
  withConfigTree(
    {
      global: { plugin: ["duplicate-plugin", "global-plugin-1"] },
      local: { plugin: ["duplicate-plugin", "local-plugin-1"] },
    },
    Effect.gen(function* () {
      const plugins = (yield* Config.use.get()).plugin ?? []

      expect(plugins.some((p) => p.includes("global-plugin-1"))).toBe(true)
      expect(plugins.some((p) => p.includes("local-plugin-1"))).toBe(true)
      expect(plugins.filter((p) => p.includes("duplicate-plugin")).length).toBe(1)
      expect(
        plugins.filter(
          (p) => p.includes("global-plugin") || p.includes("local-plugin") || p.includes("duplicate-plugin"),
        ).length,
      ).toBe(3)
    }),
  ),
)

it.effect("keeps plugin origins aligned with merged plugin list", () =>
  withConfigTree(
    {
      global: { plugin: [["shared-plugin@1.0.0", { source: "global" }], "global-only@1.0.0"] },
      local: { plugin: [["shared-plugin@2.0.0", { source: "local" }], "local-only@1.0.0"] },
    },
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      const plugins = config.plugin ?? []
      const origins = config.plugin_origins ?? []
      const names = plugins.map((item) => ConfigPlugin.pluginSpecifier(item))

      expect(names).toContain("shared-plugin@2.0.0")
      expect(names).not.toContain("shared-plugin@1.0.0")
      expect(names).toContain("global-only@1.0.0")
      expect(names).toContain("local-only@1.0.0")
      expect(origins.map((item) => item.spec)).toEqual(plugins)
      expect(origins.find((item) => ConfigPlugin.pluginSpecifier(item.spec) === "shared-plugin@2.0.0")?.scope).toBe(
        "local",
      )
    }),
  ),
)

it.instance(
  "keeps shared MCPs global and Self API tools built in",
  Effect.gen(function* () {
    const project = (yield* Effect.promise(() =>
      Bun.file(path.resolve(import.meta.dir, "../../../../.opencode/opencode.json")).json(),
    )) as Record<string, unknown>
    const { mergeDeep } = yield* Effect.promise(() => import("remeda"))
    const effective = mergeDeep(
      {
        mcp: {
          context7: {
            type: "remote",
            url: "https://mcp.context7.com/mcp",
            enabled: true,
          },
          "computer-use": {
            type: "local",
            command: ["npx", "-y", "computer-use-mcp"],
            enabled: true,
          },
        },
      },
      project,
    )
    const builtins = yield* Effect.promise(() =>
      Bun.file(path.resolve(import.meta.dir, "../../../core/src/tool/builtins.ts")).text(),
    )

    expect(project.mcp).toBeUndefined()
    expect(effective.mcp.context7).toEqual({
      type: "remote",
      url: "https://mcp.context7.com/mcp",
      enabled: true,
    })
    expect(effective.mcp["computer-use"]).toEqual({
      type: "local",
      command: ["npx", "-y", "computer-use-mcp"],
      enabled: true,
    })
    expect(builtins).toContain("SessionReadTool.layer")
    expect(builtins).toContain("SessionSendTool.layer")
  }),
)

it.effect(
  "project computer-use disable overrides global enable until the override is removed",
  Effect.gen(function* () {
    const globalMcp = {
      mcp: {
        "computer-use": {
          type: "local",
          command: ["npx", "-y", "computer-use-mcp"],
          enabled: true,
        },
      },
    }

    yield* withConfigTree(
      {
        global: globalMcp,
        local: {
          mcp: {
            "computer-use": {
              type: "local",
              command: ["npx", "-y", "computer-use-mcp"],
              enabled: false,
            },
          },
        },
      },
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config.mcp?.["computer-use"]?.enabled).toBe(false)
      }),
    )

    yield* withConfigTree(
      {
        global: globalMcp,
        local: {
          mcp: {
            context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
          },
        },
      },
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config.mcp?.["computer-use"]?.enabled).toBe(true)
        expect(config.mcp?.["context7"]?.enabled).toBe(true)
      }),
    )
  }),
)

// Legacy tools migration tests

it.instance("migrates legacy tools config to permissions - allow", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: { test: { tools: { bash: true, read: true } } },
    })

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]?.permission).toEqual({
      bash: "allow",
      read: "allow",
    })
  }),
)

it.instance("migrates legacy tools config to permissions - deny", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: { test: { tools: { bash: false, webfetch: false } } },
    })

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]?.permission).toEqual({
      bash: "deny",
      webfetch: "deny",
    })
  }),
)

it.instance("migrates legacy write tool to edit permission", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: { test: { tools: { write: true } } },
    })

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]?.permission).toEqual({ edit: "allow" })
  }),
)

// Managed settings tests
// Note: preload.ts sets OPENCODE_TEST_MANAGED_CONFIG which Global.Path.managedConfig uses

it.instance(
  "managed settings override user settings",
  Effect.gen(function* () {
    yield* writeManagedSettingsEffect({
      $schema: "https://opencode.ai/config.json",
      model: "managed/model",
      share: "disabled",
    })

    const config = yield* Config.use.get()
    expect(config.model).toBe("managed/model")
    expect(config.share).toBe("disabled")
    expect(config.username).toBe("testuser")
  }),
  { config: { model: "user/model", share: "auto", username: "testuser" } },
)

it.instance(
  "managed settings override project settings",
  Effect.gen(function* () {
    yield* writeManagedSettingsEffect({
      $schema: "https://opencode.ai/config.json",
      autoupdate: false,
      disabled_providers: ["openai"],
    })

    const config = yield* Config.use.get()
    expect(config.autoupdate).toBe(false)
    expect(config.disabled_providers).toEqual(["openai"])
  }),
  { config: { autoupdate: true, disabled_providers: [] } },
)

it.instance("managed jsonc settings override managed json settings", () =>
  Effect.gen(function* () {
    yield* writeManagedSettingsEffect({ model: "managed/json" })
    yield* writeManagedSettingsEffect({ model: "managed/jsonc" }, "opencode.jsonc")

    const config = yield* Config.use.get()
    expect(config.model).toBe("managed/jsonc")
  }),
)

it.instance(
  "missing managed settings file is not an error",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.model).toBe("user/model")
  }),
  { config: { model: "user/model" } },
)

it.instance("migrates legacy edit tool to edit permission", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: { test: { tools: { edit: false } } },
    })

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]?.permission).toEqual({ edit: "deny" })
  }),
)

it.instance("migrates legacy patch tool to edit permission", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: { test: { tools: { patch: true } } },
    })

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]?.permission).toEqual({ edit: "allow" })
  }),
)

it.instance("migrates mixed legacy tools config", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: { test: { tools: { bash: true, write: true, read: false, webfetch: true } } },
    })

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]?.permission).toEqual({
      bash: "allow",
      edit: "allow",
      read: "deny",
      webfetch: "allow",
    })
  }),
)

it.instance("merges legacy tools with existing permission config", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: { test: { permission: { glob: "allow" }, tools: { bash: true } } },
    })

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]?.permission).toEqual({
      glob: "allow",
      bash: "allow",
    })
  }),
)

it.instance("permission config preserves user key order", () =>
  // Permission precedence follows the order users write in config, so parsing
  // must not canonicalise known keys ahead of wildcard or custom keys.
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      permission: {
        "*": "deny",
        edit: "ask",
        write: "ask",
        external_directory: "ask",
        read: "allow",
        todowrite: "allow",
        "thoughts_*": "allow",
        "reasoning_model_*": "allow",
        "tools_*": "allow",
        "pr_comments_*": "allow",
      },
    })

    const config = yield* Config.use.get()
    expect(Object.keys(config.permission!)).toEqual([
      "*",
      "edit",
      "write",
      "external_directory",
      "read",
      "todowrite",
      "thoughts_*",
      "reasoning_model_*",
      "tools_*",
      "pr_comments_*",
    ])
  }),
)

test("config parser preserves permission order, keeps skill_capabilities, and ignores unknown keys", () => {
  const config = ConfigParse.schema(
    ConfigV1.Info,
    {
      permission: {
        bash: "allow",
        "*": "deny",
        edit: "ask",
      },
      skill_capabilities: { "spawn-new-agent": ["spawn_agent"] },
      unknown_future_key: true,
    },
    "test",
  )

  expect(Object.keys(config.permission!)).toEqual(["bash", "*", "edit"])
  expect(config.skill_capabilities).toEqual({ "spawn-new-agent": ["spawn_agent"] })
  expect("unknown_future_key" in config).toBe(false)
  expect(ConfigParse.schema(ConfigV1.Info, { invalid_field: true }, "test")).toEqual({})
})

// MCP config merging tests

it.instance("project config can override MCP server enabled status", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    // Simulates a base config (like from remote .well-known) with disabled MCP.
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        jira: {
          type: "remote",
          url: "https://jira.example.com/mcp",
          enabled: false,
        },
        wiki: {
          type: "remote",
          url: "https://wiki.example.com/mcp",
          enabled: false,
        },
      },
    })
    // Project config enables just jira.
    yield* writeConfigEffect(
      test.directory,
      {
        $schema: "https://opencode.ai/config.json",
        mcp: {
          jira: {
            type: "remote",
            url: "https://jira.example.com/mcp",
            enabled: true,
          },
        },
      },
      "opencode.jsonc",
    )

    const config = yield* Config.use.get()
    expect(config.mcp?.jira).toEqual({
      type: "remote",
      url: "https://jira.example.com/mcp",
      enabled: true,
    })
    expect(config.mcp?.wiki).toEqual({
      type: "remote",
      url: "https://wiki.example.com/mcp",
      enabled: false,
    })
  }),
)

it.instance("MCP config deep merges preserving base config properties", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        myserver: {
          type: "remote",
          url: "https://myserver.example.com/mcp",
          enabled: false,
          headers: {
            "X-Custom-Header": "value",
          },
        },
      },
    })
    yield* writeConfigEffect(
      test.directory,
      {
        $schema: "https://opencode.ai/config.json",
        mcp: {
          myserver: {
            type: "remote",
            url: "https://myserver.example.com/mcp",
            enabled: true,
          },
        },
      },
      "opencode.jsonc",
    )

    const config = yield* Config.use.get()
    expect(config.mcp?.myserver).toEqual({
      type: "remote",
      url: "https://myserver.example.com/mcp",
      enabled: true,
      headers: {
        "X-Custom-Header": "value",
      },
    })
  }),
)

it.instance("local .opencode config can override MCP from project config", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        docs: {
          type: "remote",
          url: "https://docs.example.com/mcp",
          enabled: false,
        },
      },
    })
    yield* FSUtil.use.ensureDir(path.join(test.directory, ".opencode"))
    yield* writeConfigEffect(
      path.join(test.directory, ".opencode"),
      {
        $schema: "https://opencode.ai/config.json",
        mcp: {
          docs: {
            type: "remote",
            url: "https://docs.example.com/mcp",
            enabled: true,
          },
        },
      },
      "opencode.json",
    )

    const config = yield* Config.use.get()
    expect(config.mcp?.docs?.enabled).toBe(true)
  }),
)

it.effect("project .opencode config overrides legacy home .opencode config", () =>
  Effect.gen(function* () {
    const home = yield* tmpdirScoped()
    const global = yield* tmpdirScoped()
    const project = path.join(yield* tmpdirScoped(), "project")
    yield* writeConfigEffect(
      path.join(home, ".opencode"),
      schemaConfig({
        mcp: {
          unityMCP: {
            type: "remote",
            url: "https://legacy.example.com/mcp",
            enabled: false,
          },
        },
      }),
    )
    yield* writeConfigEffect(
      path.join(project, ".opencode"),
      schemaConfig({
        mcp: {
          unityMCP: {
            type: "remote",
            url: "https://project.example.com/mcp",
            enabled: true,
          },
        },
      }),
    )

    yield* withProcessEnv(
      "OPENCODE_TEST_HOME",
      home,
      withGlobalConfigDir(
        global,
        withInstanceDir(
          project,
          Effect.gen(function* () {
            const config = yield* Config.use.get()
            expect(config.mcp?.unityMCP).toMatchObject({
              url: "https://project.example.com/mcp",
              enabled: true,
            })
          }),
        ),
      ),
    )
  }),
)

it.effect("isolates non-git fixture config discovery from ancestors outside the test root", () =>
  Effect.gen(function* () {
    const outside = yield* tmpdirScoped()
    const root = path.join(outside, "isolated")
    const directory = path.join(root, "project")
    const global = yield* tmpdirScoped()
    yield* writeConfigEffect(outside, schemaConfig({ instructions: ["outside.md"] }))
    yield* writeConfigEffect(
      path.join(outside, ".opencode"),
      schemaConfig({ mcp: { outside: { type: "local", command: ["must-not-be-started"], enabled: true } } }),
    )
    yield* writeConfigEffect(root, schemaConfig({ instructions: ["inside.md"] }))
    yield* writeConfigEffect(
      path.join(root, ".opencode"),
      schemaConfig({
        model: "test/parent",
        mcp: { inside: { type: "local", command: ["fixture-only"], enabled: false } },
      }),
    )
    yield* writeConfigEffect(path.join(directory, ".opencode"), schemaConfig({ model: "test/project" }))

    yield* withProcessEnv(
      "OPENCODE_TEST_CONFIG_ROOT",
      root,
      withGlobalConfigDir(
        global,
        withInstanceDir(
          directory,
          Effect.gen(function* () {
            const instance = yield* InstanceRef
            expect(instance?.project.vcs).toBeUndefined()
            const config = yield* Config.use.get()
            expect(config.instructions).toEqual(["inside.md"])
            expect(config.model).toBe("test/project")
            expect(config.mcp).toEqual({ inside: { type: "local", command: ["fixture-only"], enabled: false } })
          }),
        ),
      ),
    )
  }),
)

it.effect("preserves normal and tighter worktree discovery around the test config root", () =>
  Effect.gen(function* () {
    const outside = yield* tmpdirScoped()
    const root = path.join(outside, "fixture-sibling")
    const worktree = path.join(root, "repo")
    const directory = path.join(worktree, "project")
    yield* Effect.forEach([root, worktree, directory], (dir) =>
      Effect.all([
        writeConfigEffect(dir, schemaConfig({})),
        writeConfigEffect(path.join(dir, ".opencode"), schemaConfig({})),
      ]),
    )
    yield* Effect.forEach([undefined, path.join(outside, "unrelated"), path.join(outside, "fixture")], (testRoot) =>
      withProcessEnv(
        "OPENCODE_TEST_CONFIG_ROOT",
        testRoot,
        Effect.gen(function* () {
          expect(yield* ConfigPaths.files("opencode", directory)).toContain(path.join(root, "opencode.json"))
          expect(yield* ConfigPaths.directories(directory)).toContain(path.join(root, ".opencode"))
        }),
      ),
    )
    expect(Bun.spawnSync(["git", "init"], { cwd: worktree, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0)
    yield* withProcessEnv(
      "OPENCODE_TEST_CONFIG_ROOT",
      root,
      withInstanceDir(
        directory,
        Effect.gen(function* () {
          const instance = yield* InstanceRef
          expect(instance?.project.vcs).toBe("git")
          expect(instance?.worktree).toBe(worktree)
          expect(yield* ConfigPaths.files("opencode", directory, instance?.worktree)).toEqual([
            path.join(worktree, "opencode.json"),
            path.join(directory, "opencode.json"),
          ])
          const directories = yield* ConfigPaths.directories(directory, instance?.worktree)
          expect(directories).not.toContain(path.join(root, ".opencode"))
          expect(directories).toContain(path.join(worktree, ".opencode"))
          expect(directories).toContain(path.join(directory, ".opencode"))
        }),
      ),
    )
  }),
)

it.effect("nested project .opencode config overrides parent .opencode config", () =>
  Effect.gen(function* () {
    const global = yield* tmpdirScoped()
    const root = yield* tmpdirScoped()
    const child = path.join(root, "packages", "app")
    yield* writeConfigEffect(
      path.join(root, ".opencode"),
      schemaConfig({
        mcp: {
          docs: {
            type: "remote",
            url: "https://parent.example.com/mcp",
            enabled: false,
          },
        },
      }),
    )
    yield* writeConfigEffect(
      path.join(child, ".opencode"),
      schemaConfig({
        mcp: {
          docs: {
            type: "remote",
            url: "https://child.example.com/mcp",
            enabled: true,
          },
        },
      }),
    )

    yield* withGlobalConfigDir(
      global,
      withInstanceDir(
        child,
        Effect.gen(function* () {
          const config = yield* Config.use.get()
          expect(config.mcp?.docs).toMatchObject({
            url: "https://child.example.com/mcp",
            enabled: true,
          })
        }),
      ),
    )
  }),
)

const remoteProjectOverride = wellKnown({
  config: {
    mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: false } },
  },
})

remoteProjectOverride.it.instance(
  "project config overrides remote well-known config",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      expect(remoteProjectOverride.seen.wellKnown).toBe("https://example.com/.well-known/opencode")
      expect(config.mcp?.jira?.enabled).toBe(true)
    }),
  {
    git: true,
    config: { mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: true } } },
  },
)

const trailingSlashWellKnown = wellKnown({
  authUrl: "https://example.com/",
  config: {
    mcp: { slack: { type: "remote", url: "https://slack.example.com/mcp", enabled: true } },
  },
})

trailingSlashWellKnown.it.instance("wellknown URL with trailing slash is normalized", () =>
  Effect.gen(function* () {
    yield* Config.use.get()
    expect(trailingSlashWellKnown.seen.wellKnown).toBe("https://example.com/.well-known/opencode")
  }),
)

test("remote well-known config can use FetchHttpClient layer", async () => {
  let fetchedUrl: string | undefined
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      fetchedUrl = request.url
      return new Response(
        JSON.stringify({
          config: {
            mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: true } },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    },
  })

  try {
    await provideTmpdirInstance(
      () =>
        Config.Service.use((svc) =>
          Effect.gen(function* () {
            const config = yield* svc.get()
            expect(fetchedUrl).toBe(`${server.url.origin}/.well-known/opencode`)
            expect(config.mcp?.jira?.enabled).toBe(true)
          }),
        ),
      { git: true },
    ).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          Config.layer.pipe(
            Layer.provide(testFlock),
            Layer.provide(FSUtil.defaultLayer),
            Layer.provide(Env.defaultLayer),
            Layer.provide(wellKnownAuth(server.url.origin)),
            Layer.provide(AccountTest.empty),
            Layer.provideMerge(infra),
            Layer.provide(NpmTest.noop),
            Layer.provide(FetchHttpClient.layer),
          ),
          testInstanceStoreLayer,
        ),
      ),
      Effect.runPromise,
    )
  } finally {
    await server.stop(true)
  }
})

const templatedHeaderWellKnown = wellKnown({
  remoteConfig: {
    url: "https://config.example.com/opencode.json",
    headers: { Authorization: "Bearer {env:TEST_TOKEN}" },
  },
  remote: {
    mcp: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", enabled: true } },
  },
})

templatedHeaderWellKnown.it.instance("wellknown remote_config supports templated env vars in headers", () =>
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(templatedHeaderWellKnown.seen.wellKnown).toBe("https://example.com/.well-known/opencode")
    expect(templatedHeaderWellKnown.seen.remote).toBe("https://config.example.com/opencode.json")
    expect(templatedHeaderWellKnown.seen.authorization).toBe("Bearer test-token")
    expect(config.mcp?.confluence?.enabled).toBe(true)
  }),
)

const remotePrecedenceWellKnown = wellKnown({
  config: {
    mcp: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", enabled: false } },
  },
  remoteConfig: { url: "https://config.example.com/{env:TEST_TOKEN}/opencode.json" },
  remote: {
    config: { mcp: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", enabled: true } } },
  },
})

remotePrecedenceWellKnown.it.instance(
  "wellknown remote_config url tokens and nested config override embedded config",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      expect(remotePrecedenceWellKnown.seen.remote).toBe("https://config.example.com/test-token/opencode.json")
      expect(config.mcp?.confluence?.enabled).toBe(true)
    }),
)

const envIsolationWellKnown = wellKnown({
  remoteConfig: {
    url: "https://config.example.com/opencode.json",
    headers: { Authorization: "Bearer {env:TEST_TOKEN}" },
  },
  remote: {
    mcp: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", enabled: true } },
  },
})

envIsolationWellKnown.it.instance(
  "wellknown token env substitution does not mutate process env",
  () =>
    Effect.gen(function* () {
      process.env.TEST_TOKEN = "preexisting-token"
      const config = yield* Config.use.get()
      expect(envIsolationWellKnown.seen.authorization).toBe("Bearer test-token")
      expect(config.username).toBe("test-token")
      expect(process.env.TEST_TOKEN).toBe("preexisting-token")
    }),
  { git: true, config: { username: "{env:TEST_TOKEN}" } },
)

const nullConfigWellKnown = wellKnown({
  wellKnown: {
    config: null,
    remote_config: { url: "https://config.example.com/opencode.json" },
  },
  remote: {
    mcp: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", enabled: true } },
  },
})

nullConfigWellKnown.it.instance("wellknown config null is treated as absent", () =>
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(nullConfigWellKnown.seen.remote).toBe("https://config.example.com/opencode.json")
    expect(config.mcp?.confluence?.enabled).toBe(true)
  }),
)

const invalidRemoteWellKnown = wellKnown({
  remoteConfig: { url: "https://config.example.com/opencode.json" },
  remote: "not an object",
})

invalidRemoteWellKnown.it.instance("wellknown remote_config rejects non-object config responses", () =>
  Effect.gen(function* () {
    const exit = yield* Config.use.get().pipe(Effect.exit)
    expect(invalidRemoteWellKnown.seen.remote).toBe("https://config.example.com/opencode.json")
    expect(Exit.isFailure(exit)).toBe(true)
  }),
)

const loginPageWellKnown = wellKnown({
  remoteConfig: { url: "https://config.example.com/opencode.json" },
  remoteHtml: "<!DOCTYPE html><html><head><title>Sign in</title></head><body>Login required</body></html>",
})

loginPageWellKnown.it.instance(
  "wellknown remote_config surfaces an actionable auth error when the gateway returns an HTML login page",
  () =>
    Effect.gen(function* () {
      const exit = yield* Config.use.get().pipe(Effect.exit)
      expect(loginPageWellKnown.seen.remote).toBe("https://config.example.com/opencode.json")
      expect(Exit.isFailure(exit)).toBe(true)
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect(NamedError.hasName(error, "ConfigRemoteAuthError")).toBe(true)
      expect((error as { data?: { url?: string } }).data?.url).toBe("https://example.com")
    }),
)

describe("resolvePluginSpec", () => {
  test("keeps package specs unchanged", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "opencode.json")
    expect(await ConfigPlugin.resolvePluginSpec("oh-my-opencode@2.4.3", file)).toBe("oh-my-opencode@2.4.3")
    expect(await ConfigPlugin.resolvePluginSpec("@scope/pkg", file)).toBe("@scope/pkg")
  })

  test("resolves windows-style relative plugin directory specs", async () => {
    if (process.platform !== "win32") return

    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugin = path.join(dir, "plugin")
        await fs.mkdir(plugin, { recursive: true })
        await Filesystem.write(path.join(plugin, "index.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "opencode.json")
    const hit = await ConfigPlugin.resolvePluginSpec(".\\plugin", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin", "index.ts")).href)
  })

  test("resolves relative file plugin paths to file urls", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "plugin.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "opencode.json")
    const hit = await ConfigPlugin.resolvePluginSpec("./plugin.ts", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin.ts")).href)
  })

  test("resolves plugin directory paths to directory urls", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugin = path.join(dir, "plugin")
        await fs.mkdir(plugin, { recursive: true })
        await Filesystem.writeJson(path.join(plugin, "package.json"), {
          name: "demo-plugin",
          type: "module",
          main: "./index.ts",
        })
        await Filesystem.write(path.join(plugin, "index.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "opencode.json")
    const hit = await ConfigPlugin.resolvePluginSpec("./plugin", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin")).href)
  })

  test("resolves plugin directories without package.json to index.ts", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugin = path.join(dir, "plugin")
        await fs.mkdir(plugin, { recursive: true })
        await Filesystem.write(path.join(plugin, "index.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "opencode.json")
    const hit = await ConfigPlugin.resolvePluginSpec("./plugin", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin", "index.ts")).href)
  })
})

describe("deduplicatePluginOrigins", () => {
  const dedupe = (plugins: ConfigPluginV1.Spec[]) =>
    ConfigPlugin.deduplicatePluginOrigins(
      plugins.map((spec) => ({
        spec,
        source: "",
        scope: "global" as const,
      })),
    ).map((item) => item.spec)

  test("removes duplicates keeping higher priority (later entries)", () => {
    const plugins = ["global-plugin@1.0.0", "shared-plugin@1.0.0", "local-plugin@2.0.0", "shared-plugin@2.0.0"]

    const result = dedupe(plugins)

    expect(result).toContain("global-plugin@1.0.0")
    expect(result).toContain("local-plugin@2.0.0")
    expect(result).toContain("shared-plugin@2.0.0")
    expect(result).not.toContain("shared-plugin@1.0.0")
    expect(result.length).toBe(3)
  })

  test("keeps path plugins separate from package plugins", () => {
    const plugins = ["oh-my-opencode@2.4.3", "file:///project/.opencode/plugin/oh-my-opencode.js"]

    const result = dedupe(plugins)

    expect(result).toEqual(plugins)
  })

  test("deduplicates direct path plugins by exact spec", () => {
    const plugins = ["file:///project/.opencode/plugin/demo.ts", "file:///project/.opencode/plugin/demo.ts"]

    const result = dedupe(plugins)

    expect(result).toEqual(["file:///project/.opencode/plugin/demo.ts"])
  })

  test("preserves order of remaining plugins", () => {
    const plugins = ["a-plugin@1.0.0", "b-plugin@1.0.0", "c-plugin@1.0.0"]

    const result = dedupe(plugins)

    expect(result).toEqual(["a-plugin@1.0.0", "b-plugin@1.0.0", "c-plugin@1.0.0"])
  })

  it.effect("loads auto-discovered local plugins as file urls", () =>
    withConfigTree(
      { global: { plugin: ["my-plugin@1.0.0"] } },
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* FSUtil.use.writeWithDirs(
          path.join(test.directory, ".opencode", "plugin", "my-plugin.js"),
          "export default {}",
        )

        const plugins = (yield* Config.use.get()).plugin ?? []
        expect(plugins.some((p) => ConfigPlugin.pluginSpecifier(p) === "my-plugin@1.0.0")).toBe(true)
        expect(plugins.some((p) => ConfigPlugin.pluginSpecifier(p).startsWith("file://"))).toBe(true)
      }),
    ),
  )
})

describe("OPENCODE_DISABLE_PROJECT_CONFIG", () => {
  it.instance(
    "skips project config files when flag is set",
    () =>
      withProcessEnv(
        "OPENCODE_DISABLE_PROJECT_CONFIG",
        "true",
        Effect.gen(function* () {
          const config = yield* Config.use.get()
          expect(config.model).not.toBe("project/model")
          expect(config.username).not.toBe("project-user")
        }),
      ),
    { config: { model: "project/model", username: "project-user" } },
  )

  it.instance("skips project .opencode/ directories when flag is set", () =>
    withProcessEnv(
      "OPENCODE_DISABLE_PROJECT_CONFIG",
      "true",
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* FSUtil.use.writeWithDirs(
          path.join(test.directory, ".opencode", "command", "test-cmd.md"),
          "# Test Command\nThis is a test command.",
        )
        const directories = yield* Config.use.directories()
        expect(directories.some((d) => d.startsWith(test.directory))).toBe(false)
      }),
    ),
  )

  it.instance("still loads global config when flag is set", () =>
    withProcessEnv(
      "OPENCODE_DISABLE_PROJECT_CONFIG",
      "true",
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config).toBeDefined()
        expect(config.username).toBeDefined()
      }),
    ),
  )

  it.instance(
    "skips relative instructions with warning when flag is set but no config dir",
    () =>
      withProcessEnvs(
        { OPENCODE_CONFIG_DIR: undefined, OPENCODE_DISABLE_PROJECT_CONFIG: "true" },
        Effect.gen(function* () {
          const test = yield* TestInstance
          yield* FSUtil.use.writeWithDirs(path.join(test.directory, "CUSTOM.md"), "# Custom Instructions")
          // The relative instruction should be skipped without error
          const config = yield* Config.use.get()
          expect(config).toBeDefined()
        }),
      ),
    { config: { instructions: ["./CUSTOM.md"] } },
  )

  it.instance(
    "OPENCODE_CONFIG_DIR still works when flag is set",
    () =>
      Effect.gen(function* () {
        const configDir = yield* tmpdirScoped({ config: { model: "configdir/model" } })
        yield* withProcessEnvs(
          { OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_CONFIG_DIR: configDir },
          Effect.gen(function* () {
            const config = yield* Config.use.get()
            expect(config.model).toBe("configdir/model")
          }),
        )
      }),
    { config: { model: "project/model" } },
  )
})

// Regression for #28206: malformed OPENCODE_PERMISSION JSON used to crash
// the app on startup with an unhandled SyntaxError. Loading the config with
// an invalid JSON value in this env var should not throw.
describe("OPENCODE_PERMISSION env var", () => {
  it.instance("does not crash when OPENCODE_PERMISSION contains invalid JSON", () =>
    withProcessEnv(
      "OPENCODE_PERMISSION",
      "{invalid",
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        // Regression: load() used to throw before returning anything.
        expect(config).toBeDefined()
      }),
    ),
  )
})

describe("OPENCODE_CONFIG_CONTENT token substitution", () => {
  it.instance("substitutes {env:} tokens in OPENCODE_CONFIG_CONTENT", () =>
    withProcessEnv(
      "TEST_CONFIG_VAR",
      "test_api_key_12345",
      withProcessEnv(
        "OPENCODE_CONFIG_CONTENT",
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          username: "{env:TEST_CONFIG_VAR}",
        }),
        Effect.gen(function* () {
          const config = yield* Config.use.get()
          expect(config.username).toBe("test_api_key_12345")
        }),
      ),
    ),
  )

  it.instance("substitutes {file:} tokens in OPENCODE_CONFIG_CONTENT", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* FSUtil.use.writeWithDirs(path.join(test.directory, "api_key.txt"), "secret_key_from_file")
      yield* withProcessEnv(
        "OPENCODE_CONFIG_CONTENT",
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          username: "{file:./api_key.txt}",
        }),
        Effect.gen(function* () {
          const config = yield* Config.use.get()
          expect(config.username).toBe("secret_key_from_file")
        }),
      )
    }),
  )
})

// parseManagedPlist unit tests — pure function, no OS interaction

test("parseManagedPlist strips MDM metadata keys", async () => {
  const config = ConfigParse.schema(
    ConfigV1.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          PayloadDisplayName: "OpenCode Managed",
          PayloadIdentifier: "ai.opencode.managed.test",
          PayloadType: "ai.opencode.managed",
          PayloadUUID: "AAAA-BBBB-CCCC",
          PayloadVersion: 1,
          _manualProfile: true,
          share: "disabled",
          model: "mdm/model",
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.share).toBe("disabled")
  expect(config.model).toBe("mdm/model")
  // MDM keys must not leak into the parsed config
  expect((config as any).PayloadUUID).toBeUndefined()
  expect((config as any).PayloadType).toBeUndefined()
  expect((config as any)._manualProfile).toBeUndefined()
})

test("parseManagedPlist parses server settings", async () => {
  const config = ConfigParse.schema(
    ConfigV1.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          server: { hostname: "127.0.0.1", mdns: false },
          autoupdate: true,
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.server?.hostname).toBe("127.0.0.1")
  expect(config.server?.mdns).toBe(false)
  expect(config.autoupdate).toBe(true)
})

test("parseManagedPlist parses permission rules", async () => {
  const config = ConfigParse.schema(
    ConfigV1.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          permission: {
            "*": "ask",
            bash: { "*": "ask", "rm -rf *": "deny", "curl *": "deny" },
            grep: "allow",
            glob: "allow",
            webfetch: "ask",
            "~/.ssh/*": "deny",
          },
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.permission?.["*"]).toBe("ask")
  expect(config.permission?.grep).toBe("allow")
  expect(config.permission?.webfetch).toBe("ask")
  expect(config.permission?.["~/.ssh/*"]).toBe("deny")
  const bash = config.permission?.bash as Record<string, string>
  expect(bash?.["rm -rf *"]).toBe("deny")
  expect(bash?.["curl *"]).toBe("deny")
})

test("parseManagedPlist parses enabled_providers", async () => {
  const config = ConfigParse.schema(
    ConfigV1.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["anthropic", "google"],
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.enabled_providers).toEqual(["anthropic", "google"])
})

test("parseManagedPlist handles empty config", async () => {
  const config = ConfigParse.schema(
    ConfigV1.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(JSON.stringify({ $schema: "https://opencode.ai/config.json" })),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.$schema).toBe("https://opencode.ai/config.json")
})
