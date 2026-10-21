import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { ConfigDAP } from "@opencode-ai/core/config/dap"
import { DebugAdapter } from "@opencode-ai/core/debug-adapter"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("DebugAdapter", () => {
  it.live("frames requests, correlates responses, collects events, and never terminates an attached debuggee", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        const log = path.join(tmp.path, "disconnect.json")
        const config = Layer.succeed(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  info: new Config.Info({
                    dap: new ConfigDAP.Info({
                      adapters: {
                        fixture: new ConfigDAP.Adapter({
                          command: [process.execPath, path.join(import.meta.dir, "fixture", "dap-adapter.ts"), log],
                        }),
                      },
                    }),
                  }),
                }),
              ]),
          }),
        )
        const layer = DebugAdapter.layer.pipe(Layer.provide(config))
        return Effect.gen(function* () {
          const dap = yield* DebugAdapter.Service
          const active = yield* dap.start({ adapter: "fixture", mode: "attach", arguments: { processId: 42 } })
          expect(active.capabilities).toEqual({ command: "initialize" })
          expect(yield* dap.request({ session: active.session, command: "configurationDone" })).toEqual({
            command: "configurationDone",
          })
          yield* Effect.sleep("20 millis")
          expect(yield* dap.events(active.session)).toEqual([
            expect.objectContaining({ type: "event", event: "stopped" }),
          ])
          expect(yield* dap.events(active.session)).toEqual([])
          yield* dap.disconnect(active.session)
          expect(yield* Effect.promise(() => Bun.file(log).text())).toContain('"terminateDebuggee":false')
          expect(
            yield* dap.start({ adapter: "fixture", mode: "launch", arguments: { fail: true } }).pipe(Effect.flip),
          ).toMatchObject({ message: "start failed" })
          yield* Effect.sleep("20 millis")
          expect(yield* Effect.promise(() => Bun.file(log).text())).toContain('"terminateDebuggee":true')
        }).pipe(Effect.provide(layer))
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
