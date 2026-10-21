export * as ControlConfig from "./control-config"

import path from "path"
import { applyEdits, modify, parse } from "jsonc-parser"
import { Context, Effect, Layer, Schema } from "effect"
import { Control } from "./control"
import { FSUtil } from "./fs-util"
import { Location } from "./location"
import { RelativePath } from "./schema"

export const ApplyInput = Schema.Struct({
  target: Control.ConfigTarget,
  value: Schema.Unknown,
}).annotate({ identifier: "ControlConfig.ApplyInput" })
export type ApplyInput = typeof ApplyInput.Type

export const ApplyOutput = Schema.Struct({
  path: RelativePath,
  format: Control.ConfigFormat,
  pointer: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "ControlConfig.ApplyOutput" })
export type ApplyOutput = typeof ApplyOutput.Type

export class UnsupportedFormatError extends Schema.TaggedErrorClass<UnsupportedFormatError>()(
  "ControlConfig.UnsupportedFormatError",
  {
    format: Control.ConfigFormat,
    message: Schema.String,
  },
) {}

export class InvalidPathError extends Schema.TaggedErrorClass<InvalidPathError>()("ControlConfig.InvalidPathError", {
  path: Schema.String,
  reason: Schema.Literals(["absolute", "escape"]),
  message: Schema.String,
}) {}

export interface Interface {
  readonly apply: (input: ApplyInput) => Effect.Effect<ApplyOutput, UnsupportedFormatError | InvalidPathError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ControlConfig") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const root = FSUtil.resolve(location.directory)
    const resolve = Effect.fn("ControlConfig.resolve")(function* (target: string) {
      if (path.isAbsolute(target)) {
        return yield* new InvalidPathError({
          path: target,
          reason: "absolute",
          message: "Config path must be relative to the location",
        })
      }
      const absolute = path.resolve(location.directory, target)
      if (!FSUtil.contains(root, absolute)) {
        return yield* new InvalidPathError({
          path: target,
          reason: "escape",
          message: "Config path escapes the location",
        })
      }
      return absolute
    })

    return Service.of({
      apply: Effect.fn("ControlConfig.apply")(function* (input) {
        if (input.target.format !== "json" && input.target.format !== "jsonc") {
          return yield* new UnsupportedFormatError({
            format: input.target.format,
            message: `Config format ${input.target.format} is not writable by inline controls yet`,
          })
        }

        const absolute = yield* resolve(input.target.path)
        const current = (yield* fs.readFileStringSafe(absolute).pipe(Effect.orDie)) ?? "{}\n"
        const edits = modify(current, pointerPath(input.target.pointer), input.value, {
          formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
          isArrayInsertion: false,
        })
        yield* fs.writeWithDirs(absolute, edits.length ? applyEdits(current, edits) : JSON.stringify(parse(current), null, 2)).pipe(
          Effect.orDie,
        )
        return {
          path: RelativePath.make(input.target.path),
          format: input.target.format,
          pointer: input.target.pointer,
        }
      }),
    })
  }),
)

export const locationLayer = layer

function pointerPath(pointer: string | undefined) {
  if (!pointer || pointer === "/") return []
  return pointer
    .replace(/^\//, "")
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
}
