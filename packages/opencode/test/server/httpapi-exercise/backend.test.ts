import { describe, expect, test } from "bun:test"
import { authProbePath, requireValidAuthProbe, toAuthProbeRequest } from "./backend"

describe("HTTP API auth probe paths", () => {
  test("uses schema-valid identifiers", () => {
    expect(authProbePath("/api/session/{sessionID}/message/{messageID}")).toBe(
      "/api/session/ses_auth_probe/message/msg_auth_probe",
    )
    expect(authProbePath("/api/session/:sessionID/surface/:requestID/reply")).toBe(
      "/api/session/ses_auth_probe/surface/que_auth_probe/reply",
    )
    expect(authProbePath("/api/permission/saved/{id}")).toBe("/api/permission/saved/psv_auth_probe")
    expect(authProbePath("/experimental/workspace/{id}")).toBe("/experimental/workspace/wrk_auth_probe")
  })

  test("turns wildcard file routes into a concrete readable path", () => {
    expect(authProbePath("/api/fs/read/*")).toBe("/api/fs/read/package.json")
  })

  test("proves valid credentials only through the safe health endpoint", async () => {
    const request = toAuthProbeRequest(
      { authProbe: undefined, method: "POST", path: "/experimental/worktree" },
      "valid",
      new AbortController().signal,
    )

    expect(request.method).toBe("GET")
    expect(request.url).toBe("http://localhost/global/health")
    expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from("opencode:secret").toString("base64")}`)
    expect(await request.text()).toBe("")
  })

  test("keeps missing-credential probes on the exact protected route", async () => {
    const request = toAuthProbeRequest(
      { authProbe: undefined, method: "POST", path: "/api/session/{sessionID}/prompt" },
      "missing",
      new AbortController().signal,
    )

    expect(request.method).toBe("POST")
    expect(request.url).toBe("http://localhost/api/session/ses_auth_probe/prompt")
    expect(request.headers.get("authorization")).toBeNull()
    expect(await request.json()).toEqual({})
  })

  test("requires a completed 200 health response", () => {
    expect(() => requireValidAuthProbe(result(200))).not.toThrow()
    expect(() => requireValidAuthProbe(result(401))).toThrow("expected 200, got 401")
    expect(() => requireValidAuthProbe(result(500))).toThrow("expected 200, got 500")
    expect(() => requireValidAuthProbe(result(0, true))).toThrow("timed out")
  })
})

function result(status: number, timedOut = false) {
  return { status, timedOut, contentType: "", text: "", body: undefined }
}
