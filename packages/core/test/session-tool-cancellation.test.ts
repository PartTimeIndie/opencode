import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionToolCancellation } from "@opencode-ai/core/session/tool-cancellation"
import { SessionV2 } from "@opencode-ai/core/session"
import { testEffect } from "./lib/effect"

const it = testEffect(SessionToolCancellation.layer)
const sessionID = SessionV2.ID.make("ses_tool_cancellation")

describe("SessionToolCancellation", () => {
  it.effect("settles every active tool call for an interrupted session", () =>
    Effect.gen(function* () {
      const cancellation = yield* SessionToolCancellation.Service
      const first = yield* cancellation.register({ sessionID, callID: "call_first" })
      const second = yield* cancellation.register({ sessionID, callID: "call_second" })

      expect(yield* cancellation.cancelSession(sessionID)).toBe(true)
      expect(yield* first.cancelled).toEqual({ message: SessionToolCancellation.ManualCancelMessage })
      expect(yield* second.cancelled).toEqual({ message: SessionToolCancellation.ManualCancelMessage })
      expect(yield* cancellation.cancelSession(sessionID)).toBe(false)
    }),
  )
})
