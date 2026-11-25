import { describe, expect, test } from "bun:test"
import { attachmentMime, pickAttachmentFiles, sameClipboardFile, uniqueClipboardFiles } from "./files"
import { pasteMode } from "./paste"

describe("attachmentMime", () => {
  test("keeps short archive headers out of text decoding", async () => {
    for (const [name, mime] of [["save.7z", "application/x-7z-compressed"], ["save.zip", "application/zip"], ["save.tar.gz", "application/gzip"]]) {
      expect(await attachmentMime(new File(["PK"], name))).toBe(mime)
    }
  })
  test("keeps PDFs when the browser reports the mime", async () => {
    const file = new File(["%PDF-1.7"], "guide.pdf", { type: "application/pdf" })
    expect(await attachmentMime(file)).toBe("application/pdf")
  })

  test("normalizes structured text types to text/plain", async () => {
    const file = new File(['{"ok":true}\n'], "data.json", { type: "application/json" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("accepts text files even with a misleading browser mime", async () => {
    const file = new File(["export const x = 1\n"], "main.ts", { type: "video/mp2t" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("preserves video, audio and generic binary MIME types", async () => {
    const files = [
      new File([Uint8Array.of(0, 1, 2, 3)], "clip.mp4", { type: "video/mp4" }),
      new File([Uint8Array.of(0, 1, 2, 3)], "voice.mp3", { type: "audio/mpeg" }),
      new File([Uint8Array.of(0, 1, 2, 3)], "desktop-clip.mp4"),
      new File([Uint8Array.of(0, 1, 2, 3)], "desktop-voice.mp3"),
      new File([Uint8Array.of(0, 255, 1, 2)], "blob.bin", { type: "application/octet-stream" }),
      new File([Uint8Array.of(0, 255, 1, 2)], "unknown.bin"),
    ]

    expect(await Promise.all(files.map(attachmentMime))).toEqual([
      "video/mp4",
      "audio/mpeg",
      "video/mp4",
      "audio/mpeg",
      "application/octet-stream",
      "application/octet-stream",
    ])
  })
})

describe("pickAttachmentFiles", () => {
  test("reads the current project directory for every native picker invocation", async () => {
    const paths: string[] = []
    const files: File[] = []
    const file = new File(["hello"], "hello.txt", { type: "text/plain" })
    let directory = "C:\\Projects\\LoremIpsum"
    const picker = async (options?: { defaultPath?: string }, onFile?: (file: File) => Promise<unknown>) => {
      paths.push(options?.defaultPath ?? "")
      await onFile?.(file)
    }

    pickAttachmentFiles({
      picker,
      directory: () => directory,
      fallback: () => undefined,
      onFile: async (selected) => files.push(selected),
      onError: () => undefined,
    })
    await Promise.resolve()
    directory = "C:\\Projects\\DolorSit"
    pickAttachmentFiles({
      picker,
      directory: () => directory,
      fallback: () => undefined,
      onFile: async (selected) => files.push(selected),
      onError: () => undefined,
    })
    await Promise.resolve()
    expect(files).toEqual([file, file])
    expect(paths).toEqual(["C:\\Projects\\LoremIpsum", "C:\\Projects\\DolorSit"])
  })

  test("uses the browser file input when no native picker exists", async () => {
    let fallback = 0
    pickAttachmentFiles({
      directory: () => "/projects/consectetur-adipiscing",
      fallback: () => {
        fallback += 1
      },
      onFile: async () => undefined,
      onError: () => undefined,
    })
    expect(fallback).toBe(1)
  })

  test("reports native picker failures without rejecting", async () => {
    const error = new Error("picker unavailable")
    const errors: unknown[] = []
    const handled = Promise.withResolvers<void>()
    pickAttachmentFiles({
      picker: async () => Promise.reject(error),
      directory: () => "C:\\Projects\\LoremIpsum",
      fallback: () => undefined,
      onFile: async () => undefined,
      onError: (cause) => {
        errors.push(cause)
        handled.resolve()
      },
    })
    await handled.promise
    expect(errors).toEqual([error])
  })
})

describe("uniqueClipboardFiles", () => {
  test("keeps one copy when the clipboard exposes the same image more than once", async () => {
    const options = { type: "image/png", lastModified: 1_700_000_000_000 }
    const first = new File(["same image"], "clipboard.png", options)
    const duplicate = new File(["same image"], "clipboard.png", options)

    expect(await uniqueClipboardFiles([first, duplicate])).toEqual([first])
  })

  test("ignores metadata differences when duplicate clipboard items contain the same image", async () => {
    const first = new File(["same image"], "clipboard.png", { type: "image/png", lastModified: 1 })
    const duplicate = new File(["same image"], "Screenshot 2026-07-21.png", {
      type: "application/octet-stream",
      lastModified: 2,
    })

    expect(await uniqueClipboardFiles([first, duplicate])).toEqual([first])
  })

  test("preserves distinct images from a multi-file clipboard paste", async () => {
    const first = new File(["first"], "first.png", { type: "image/png", lastModified: 1 })
    const second = new File(["second"], "second.png", { type: "image/png", lastModified: 2 })

    expect(await uniqueClipboardFiles([first, second])).toEqual([first, second])
  })

  test("preserves different clipboard images with matching metadata", async () => {
    const options = { type: "image/png", lastModified: 1_700_000_000_000 }
    const first = new File(["first"], "clipboard.png", options)
    const second = new File(["other"], "clipboard.png", options)

    expect(await uniqueClipboardFiles([first, second])).toEqual([first, second])
  })
})

describe("sameClipboardFile", () => {
  test("matches identical image payloads across separate clipboard events", async () => {
    const first = new File(["same image"], "clipboard.png", { type: "image/png", lastModified: 1 })
    const duplicate = new File(["same image"], "Screenshot.png", {
      type: "application/octet-stream",
      lastModified: 2,
    })

    expect(await sameClipboardFile(first, duplicate)).toBe(true)
  })

  test("does not match different image payloads", async () => {
    const first = new File(["first"], "clipboard.png", { type: "image/png" })
    const second = new File(["other"], "clipboard.png", { type: "image/png" })

    expect(await sameClipboardFile(first, second)).toBe(false)
  })
})

describe("pasteMode", () => {
  test("uses native paste for short single-line text", () => {
    expect(pasteMode("hello world")).toBe("native")
  })

  test("uses manual paste for multiline text", () => {
    expect(
      pasteMode(`{
  "ok": true
}`),
    ).toBe("manual")
    expect(pasteMode("a\r\nb")).toBe("manual")
  })

  test("uses manual paste for large text", () => {
    expect(pasteMode("x".repeat(8000))).toBe("manual")
  })
})
