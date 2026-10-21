import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ControlConfig } from "@opencode-ai/core/control-config"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const provide = (directory: string) =>
  Effect.provide(
    ControlConfig.locationLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          FSUtil.defaultLayer,
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
        ),
      ),
    ),
  )

const withTmp = <A, E, R>(body: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => body(tmp.path),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("ControlConfig", () => {
  it.live("writes JSONC config values relative to the active location", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          fs.writeFile(path.join(directory, "config.jsonc"), '{\n  // keep this\n  "gameplay": { "speed": 1 }\n}\n'),
        )

        const output = yield* (yield* ControlConfig.Service).apply({
          target: { path: "config.jsonc", format: "jsonc", pointer: "/gameplay/speed" },
          value: 2,
        })

        expect(output).toEqual({ path: RelativePath.make("config.jsonc"), format: "jsonc", pointer: "/gameplay/speed" })
        expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "config.jsonc"), "utf8"))).toContain(
          '"speed": 2',
        )
      }).pipe(provide(directory)),
    ),
  )

  it.live("rejects unsupported writable config formats", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const error = yield* (yield* ControlConfig.Service)
          .apply({ target: { path: "config.yaml", format: "yaml", pointer: "/speed" }, value: 2 })
          .pipe(Effect.flip)

        expect(error).toBeInstanceOf(ControlConfig.UnsupportedFormatError)
      }).pipe(provide(directory)),
    ),
  )

  it.live("rejects config paths outside the active location", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const error = yield* (yield* ControlConfig.Service)
          .apply({ target: { path: "../outside.json", format: "json", pointer: "/speed" }, value: 2 })
          .pipe(Effect.flip)

        expect(error).toBeInstanceOf(ControlConfig.InvalidPathError)
        if (error instanceof ControlConfig.InvalidPathError) expect(error.reason).toBe("escape")
      }).pipe(provide(directory)),
    ),
  )
})
