import { expect } from "bun:test"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Npm } from "@opencode-ai/core/npm"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import path from "path"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { provideInstanceEffect, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const installs: string[] = []
const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)
const layer = Layer.mergeAll(
  Config.layer.pipe(
    Layer.provide(EffectFlock.defaultLayer),
    Layer.provide(Env.defaultLayer),
    Layer.provide(AuthTest.empty),
    Layer.provide(AccountTest.empty),
    Layer.provideMerge(infra),
    Layer.provide(
      Layer.mock(Npm.Service)({
        install: (directory) =>
          Effect.sync(() => {
            installs.push(directory)
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => Effect.die(`unexpected http request: ${request.method} ${request.url}`)),
      ),
    ),
    Layer.provideMerge(FSUtil.defaultLayer),
  ),
  testInstanceStoreLayer,
)

const it = testEffect(layer)

const withEnv = <A, E, R>(values: Record<string, string | undefined>, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }),
  )

it.effect("does not start dependency install fibers in pure mode", () =>
  Effect.gen(function* () {
    installs.length = 0

    const pureDir = yield* tmpdirScoped()
    const pureConfigDir = path.join(pureDir, ".opencode")
    yield* FSUtil.use.writeWithDirs(
      path.join(pureConfigDir, "opencode.json"),
      JSON.stringify({ plugin: ["test-plugin@1.0.0"] }),
    )
    yield* withEnv(
      {
        OPENCODE_PURE: "1",
      },
      Config.Service.use((svc) => svc.get().pipe(Effect.andThen(svc.waitForDependencies()))).pipe(
        provideInstanceEffect(pureDir),
      ),
    )
    expect(installs).toEqual([])

    const normalDir = yield* tmpdirScoped()
    const normalConfigDir = path.join(normalDir, ".opencode")
    yield* FSUtil.use.writeWithDirs(
      path.join(normalConfigDir, "opencode.json"),
      JSON.stringify({ plugin: ["test-plugin@1.0.0"] }),
    )
    yield* withEnv(
      {
        OPENCODE_PURE: undefined,
      },
      Config.Service.use((svc) => svc.get().pipe(Effect.andThen(svc.waitForDependencies()))).pipe(
        provideInstanceEffect(normalDir),
      ),
    )
    expect(installs).toContain(normalConfigDir)
  }),
)
