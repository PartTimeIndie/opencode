import { describe, expect, test } from "bun:test"
import { serializeErrorEvent } from "@/cli/cmd/run/error-event"

describe("run error events", () => {
  test("materializes non-enumerable error fields for JSON output", () => {
    const error = new Error("provider overloaded")
    Object.defineProperty(error, "data", {
      value: { code: "server_is_overloaded", message: "Please try again later." },
      enumerable: false,
    })

    expect(JSON.parse(JSON.stringify(serializeErrorEvent(error)))).toEqual({
      name: "Error",
      data: {
        code: "server_is_overloaded",
        message: "Please try again later.",
      },
    })
  })
})
