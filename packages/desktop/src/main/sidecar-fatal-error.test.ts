import { describe, expect, test } from "bun:test"
import { formatSidecarFatalError } from "./sidecar-fatal-error"

describe("sidecar fatal error diagnostics", () => {
  test("retains the V8 location and stacks without persisting the diagnostic report", () => {
    const output = formatSidecarFatalError("FatalError", "v8::HandleScope::CreateHandle()", JSON.stringify({
      header: { commandLine: ["secret-command-line"], event: "secret-event" },
      environmentVariables: { BWS_ACCESS_TOKEN: "secret-token" },
      javascriptStack: { message: "secret-error-message", stack: ["at probe (fixture.js:12:3)"], errorProperties: { secret: "secret-property" } },
      nativeStack: [{ pc: "0x1234", symbol: "v8::internal::HandleScope::Extend", secret: "secret-frame" }],
      workers: [{ environmentVariables: { TOKEN: "secret-worker-token" } }],
    }))
    expect(output).toContain("v8::HandleScope::CreateHandle()")
    expect(output).toContain("at probe (fixture.js:12:3)")
    expect(output).toContain("v8::internal::HandleScope::Extend")
    expect(output).not.toContain("secret-")
    expect(output).not.toContain("environmentVariables")
    expect(output).not.toContain("commandLine")
  })

  test.each(["not JSON", "null", "[]", "1", JSON.stringify({ nativeStack: {}, javascriptStack: [] })])(
    "malformed reports do not throw or hide the fatal event: %s", (report) => {
      expect(formatSidecarFatalError("FatalError", "native location", report)).toContain("native location")
    },
  )

  test("bounds report parsing, frame counts and individual strings", () => {
    const output = formatSidecarFatalError("FatalError", "x".repeat(2000), JSON.stringify({
      javascriptStack: { stack: Array.from({ length: 100 }, () => "j".repeat(2000)) },
      nativeStack: Array.from({ length: 100 }, () => ({ symbol: "n".repeat(2000) })),
    }))
    expect(output.length).toBeLessThan(26_000)
    expect(output).not.toContain("x".repeat(513))
    expect(output).not.toContain("j".repeat(513))
    expect(output).not.toContain("n".repeat(513))
    expect(formatSidecarFatalError("FatalError", "native location", "s".repeat(2_000_001)))
      .toContain("report omitted")
  })

  test("ignores malformed frames rather than serializing arbitrary objects", () => {
    const output = formatSidecarFatalError("FatalError", "native location", JSON.stringify({
      javascriptStack: { stack: [{ secret: "secret-js" }, 1, null, "at safe (fixture.js:1:1)"] },
      nativeStack: [null, "secret-native", { symbol: { secret: "secret-symbol" } }, { symbol: "safe native frame" }],
    }))
    expect(output).toContain("at safe (fixture.js:1:1)")
    expect(output).toContain("safe native frame")
    expect(output).not.toContain("secret-")
  })
})
