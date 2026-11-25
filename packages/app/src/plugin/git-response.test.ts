import { describe, expect, test } from "bun:test"
import { readGitResponse } from "./git-response"

describe("Git host responses", () => {
  test("reports startup without parsing plaintext as JSON", async () => {
    const response = new Response("Server is starting", { status: 503 })
    await expect(readGitResponse(response)).rejects.toThrow(
      "OpenCode server is starting (HTTP 503). Refresh the Git status before retrying an action.",
    )
  })

  test("preserves typed history errors and HTTP status", async () => {
    const response = new Response(JSON.stringify({ data: { message: "Bad ref", code: "bad_ref", recovery: "refresh" } }), { status: 400 })
    await expect(readGitResponse(response, true)).rejects.toMatchObject({ message: "Git request failed (HTTP 400): Bad ref", status: 400, code: "bad_ref", recovery: "refresh" })
  })

  test("handles cancellation, success and invalid responses", async () => {
    await expect(readGitResponse(new Response("", { status: 499 }))).rejects.toMatchObject({ name: "AbortError" })
    expect(await readGitResponse(new Response('{"ok":true}'))).toEqual({ ok: true })
    await expect(readGitResponse(new Response("invalid"))).rejects.toThrow("invalid JSON")
    await expect(readGitResponse(new Response("Unavailable", { status: 502 }))).rejects.toThrow("HTTP 502): Unavailable")
  })
})
