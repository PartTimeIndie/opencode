import { describe, expect, test } from "bun:test"
import { resultFromWorkerOutput } from "./real-session-archive"

const prefix = "__OPENCODE_ARCHIVE_RESULT__"

describe("resultFromWorkerOutput", () => {
  test("parses a complete worker result", () => {
    const result = resultFromWorkerOutput({
      command: "page",
      code: 0,
      output: `${prefix}${JSON.stringify({ items: [1, 2], cursor: "next" })}\n`,
      errorOutput: "",
    })
    expect(result).toEqual({ ok: true, value: { items: [1, 2], cursor: "next" } })
  })

  test("reports a diagnostic error for a truncated payload instead of a bare SyntaxError", () => {
    const result = resultFromWorkerOutput({
      command: "page",
      code: 0,
      output: `${prefix}{"items":[{"id":"msg_0","text":"truncat`,
      errorOutput: "",
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain("Real archive worker page result was incomplete or unparsable")
    expect(result.error.message).toContain("bytes stdout")
    expect(result.error.message).toContain("char payload")
    expect(result.error.message).toContain("exit 0")
    expect(result.error.message).toContain(`${prefix}{"items"`)
    expect(result.error.message).toContain("truncat")
  })

  test("fails with command output when the worker exits non-zero", () => {
    const result = resultFromWorkerOutput({
      command: "inspect",
      code: 1,
      output: "",
      errorOutput: "boom: catalog missing",
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain("Real archive worker inspect failed (1)")
    expect(result.error.message).toContain("boom: catalog missing")
  })

  test("fails when a zero-exit worker never emitted the result marker", () => {
    const result = resultFromWorkerOutput({ command: "catalog", code: 0, output: "unrelated noise\n", errorOutput: "" })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain("Real archive worker catalog failed (0)")
  })
})
