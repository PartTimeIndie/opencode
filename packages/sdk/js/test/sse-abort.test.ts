import { expect, test } from "bun:test"
import { createSseClient } from "../src/v2/gen/core/serverSentEvents.gen"

test("aborting an SSE stream is a clean terminal close", async () => {
  const abort = new AbortController()
  const errors: unknown[] = []
  const result = createSseClient({
    url: "http://localhost/events",
    signal: abort.signal,
    fetch: (request) =>
      new Promise<Response>((_, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(new DOMException("expected abort", "AbortError")),
          { once: true },
        )
      }),
    onSseError(error) {
      errors.push(error)
    },
    sseSleepFn: async () => undefined,
  })

  const pending = result.stream.next()
  await Promise.resolve()
  abort.abort()

  expect(await pending).toMatchObject({ done: true })
  expect(errors).toEqual([])
})
