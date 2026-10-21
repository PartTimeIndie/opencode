import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { isAllowedRequestHost } from "@opencode-ai/server/cors"
import { describe, expect, it as bunIt } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { testEffect } from "../lib/effect"

const servedRoutes = HttpRouter.serve(HttpApiApp.routes, {
  disableListenLog: true,
  disableLogger: true,
})

const it = testEffect(
  Layer.mergeAll(
    servedRoutes.pipe(
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provideMerge(NodeServices.layer),
    ),
  ) as Parameters<typeof testEffect>[0])

const postHostCommand = (headers: Record<string, string>) =>
  HttpClient.execute(HttpClientRequest.post("/app/host/command").pipe(HttpClientRequest.setHeaders(headers)))

describe("HttpApi mutation origin guard", () => {
  it.live("rejects a state-changing request from a disallowed browser origin", () =>
    Effect.gen(function* () {
      const response = yield* postHostCommand({
        origin: "https://evil.example",
        "content-type": "application/json",
      })
      expect(response.status).toBe(403)
      expect(yield* response.text).toContain("Cross-origin mutation is not allowed")
    }),
  )

  it.live("lets allowed-origin mutations pass the guard and fail later in the route", () =>
    Effect.gen(function* () {
      const response = yield* postHostCommand({
        origin: "http://localhost:3000",
        "content-type": "application/json",
      })
      expect(response.status).not.toBe(403)
    }),
  )

  it.live("refuses non-JSON content types on the host command route", () =>
    Effect.gen(function* () {
      const response = yield* postHostCommand({ "content-type": "text/plain" })
      expect(response.status).not.toBe(200)
    }),
  )
})

describe("request host allowlist", () => {
  bunIt("accepts loopback names and configured origins, rejects rebound hosts", () => {
    expect(isAllowedRequestHost("localhost:4096")).toBe(true)
    expect(isAllowedRequestHost("127.0.0.1:4096")).toBe(true)
    expect(isAllowedRequestHost("[::1]:4096")).toBe(true)
    expect(isAllowedRequestHost(undefined)).toBe(true)
    expect(isAllowedRequestHost("evil.example")).toBe(false)
    expect(isAllowedRequestHost("evil.example", { cors: ["https://custom.example"] })).toBe(false)
    expect(isAllowedRequestHost("custom.example", { cors: ["https://custom.example"] })).toBe(true)
    // A deliberate non-loopback bind already publishes the server, so the
    // host check must not break that explicit exposure mode.
    expect(isAllowedRequestHost("evil.example", { hostname: "0.0.0.0" })).toBe(true)
  })
})
