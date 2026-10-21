import { describe, expect, test } from "bun:test"
import { preventNativeSubmit } from "./submit-event"

describe("composer submit event boundary", () => {
  test.each(["disabled", "pending", "resume"])("cancels navigation before the %s early return", () => {
    const event = new Event("submit", { cancelable: true })
    const submit = preventNativeSubmit((received) => {
      expect(received).toBe(event)
      expect(received.defaultPrevented).toBe(true)
      return
    })
    expect(submit(event)).toBeUndefined()
    expect(event.defaultPrevented).toBe(true)
  })

  test("cancels synchronously and preserves options and the pending result", async () => {
    const event = new Event("submit", { cancelable: true })
    const options = { resume: true }
    const result = Promise.resolve("admitted")
    const submit = preventNativeSubmit((received, input?: typeof options) => {
      expect(received.defaultPrevented).toBe(true)
      expect(input).toBe(options)
      return result
    })
    expect(submit(event, options)).toBe(result)
    expect(event.defaultPrevented).toBe(true)
    expect(await result).toBe("admitted")
  })

  test("keeps navigation canceled when the handler throws", () => {
    const event = new Event("submit", { cancelable: true })
    const submit = preventNativeSubmit(() => {
      throw new Error("submission failed")
    })
    expect(() => submit(event)).toThrow("submission failed")
    expect(event.defaultPrevented).toBe(true)
  })
})
