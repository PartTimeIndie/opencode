export * as ControlLive from "./control-live"

import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { EventV2 } from "./event"
import { V2Schema } from "./v2-schema"

export const PublishInput = Schema.Struct({
  controlID: Schema.String,
  control: Schema.String.pipe(Schema.optional),
  bridge: Schema.Literal("session"),
  topic: Schema.String.pipe(Schema.optional),
  value: Schema.Unknown,
}).annotate({ identifier: "ControlLive.PublishInput" })
export type PublishInput = typeof PublishInput.Type

export const PublishOutput = Schema.Struct({
  eventID: EventV2.ID,
  timestamp: V2Schema.DateTimeUtcFromMillis,
}).annotate({ identifier: "ControlLive.PublishOutput" })
export type PublishOutput = typeof PublishOutput.Type

export const Updated = EventV2.define({
  type: "control.live.updated",
  schema: {
    controlID: Schema.String,
    control: Schema.String.pipe(Schema.optional),
    bridge: Schema.Literal("session"),
    topic: Schema.String.pipe(Schema.optional),
    value: Schema.Unknown,
    timestamp: V2Schema.DateTimeUtcFromMillis,
  },
})

export interface Interface {
  readonly publish: (input: PublishInput) => Effect.Effect<PublishOutput>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ControlLive") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service

    return Service.of({
      publish: Effect.fn("ControlLive.publish")(function* (input) {
        const timestamp = yield* DateTime.now
        const event = yield* events.publish(Updated, {
          controlID: input.controlID,
          ...(input.control ? { control: input.control } : {}),
          bridge: input.bridge,
          ...(input.topic ? { topic: input.topic } : {}),
          value: input.value,
          timestamp,
        })
        return { eventID: event.id, timestamp }
      }),
    })
  }),
)

export const locationLayer = layer
