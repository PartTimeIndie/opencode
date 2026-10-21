import { ControlConfig } from "@opencode-ai/core/control-config"
import { ControlLive } from "@opencode-ai/core/control-live"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../groups/location"

export const ControlHandler = HttpApiBuilder.group(Api, "server.control", (handlers) =>
  Effect.gen(function* () {
    const live = yield* ControlLive.Service
    return handlers.handle(
      "control.config.apply",
      Effect.fn(function* (ctx) {
        return yield* response((yield* ControlConfig.Service).apply(ctx.payload))
      }),
    ).handle(
      "control.live.publish",
      Effect.fn(function* (ctx) {
        return yield* response(live.publish(ctx.payload))
      }),
    )
  }),
)
