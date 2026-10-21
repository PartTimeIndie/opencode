import { describe, expect, test } from "bun:test"
import { createClient } from "../src/v2/gen/client/client.gen"

describe("generated fetch client", () => {
  test("consumes an empty JSON response before returning", async () => {
    let consumed = false
    class TrackingResponse extends Response {
      override async arrayBuffer() {
        consumed = true
        return super.arrayBuffer()
      }
    }
    const response = new TrackingResponse(null, { status: 204 })

    const client = createClient({
      baseUrl: "http://localhost",
      fetch: async () => response,
    })

    await client.get({ url: "/empty" })

    expect(consumed).toBe(true)
  })
})
