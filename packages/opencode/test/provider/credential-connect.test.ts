import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/core/integration"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"

const stored = (integrationID: string, value: Credential.Info) =>
  new Credential.Stored({
    id: Credential.ID.create(),
    integrationID: Integration.ID.make(integrationID),
    label: "test",
    value,
  })

const it = testEffect(
  Provider.layer.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Env.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(ModelsDev.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
    Layer.provide(
      Layer.mock(Credential.Service)({
        all: () =>
          Effect.succeed([
            stored("opencode-go", new Credential.Key({ type: "key", key: "go-key-test" })),
            stored(
              "kimi-for-coding",
              new Credential.OAuth({
                type: "oauth",
                methodID: Integration.MethodID.make("oauth"),
                refresh: "refresh-test",
                access: "access-test",
                expires: 0,
              }),
            ),
          ]),
      }),
    ),
  ),
)

describe("provider credential store", () => {
  it.instance(
    "connects providers with a stored key credential",
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const list = yield* provider.list()
      const go = list[ProviderV2.ID.make("opencode-go")]
      expect(go).toBeDefined()
      expect(go.source).toBe("api")
      expect(go.key).toBe("go-key-test")
    }),
  )

  it.instance(
    "ignores stored oauth credentials when loading providers",
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const list = yield* provider.list()
      expect(list[ProviderV2.ID.make("kimi-for-coding")]).toBeUndefined()
    }),
  )
})
