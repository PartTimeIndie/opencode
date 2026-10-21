import { describe, expect, test } from "bun:test"
import type { FilePart } from "@opencode-ai/sdk/v2"
import { attached, contentUrl, inline, kind, previewUrl } from "./message-file"

function file(part: Partial<FilePart> = {}): FilePart {
  return {
    id: "part_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "file",
    mime: "text/plain",
    url: "file:///repo/README.txt",
    filename: "README.txt",
    ...part,
  }
}

describe("message-file", () => {
  test("treats data URLs as attachments", () => {
    expect(attached(file({ url: "data:text/plain;base64,SGVsbG8=" }))).toBe(true)
    expect(attached(file({ url: "attachment://att_1" }))).toBe(true)
    expect(attached(file())).toBe(false)
  })

  test("maps managed attachments to a session-bound content URL", () => {
    expect(contentUrl(file({ url: "attachment://att_a/b", sessionID: "ses_a b" }))).toBe(
      "/app/attachment/content/att_a%2Fb?sessionID=ses_a%20b",
    )
    expect(contentUrl(file())).toBe("file:///repo/README.txt")
  })

  test("maps managed timeline rendering to the bounded preview endpoint", () => {
    expect(previewUrl(file({ url: "attachment://att_a/b", sessionID: "ses_a b" }))).toBe(
      "/app/attachment/preview/att_a%2Fb?sessionID=ses_a%20b",
    )
    expect(previewUrl(file())).toBe("file:///repo/README.txt")
  })

  test("treats only non-attachment source ranges as inline references", () => {
    expect(
      inline(
        file({
          source: {
            type: "file",
            path: "/repo/README.txt",
            text: { value: "@README.txt", start: 0, end: 11 },
          },
        }),
      ),
    ).toBe(true)

    expect(
      inline(
        file({
          url: "data:text/plain;base64,SGVsbG8=",
          source: {
            type: "file",
            path: "/repo/README.txt",
            text: { value: "@README.txt", start: 0, end: 11 },
          },
        }),
      ),
    ).toBe(false)
  })

  test("separates image, video, audio and file attachment kinds", () => {
    expect(kind(file({ mime: "image/png" }))).toBe("image")
    expect(kind(file({ mime: "video/mp4" }))).toBe("video")
    expect(kind(file({ mime: "audio/mpeg" }))).toBe("audio")
    expect(kind(file({ mime: "application/pdf" }))).toBe("file")
  })
})
