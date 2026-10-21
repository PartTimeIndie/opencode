import { describe, expect, test } from "bun:test"
import { SessionV2 } from "@opencode-ai/core/session"
import { Surface } from "@opencode-ai/core/surface"
import { Effect, Layer } from "effect"
import { dismissSurfaceRequest } from "../src/handlers/surface"

const sessionID = SessionV2.ID.make("ses_surface_settlement")
const requestID = Surface.ID.make("que_surface_settlement")

describe("SurfaceHandler.dismissSurfaceRequest", () => {
  test("dismisses a Surface without interrupting its session activity", async () => {
    const dismissed: Array<{ requestID: Surface.ID; sessionID?: SessionV2.ID }> = []
    const surface = Surface.Service.of({
      ask: () => Effect.die("unused"),
      askDetached: () => Effect.die("dismiss must not ask another question"),
      askDurable: () => Effect.die("unused"),
      open: () => Effect.die("unused"),
      present: () => Effect.die("unused"),
      reply: () => Effect.die("unused"),
      reject: (id, owner) =>
        Effect.sync(() => {
          dismissed.push({ requestID: id, sessionID: owner })
          return true
        }),
      dismissSession: () => Effect.die("unused"),
      dismissFollowups: () => Effect.die("unused"),
      settlementTarget: () => Effect.die("dismiss must not inspect or interrupt the owning activity"),
      get: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
      createPersistentTool: () => Effect.die("unused"),
      listPersistentTools: () => Effect.die("unused"),
      updatePersistentToolState: () => Effect.die("unused"),
      setPersistentToolHidden: () => Effect.die("unused"),
      removePersistentTool: () => Effect.die("unused"),
      beginActionInvocation: () => Effect.die("unused"),
      beginActionEffect: () => Effect.die("dismiss must not start an action effect"),
      getActionInvocation: () => Effect.die("dismiss must not inspect action invocations"),
      completeActionInvocation: () => Effect.die("unused"),
      failActionInvocation: () => Effect.die("unused"),
      actionInvocations: () => Effect.die("unused"),
    })

    const result = await Effect.runPromise(
      dismissSurfaceRequest({ sessionID, requestID }).pipe(Effect.provide(Layer.succeed(Surface.Service, surface))),
    )

    expect(result).toEqual({ status: "settled" })
    expect(dismissed).toEqual([{ requestID, sessionID }])
  })
})
