import { describe, expect, test } from "bun:test"
import { compareMessageTime, didMessageTailAdvance, latestMessage } from "./message-order"

const root = { id: "msg_80daf1f1f62f000994c26e3603", time: { created: 1788418804026 } }
const resumed = { id: "msg_06d8e45f2001F5K1Hrks6Vfk9F", time: { created: 1788544435744 } }
const latest = { id: "msg_06da7942d001gZ4lUKMCOdb3m9", time: { created: 1788546145359 } }

describe("message chronology", () => {
  test("orders mixed-generation IDs by creation time without mutating the input", () => {
    const messages = [resumed, latest, root]
    const snapshot = messages.slice()

    expect(messages.slice().sort(compareMessageTime)).toEqual([root, resumed, latest])
    expect(latestMessage(messages)).toBe(latest)
    expect(messages).toEqual(snapshot)
  })

  test("uses locale-independent binary message IDs as the deterministic timestamp tie-break", () => {
    const punctuation = { id: "msg_-", time: { created: 10 } }
    const upper = { id: "msg_Z", time: { created: 10 } }
    const lower = { id: "msg_a", time: { created: 10 } }

    expect([lower, upper, punctuation].sort(compareMessageTime)).toEqual([punctuation, upper, lower])
    expect(compareMessageTime(upper, lower)).toBeLessThan(0)
    expect(compareMessageTime(lower, upper)).toBeGreaterThan(0)
    expect(latestMessage([lower, punctuation, upper])).toBe(lower)
  })

  test("returns no latest message for an empty input", () => {
    expect(latestMessage([])).toBeUndefined()
  })

  test("releases a tail only for a chronological forward step", () => {
    expect(didMessageTailAdvance(undefined, root)).toBe(false)
    expect(didMessageTailAdvance(root, undefined)).toBe(false)
    expect(didMessageTailAdvance(resumed, resumed)).toBe(false)
    expect(didMessageTailAdvance(latest, root)).toBe(false)
    expect(didMessageTailAdvance(root, resumed)).toBe(true)
    expect(didMessageTailAdvance(resumed, latest)).toBe(true)
    expect(didMessageTailAdvance({ id: "msg_01", time: { created: 10 } }, { id: "msg_02", time: { created: 10 } })).toBe(true)
    expect(didMessageTailAdvance({ id: "msg_Z", time: { created: 10 } }, { id: "msg_a", time: { created: 10 } })).toBe(true)
    expect(didMessageTailAdvance({ id: "msg_a", time: { created: 10 } }, { id: "msg_Z", time: { created: 10 } })).toBe(false)
  })
})
