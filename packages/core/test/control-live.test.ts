import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { ControlLive } from "@opencode-ai/core/control-live"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const directory = AbsolutePath.make("project")
const workspaceID = WorkspaceV2.ID.make("wrk_control_live")
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory, workspaceID })),
)
const it = testEffect(ControlLive.locationLayer.pipe(Layer.provideMerge(Layer.mergeAll(EventV2.defaultLayer, locationLayer))))

describe("ControlLive", () => {
  it.effect("publishes live updates to the location event stream", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const fiber = yield* events.subscribe(ControlLive.Updated).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      const output = yield* (yield* ControlLive.Service).publish({
        controlID: "demo-controls",
        control: "speed",
        bridge: "session",
        topic: "demo.speed",
        value: 2,
      })
      const received = Array.from(yield* Fiber.join(fiber))

      expect(output.eventID).toBe(received[0]?.id)
      expect(received[0]?.location).toEqual({ directory, workspaceID })
      expect(received[0]?.data).toEqual({
        controlID: "demo-controls",
        control: "speed",
        bridge: "session",
        topic: "demo.speed",
        value: 2,
        timestamp: output.timestamp,
      })
    }),
  )
})
