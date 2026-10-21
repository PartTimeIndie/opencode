import { describe, expect, test } from "bun:test"
import { handoffRequestKey, hasHandoffRequestInSession, isHandoffRequestIdentity } from "./handoff-request"

describe("handoffRequestKey", () => {
  test("normalizes directory aliases while keeping session and request identity", () => {
    const request = { directory: "C:\\Repos\\Project-A", sessionID: "ses_1", requestID: "req_1" }

    expect(handoffRequestKey(request)).toBe(
      handoffRequestKey({ ...request, directory: "c:/repos/project-a/" }),
    )
    expect(handoffRequestKey(request)).not.toBe(handoffRequestKey({ ...request, requestID: "req_2" }))
    expect(handoffRequestKey(request)).not.toBe(handoffRequestKey({ ...request, sessionID: "ses_2" }))
  })
})

describe("hasHandoffRequestInSession", () => {
  test("matches normalized directory and session without crossing into another session", () => {
    const entries = {
      [handoffRequestKey({ directory: "C:/Repos/Project-A", sessionID: "ses_1", requestID: "req_1" })]: true,
      [handoffRequestKey({ directory: "C:/Repos/Project-A", sessionID: "ses_2", requestID: "req_2" })]: true,
    }

    expect(hasHandoffRequestInSession(entries, { directory: "c:\\repos\\project-a\\", sessionID: "ses_1" })).toBe(true)
    expect(hasHandoffRequestInSession(entries, { directory: "C:/Repos/Project-A", sessionID: "ses_3" })).toBe(false)
    expect(hasHandoffRequestInSession(entries, { directory: "C:/Other", sessionID: "ses_1" })).toBe(false)
  })
})

describe("isHandoffRequestIdentity", () => {
  test("accepts complete request identities and rejects malformed persisted values", () => {
    expect(isHandoffRequestIdentity({ directory: "C:/repo", sessionID: "ses_1", requestID: "req_1" })).toBe(true)
    expect(isHandoffRequestIdentity({ directory: "C:/repo", sessionID: "ses_1" })).toBe(false)
    expect(isHandoffRequestIdentity(null)).toBe(false)
  })
})
