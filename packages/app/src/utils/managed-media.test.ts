import { describe, expect, test } from "bun:test"
import type { FilePart } from "@opencode-ai/sdk/v2"
import { managedMediaRequest } from "./managed-media"

const part = (url: string): FilePart => ({
  id: "prt_1",
  sessionID: "ses_a b",
  messageID: "msg_1",
  type: "file",
  mime: "video/mp4",
  filename: "clip.mp4",
  url,
})

describe("managedMediaRequest", () => {
  test("builds a session-bound authenticated managed attachment request", () => {
    const request = managedMediaRequest({
      part: part("attachment://att_a/b"),
      representation: "content",
      serverUrl: "http://127.0.0.1:4096",
      directory: "C:/repo",
      username: "user",
      password: "secret",
    })
    if ("direct" in request) throw new Error("Expected managed request")

    expect(request.url.toString()).toBe("http://127.0.0.1:4096/app/attachment/content/att_a%2Fb?sessionID=ses_a+b")
    expect(request.headers.get("x-opencode-directory")).toBe("C:/repo")
    expect(request.headers.get("authorization")).toBe(`Basic ${btoa("user:secret")}`)
  })

  test("does not fetch already browser-safe URLs", () => {
    expect(
      managedMediaRequest({
        part: part("blob:local-preview"),
        representation: "preview",
        serverUrl: "http://127.0.0.1:4096",
        directory: "C:/repo",
      }),
    ).toEqual({ direct: "blob:local-preview" })
  })
})
