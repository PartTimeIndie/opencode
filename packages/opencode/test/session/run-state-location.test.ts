import { describe, expect, it } from "bun:test"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Effect, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { InstanceRef, WorkspaceRef } from "../../src/effect/instance-ref"
import type { InstanceContext } from "../../src/project/instance-context"
import { BackgroundJob } from "../../src/background/job"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionRunState } from "../../src/session/run-state"
import { SessionV1 } from "@opencode-ai/core/v1/session"

const instanceDirectory = "C:/repo/run-state-location"

const background = Layer.mock(BackgroundJob.Service, {
  list: () => Effect.sync((): BackgroundJob.Info[] => []),
  cancel: () => Effect.succeed(undefined),
})
const bridgeLayer = EventV2Bridge.defaultLayer
const statusLayer = SessionStatus.layer.pipe(Layer.provide(bridgeLayer))
const layer = Layer.mergeAll(
  SessionRunState.layer.pipe(
    Layer.provide(bridgeLayer),
    Layer.provide(statusLayer),
    Layer.provide(background),
  ),
  statusLayer,
  bridgeLayer,
)

function provideTestInstance<A, E, R>(effect: Effect.Effect<A, E, R>) {
  const ctx: InstanceContext = {
    directory: instanceDirectory,
    worktree: instanceDirectory,
    project: {
      id: ProjectV2.ID.make("prj_run_state_location"),
      worktree: instanceDirectory,
      sandboxes: [],
      time: { created: 1, updated: 1 },
    },
  }
  return effect.pipe(Effect.provideService(InstanceRef, ctx), Effect.provideService(WorkspaceRef, undefined))
}

const sessionID = SessionID.make("ses_location_probe")
const withParts = () => ({}) as SessionV1.WithParts

describe("SessionRunState status location", () => {
  it("publishes busy and idle with the routing instance location", async () => {
    const received: Array<{ type: string; directory?: string; status?: string }> = []

    await Effect.runPromise(
      provideTestInstance(
        Effect.gen(function* () {
          const bridge = yield* EventV2Bridge.Service
          yield* bridge.listen((event) =>
            Effect.sync(() => {
              if (event.type === "session.status") {
                received.push({
                  type: event.type,
                  directory: event.location?.directory,
                  status: (event.data as { status?: { type: string } }).status?.type,
                })
              }
            }),
          )
          yield* SessionRunState.Service.use((svc) =>
            svc.ensureRunning(sessionID, Effect.succeed(withParts()), Effect.succeed(withParts())),
          )
          for (let guard = 0; guard < 120 && received.length < 2; guard++) {
            yield* Effect.sleep(25)
          }
        }).pipe(Effect.scoped),
      ).pipe(Effect.provide(layer)),
    )

    expect(received.length).toBeGreaterThanOrEqual(2)
    expect(received.map((event) => event.status)).toContain("busy")
    expect(received.map((event) => event.status)).toContain("idle")
    for (const event of received) {
      expect(event.directory).toBe(instanceDirectory)
    }
  })
})
