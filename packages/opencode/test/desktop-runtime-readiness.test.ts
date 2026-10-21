import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { probeDesktopRuntime } from "../script/desktop-prod-deploy"

test("a running desktop with a failed sidecar cannot satisfy the deployment readiness check", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-runtime-readiness-"))
  const tokenFile = path.join(directory, "connection.json")
  const state = { healthy: false, error: null as string | null }
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    if (request.headers.get("authorization") !== "Bearer readiness-test") return new Response(null, { status: 401 })
    return Response.json({ sidecar: { healthy: state.healthy }, renderer: { error: state.error } })
  } })
  try {
    fs.writeFileSync(tokenFile, JSON.stringify({ url: server.url.href, token: "readiness-test" }))
    expect(await probeDesktopRuntime(tokenFile)).toBe(false)
    state.healthy = true
    expect(await probeDesktopRuntime(tokenFile)).toBe(true)
    state.error = "renderer failed"
    expect(await probeDesktopRuntime(tokenFile)).toBe(false)
    fs.writeFileSync(tokenFile, JSON.stringify({ url: server.url.href, token: "stale-token" }))
    expect(await probeDesktopRuntime(tokenFile)).toBe(false)
    fs.writeFileSync(tokenFile, "invalid")
    expect(await probeDesktopRuntime(tokenFile)).toBe(false)
  } finally {
    server.stop(true)
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
