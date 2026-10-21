import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import path from "path"
import { pathToFileURL } from "url"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Config } from "../../src/config/config"
import { Env } from "../../src/env"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"

import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const configLayer = Config.layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(AuthTest.empty),
  Layer.provide(AccountTest.empty),
  Layer.provide(NpmTest.noop),
  Layer.provide(FetchHttpClient.layer),
)
const it = testEffect(
  Layer.mergeAll(
    Plugin.layer.pipe(
      Layer.provide(EventV2Bridge.defaultLayer),
      Layer.provide(configLayer),
      Layer.provide(RuntimeFlags.layer({ disableDefaultPlugins: true })),
    ),
    CrossSpawnSpawner.defaultLayer,
  ),
)
const systemHook = "experimental.chat.system.transform"

function withProject<A, E, R>(source: string, self: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const test = yield* TestInstance
    const file = path.join(test.directory, "plugin.ts")
    yield* Effect.all(
      [
        Effect.promise(() => Bun.write(file, source)),
        Effect.promise(() =>
          Bun.write(
            path.join(test.directory, "opencode.json"),
            JSON.stringify(
              {
                $schema: "https://opencode.ai/config.json",
                plugin: [pathToFileURL(file).href],
              },
              null,
              2,
            ),
          ),
        ),
      ],
      { discard: true, concurrency: 2 },
    )
    return yield* self
  })
}

const triggerSystemTransform = Effect.fn("PluginTriggerTest.triggerSystemTransform")(function* () {
  const plugin = yield* Plugin.Service
  const out = { system: [] as string[] }
  yield* plugin.trigger(
    systemHook,
    {
      model: {
        providerID: ProviderV2.ID.anthropic,
        modelID: ModelV2.ID.make("claude-sonnet-4-6"),
      },
    },
    out,
  )
  return out.system
})

describe("plugin.trigger", () => {
  it.instance("passes legacy and V2 SDK clients to server plugins", () =>
    withProject(
      [
        "export default async (input) => {",
        "  const created = await input.clientV2.v2.session.create({ location: { directory: input.directory } })",
        "  const session = created.data?.data ?? created.data",
        "  const admission = session ? await input.clientV2.v2.session.prompt({",
        "    sessionID: session.id,",
        '    prompt: { text: "plugin V2 contract" },',
        "    resume: false,",
        "  }) : {}",
        "  const admittedInput = admission.data?.data ?? admission.data",
        '  await Bun.write(input.directory + "/plugin-clients.json", JSON.stringify({',
        '    legacyMessages: typeof input.client?.session?.messages === "function",',
        '    v2Prompt: typeof input.clientV2?.v2?.session?.prompt === "function",',
        '    created: typeof session?.id === "string",',
        '    admitted: typeof admittedInput?.admittedSeq === "number",',
        "  }))",
        "  return {}",
        "}",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        const test = yield* TestInstance
        const plugin = yield* Plugin.Service
        yield* plugin.list()
        expect(
          yield* Effect.promise(
            () => Bun.file(path.join(test.directory, "plugin-clients.json")).json() as Promise<Record<string, boolean>>,
          ),
        ).toEqual({ legacyMessages: true, v2Prompt: true, created: true, admitted: true })
      }),
    ),
  )

  it.instance("runs synchronous hooks without crashing", () =>
    withProject(
      [
        "export default async () => ({",
        `  ${JSON.stringify(systemHook)}: (_input, output) => {`,
        '    output.system.unshift("sync")',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toEqual(["sync"])
      }),
    ),
  )

  it.instance("awaits asynchronous hooks", () =>
    withProject(
      [
        "export default async () => ({",
        `  ${JSON.stringify(systemHook)}: async (_input, output) => {`,
        "    await Bun.sleep(1)",
        '    output.system.unshift("async")',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toEqual(["async"])
      }),
    ),
  )
})
