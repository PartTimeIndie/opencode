import { expect, test } from "bun:test"
import { liveOutput, LIVE_OUTPUT_BYTES } from "../src/tool/live-output"

test("decodes UTF-8 split across pipe chunks and labels stderr", () => {
  const preview = liveOutput()
  const bytes = Buffer.from("A😀B")
  preview.push("stdout", bytes.subarray(0, 3))
  preview.push("stdout", bytes.subarray(3))
  preview.push("stderr", Buffer.from("warning"))
  preview.finish()
  expect(preview.snapshot()).toEqual({ output: "A😀B\n[stderr]\nwarning", truncated: false })
})

test("keeps a bounded Unicode-safe tail under sustained output", () => {
  const preview = liveOutput()
  for (let i = 0; i < 100; i++) preview.push("stdout", Buffer.from("😀".repeat(1000)))
  const snapshot = preview.snapshot()
  expect(snapshot.truncated).toBe(true)
  expect(Buffer.byteLength(snapshot.output)).toBeLessThanOrEqual(LIVE_OUTPUT_BYTES)
  expect(snapshot.output).not.toContain("�")
  expect(snapshot.output.endsWith("😀")).toBe(true)
})
