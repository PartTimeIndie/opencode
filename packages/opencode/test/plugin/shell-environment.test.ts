import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { ShellEnvironment } from "@opencode-ai/core/shell-environment"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { sessionRuntimeLayer } from "@opencode-ai/server/handlers"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { AgentV2 } from "@opencode-ai/core/agent"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Config } from "../../src/config/config"
import { Env } from "../../src/env"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { InstanceRef } from "../../src/effect/instance-ref"
import { Plugin } from "../../src/plugin/index"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"

const config = Config.layer.pipe(
  Layer.provide(EffectFlock.defaultLayer), Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Env.defaultLayer), Layer.provide(AuthTest.empty),
  Layer.provide(AccountTest.empty), Layer.provide(NpmTest.noop), Layer.provide(FetchHttpClient.layer),
)
const it = testEffect(Layer.mergeAll(
  Plugin.layer.pipe(Layer.provide(EventV2Bridge.defaultLayer), Layer.provide(config), Layer.provide(RuntimeFlags.layer({ disableDefaultPlugins: true }))),
  LocationServiceMap.layer,
  sessionRuntimeLayer,
  CrossSpawnSpawner.defaultLayer,
))

function withPlugin<A, E, R>(source: string, effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const test = yield* TestInstance
    const file = path.join(test.directory, "shell-plugin.ts")
    yield* Effect.promise(() => Bun.write(file, source))
    yield* Effect.promise(() => Bun.write(path.join(test.directory, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json", plugin: [pathToFileURL(file).href], permission: { "*": "allow" },
    })))
    yield* (yield* Plugin.Service).init().pipe(Effect.timeout("15 seconds"))
    return yield* effect
  })
}

describe("native shell environment server-plugin bridge", () => {
  it.instance("reaches a real registered native shell after location-cache eviction", () =>
    withPlugin(`export default async () => {
      return { "shell.env": (native, output) => { output.env.BINDING = native.sessionID + ":" + native.callID; } };
    }`, Effect.gen(function* () {
      const test = yield* TestInstance
      const locations = yield* LocationServiceMap
      const ref = Location.Ref.make({ directory: AbsolutePath.make(test.directory) })
      const { id: sessionID } = yield* (yield* SessionV2.Service).create({ location: ref,
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* locations.invalidate(ref).pipe(Effect.timeout("5 seconds"))
      const settled = yield* Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const agent = AgentV2.ID.make("build")
        const tools = yield* registry.materialize(undefined, undefined, { sessionID, agent }).pipe(Effect.timeout("5 seconds"))
        return yield* tools.settle({ sessionID, agent, assistantMessageID: SessionMessage.ID.make("msg_shell_environment"),
          call: { type: "tool-call", id: "native-env", name: "bash", input: {
            command: process.platform === "win32" ? "Write-Output $env:BINDING" : 'printf "%s" "$BINDING"',
          } },
        }).pipe(Effect.timeout("5 seconds"))
      }).pipe(Effect.provide(locations.get(ref)), Effect.timeout("10 seconds"))
      expect(settled.output?.structured).toMatchObject({ exitCode: 0, output: expect.stringContaining(`${sessionID}:native-env`) })
    })),
  )

  it.instance("keeps the first shell binding when a lightweight instance re-registers the same directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "shell-plugin.ts")
      const plugin = `export default async () => {
        const binding = await Bun.file(new URL("./binding.txt", import.meta.url)).text();
        return { "shell.env": (_input, output) => { output.env.BINDING = binding; } };
      }`
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "binding.txt"), "first"))
      yield* Effect.promise(() => Bun.write(file, plugin))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "opencode.json"), JSON.stringify({
        $schema: "https://opencode.ai/config.json", plugin: [pathToFileURL(file).href], permission: { "*": "allow" },
      })))
      yield* (yield* Plugin.Service).init().pipe(Effect.timeout("15 seconds"))
      // A trailing separator keeps the registry identity (host-resolved,
      // case-folded) while missing the InstanceState cache key, matching the
      // lightweight instance contexts the desktop host routes build.
      const directory = AbsolutePath.make(test.directory + path.sep)
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "binding.txt"), "second"))
      yield* (yield* Plugin.Service).init().pipe(
        Effect.provideService(InstanceRef, {
          directory, worktree: directory,
          project: { id: ProjectV2.ID.make("global"), worktree: directory, time: { created: 0, updated: 0 }, sandboxes: [] },
        }),
        Effect.timeout("15 seconds"),
      )
      const environment = yield* ShellEnvironment.Service
      expect(yield* environment.get({ directory: test.directory, cwd: test.directory, sessionID: SessionSchema.ID.make("ses_reinit"), callID: "reinit" })).toEqual({ BINDING: "first" })
    }),
  )

  it.instance("loads the configured SDK hook and isolates concurrent native sessions and foreign locations", () =>
    withPlugin(`export default async () => ({
      "shell.env": async (input, output) => {
        await Promise.resolve();
        output.env.BINDING = input.sessionID + ":" + input.callID;
        output.env.CWD = input.cwd;
      }
    })`, Effect.gen(function* () {
      const test = yield* TestInstance
      const environment = yield* ShellEnvironment.Service
      const before = process.env.BINDING
      const requests = ["ses_native_parent", "ses_native_child"].map((id) => ({
        directory: test.directory, cwd: path.join(test.directory, "sub"), sessionID: SessionSchema.ID.make(id), callID: id,
      }))
      const outputs = yield* Effect.all(requests.map((request) => environment.get(request)), { concurrency: 2 })
      expect(outputs).toEqual(requests.map((request) => ({ BINDING: `${request.sessionID}:${request.callID}`, CWD: request.cwd })))
      outputs[0]!.BINDING = "mutated"
      expect((yield* environment.get(requests[1]!)).BINDING).toBe("ses_native_child:ses_native_child")
      expect(yield* environment.get({ ...requests[0]!, directory: path.join(test.directory, "foreign") })).toEqual({})
      expect(process.env.BINDING).toBe(before)
    })),
  )

  it.instance("propagates a loaded hook failure instead of starting with a partial environment", () =>
    withPlugin(`export default async () => ({
      "shell.env": (_input, output) => { output.env.PARTIAL = "must not escape"; throw new Error("private fixture detail"); }
    })`, Effect.gen(function* () {
      const test = yield* TestInstance
      const exit = yield* (yield* ShellEnvironment.Service).get({ directory: test.directory, cwd: test.directory,
        sessionID: SessionSchema.ID.make("ses_failure"), callID: "failure" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).not.toContain("private fixture detail")
    })),
  )

  for (const invalid of ["null", "[]", '{ PRIVATE: 123 }', '{ PRIVATE: "secret\\0value" }', '{ "BAD=KEY": "value" }']) {
    it.instance(`rejects invalid environment ${invalid} without leaking its contents`, () =>
      withPlugin(`export default async () => ({ "shell.env": (_input, output) => { output.env = ${invalid}; } })`, Effect.gen(function* () {
        const test = yield* TestInstance
        const exit = yield* (yield* ShellEnvironment.Service).get({ directory: test.directory, cwd: test.directory,
          sessionID: SessionSchema.ID.make("ses_invalid"), callID: "invalid" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ message: "Plugin shell.env hook failed; shell was not started" })
      })),
    )
  }
})
