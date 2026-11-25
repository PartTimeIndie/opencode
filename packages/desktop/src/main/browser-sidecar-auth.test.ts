import { describe, expect, test } from "bun:test"
import { ownsSidecarLogin, sidecarBrowserAuthorization } from "./browser-sidecar-auth"

describe("browser sidecar authorization", () => {
  const sidecar = { url: "http://127.0.0.1:4098", username: "opencode", password: "secret" }
  const expected = "Basic b3BlbmNvZGU6c2VjcmV0"

  test("declines utility-process, foreign-session and proxy login challenges", () => {
    const session = {}
    expect(ownsSidecarLogin(null, session, false)).toBe(false)
    expect(ownsSidecarLogin({ session: {} }, session, false)).toBe(false)
    expect(ownsSidecarLogin({ session }, session, true)).toBe(false)
    expect(ownsSidecarLogin({ session }, session, false)).toBe(true)
  })

  test("allows the current sidecar origin", () => {
    expect(sidecarBrowserAuthorization("http://127.0.0.1:4098/session", sidecar)).toBe(expected)
  })

  test("never sends credentials to a different origin", () => {
    expect(sidecarBrowserAuthorization("http://127.0.0.1:4099/session", sidecar)).toBeUndefined()
    expect(sidecarBrowserAuthorization("https://127.0.0.1:4098/session", sidecar)).toBeUndefined()
    expect(sidecarBrowserAuthorization("http://localhost:4098/session", sidecar)).toBeUndefined()
    expect(sidecarBrowserAuthorization("https://example.com/?target=127.0.0.1:4098", sidecar)).toBeUndefined()
  })

  test("does not authorize malformed URLs or an unavailable sidecar", () => {
    expect(sidecarBrowserAuthorization("not a url", sidecar)).toBeUndefined()
    expect(sidecarBrowserAuthorization("http://127.0.0.1:4098", undefined)).toBeUndefined()
    expect(
      sidecarBrowserAuthorization("https://sidecar.example.test", {
        url: "https://sidecar.example.test",
        password: "secret",
      }),
    ).toBeUndefined()
  })
})
