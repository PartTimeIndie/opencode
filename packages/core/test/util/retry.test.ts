import { describe, expect, test } from "bun:test"
import { retry } from "@opencode-ai/core/util/retry"

describe("retry", () => {
  test.each([408, 425, 429, 500, 503, 599])("retries transient HTTP status %d", async (status) => {
    let calls = 0
    const result = await retry(
      async () => {
        calls += 1
        if (calls === 1) throw new Error("Request failed", { cause: { status } })
        return "recovered"
      },
      { delay: 0 },
    )

    expect(result).toBe("recovered")
    expect(calls).toBe(2)
  })

  test.each([400, 401, 403, 404, 409])("does not retry non-transient HTTP status %d", async (status) => {
    let calls = 0
    const error = Object.assign(new Error("Request failed"), { status })

    await expect(
      retry(
        async () => {
          calls += 1
          throw error
        },
        { delay: 0 },
      ),
    ).rejects.toBe(error)
    expect(calls).toBe(1)
  })

  test("accepts generated API statusCode errors", async () => {
    let calls = 0
    await retry(
      async () => {
        calls += 1
        if (calls === 1) throw { name: "APIError", statusCode: 503 }
      },
      { delay: 0 },
    )

    expect(calls).toBe(2)
  })
})
