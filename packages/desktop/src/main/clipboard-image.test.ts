import { describe, expect, test } from "bun:test"
import { readClipboardPng } from "./clipboard-image"

describe("async clipboard image reads", () => {
  const png = Buffer.from("encoded PNG")
  const decode = (input: Buffer) => ({
    isEmpty: () => input.length === 0,
    toPNG: () => png,
    getSize: () => ({ width: 17, height: 23 }),
  })

  test("reads an asynchronous clipboard item and materializes PNG", async () => {
    const formats: string[] = []
    const result = await readClipboardPng(async () => [{
      types: ["image/jpeg"],
      getType: async (type) => { formats.push(type); return new Blob(["JPEG"]) },
    }], decode)
    expect(result).toEqual({ buffer: png, width: 17, height: 23 })
    expect(formats).toEqual(["image/jpeg"])
  })

  test("prefers PNG across items and does not read text clipboard content", async () => {
    const formats: string[] = []
    const result = await readClipboardPng(async () => [
      { types: ["text/plain", "image/jpeg"], getType: async (type) => { formats.push(type); return new Blob(["JPEG"]) } },
      { types: ["image/png"], getType: async (type) => { formats.push(type); return new Blob(["PNG"]) } },
    ], decode)
    expect(result?.buffer).toEqual(png)
    expect(formats).toEqual(["image/png"])
    expect(await readClipboardPng(async () => [{
      types: ["text/plain"], getType: async () => { throw new Error("Text must not be read") },
    }], decode)).toBeNull()
  })

  test("returns null for empty, non-Blob or undecodable image items", async () => {
    expect(await readClipboardPng(async () => [], decode)).toBeNull()
    expect(await readClipboardPng(async () => [{ types: ["image/png"], getType: async () => ({}) }], decode)).toBeNull()
    expect(await readClipboardPng(async () => [{ types: ["image/png"], getType: async () => new Blob([]) }], decode)).toBeNull()
  })

  test("propagates native clipboard failures instead of reporting success", async () => {
    await expect(readClipboardPng(async () => { throw new Error("Clipboard unavailable") }, decode))
      .rejects.toThrow("Clipboard unavailable")
    await expect(readClipboardPng(async () => [{
      types: ["image/png"], getType: async () => { throw new Error("Item changed") },
    }], decode)).rejects.toThrow("Item changed")
  })
})
