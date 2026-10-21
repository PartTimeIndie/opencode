import { Global } from "@opencode-ai/core/global"
import { afterEach, describe, expect, test } from "bun:test"
import { rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { ProofAttachment } from "../../src/attachment/proof"

const files = new Set<string>()

afterEach(async () => {
  await Promise.all(Array.from(files, (file) => rm(file, { force: true })))
  files.clear()
})

describe("proof attachment byte ranges", () => {
  test("rejects ranges for empty content and keeps inclusive one-byte boundaries", () => {
    expect(ProofAttachment.rangeFromHeader("bytes=0-0", 0)).toBe("invalid")
    expect(ProofAttachment.rangeFromHeader("bytes=0-0", 1)).toEqual({ start: 0, end: 0 })
    expect(ProofAttachment.rangeFromHeader("bytes=1-1", 1)).toBe("invalid")
    expect(ProofAttachment.rangeFromHeader("bytes=9-20", 10)).toEqual({ start: 9, end: 9 })
    expect(ProofAttachment.rangeFromHeader("bytes=10-20", 10)).toBe("invalid")
  })

  test("streams exact first, single, and final bytes from a large Windows file", async () => {
    const file = path.join(Global.Path.tmp, `proof-range-${crypto.randomUUID()}.bin`)
    files.add(file)
    const bytes = new Uint8Array(1024 * 1024 + 17).map((_, index) => index % 251)
    await writeFile(file, bytes)

    expect(await read(file, { start: 0, end: 0 })).toEqual(bytes.slice(0, 1))
    expect(await read(file, { start: 0, end: 31 })).toEqual(bytes.slice(0, 32))
    expect(await read(file, { start: bytes.byteLength - 1, end: bytes.byteLength - 1 })).toEqual(bytes.slice(-1))
  })

  test("streams the complete attachment when no range is requested", async () => {
    const file = path.join(Global.Path.tmp, `proof-full-${crypto.randomUUID()}.bin`)
    files.add(file)
    const bytes = new Uint8Array(1024 * 1024 + 17).map((_, index) => index % 251)
    await writeFile(file, bytes)

    expect(new Uint8Array(await new Response(ProofAttachment.readStream(file)).arrayBuffer())).toEqual(bytes)
  })
})

async function read(file: string, range: ProofAttachment.ByteRange) {
  return new Uint8Array(await new Response(ProofAttachment.readStream(file, range)).arrayBuffer())
}
