export * as SystemContextBuiltIns from "./builtins"

import { DateTime, Effect, Layer, Schema } from "effect"
import { Location } from "../location"
import { SystemContext } from "./index"
import { InstructionContext } from "../instruction-context"
import { SystemContextRegistry } from "./registry"

const builtIns = Layer.effectDiscard(
  Effect.gen(function* () {
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service
    const environment = [
      "<env>",
      `  cwd: ${location.directory}`,
      `  root: ${location.project.directory}`,
      `  git: ${location.vcs?.type === "git" ? "yes" : "no"}`,
      `  platform: ${process.platform}`,
      "</env>",
    ].join("\n")
    const context = SystemContext.combine([
      SystemContext.make({
        key: SystemContext.Key.make("core/environment"),
        codec: Schema.toCodecJson(Schema.String),
        load: Effect.succeed(environment),
        baseline: (environment) => ["Environment:", environment].join("\n"),
        update: (_previous, environment) => ["Environment changed:", environment].join("\n"),
      }),
      SystemContext.make({
        key: SystemContext.Key.make("core/date"),
        codec: Schema.toCodecJson(Schema.String),
        load: DateTime.nowAsDate.pipe(Effect.map((date) => date.toDateString())),
        baseline: (date) => `Date: ${date}`,
        update: (_previous, date) => `Date now: ${date}`,
      }),
    ])

    yield* registry.register({ key: SystemContext.Key.make("core/builtins"), load: Effect.succeed(context) })
  }),
)

export const layer = Layer.mergeAll(builtIns, InstructionContext.layer).pipe(
  Layer.provideMerge(SystemContextRegistry.layer),
)

export const locationLayer = layer
