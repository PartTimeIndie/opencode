import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect, spyOn } from "bun:test"
import { Config, Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Workspace } from "../../src/control-plane/workspace"

import { InstanceBootstrap as InstanceBootstrapGraph } from "../../src/project/bootstrap"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { Session } from "../../src/session/session"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// W0 probe (plan: docs/workitems/2026-09-25-empty-503-trace.md): pin the exact
// HTTP behavior a client observes when an instance bootstrap fails or wedges,
// behind the same middleware chain production uses for /session/status.

let bootstrapRun: Effect.Effect<void> = Effect.void
const probeBootstrap = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.suspend(() => bootstrapRun) }),
)

const instanceStoreLayer = InstanceStore.defaultLayer.pipe(Layer.provide(probeBootstrap))
const workspaceLayer = Workspace.defaultLayer.pipe(
  Layer.provide(InstanceStore.defaultLayer),
  Layer.provide(InstanceBootstrapGraph.defaultLayer),
)

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)

const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)

const it = testEffect(
  Layer.mergeAll(
    instanceStoreLayer,
    Project.defaultLayer,
    Session.defaultLayer,
    workspaceLayer,
    Database.defaultLayer,
    httpApiLayer,
  ).pipe(Layer.provide(Ripgrep.defaultLayer)),
)

function statusRequest(directory: string) {
  return HttpClientRequest.get(`/session/status?directory=${encodeURIComponent(directory)}`).pipe(
    HttpClient.execute,
    Effect.flatMap((response) =>
      Effect.map(response.text, (body) => ({
        status: response.status,
        retryAfter: response.headers["retry-after"],
        body,
      })),
    ),
  )
}

function sessionListRequest(directory: string) {
  return HttpClientRequest.get(`/session?directory=${encodeURIComponent(directory)}`).pipe(
    HttpClient.execute,
    Effect.flatMap((response) =>
      Effect.map(response.text, (body) => ({
        status: response.status,
        retryAfter: response.headers["retry-after"],
        body,
      })),
    ),
  )
}

function discoverRequest(directory: string) {
  return HttpClientRequest.get(`/vcs/git/discover?directory=${encodeURIComponent(directory)}&maxDepth=1`).pipe(
    HttpClient.execute,
    Effect.flatMap((response) =>
      Effect.map(response.text, (body) => ({
        status: response.status,
        retryAfter: response.headers["retry-after"],
        body,
      })),
    ),
  )
}

const withEnv = (name: string, value: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env[name]
      process.env[name] = value
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[name]
        else process.env[name] = previous
      }),
  )

const setBootstrap = (run: Effect.Effect<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      bootstrapRun = run
    }),
    () =>
      Effect.sync(() => {
        bootstrapRun = Effect.void
      }),
  )

const withBootstrapTimeout = (ms: string) => withEnv("OPENCODE_SETTLEMENT_BOOTSTRAP_TIMEOUT_MS", ms)

describe("instance unavailable contract", () => {
  it.live("stalled project path returns 503 while global health stays responsive", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* withEnv("OPENCODE_INSTANCE_PATH_RESOLVE_TIMEOUT_MS", "50")
      const resolve = spyOn(FSUtil, "resolveAsync").mockImplementation(() => new Promise<string>(() => {}))
      yield* Effect.addFinalizer(() => Effect.sync(() => resolve.mockRestore()))
      const pending = yield* statusRequest(dir).pipe(Effect.forkScoped)
      yield* Effect.sleep("10 millis")
      const health = yield* HttpClientRequest.get("/global/health").pipe(HttpClient.execute)
      expect(health.status).toBe(200)
      const response = yield* Fiber.join(pending)
      expect(response.status).toBe(503)
      expect(response.retryAfter).toBeDefined()
      expect(JSON.parse(response.body)).toMatchObject({
        error: "instance_unavailable",
        reason: "project directory resolution timed out",
      })
    }),
  )

  it.live("crashed bootstrap answers the typed JSON 503 with a defect reason", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* setBootstrap(Effect.die(new Error("probe bootstrap failure")))
      const response = yield* statusRequest(dir)
      expect(response.status).toBe(503)
      expect(response.retryAfter).toBeDefined()
      const parsed: unknown = JSON.parse(response.body)
      expect(parsed).toMatchObject({
        error: "instance_unavailable",
        reason: expect.stringContaining("probe bootstrap failure"),
        retryAfterMs: expect.any(Number),
      })
      expect(JSON.stringify(parsed)).toContain("opencode-test")
    }),
  )

  it.live("interrupted cold session-list bootstrap returns typed 503 and the next request recovers", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      let bootCount = 0
      yield* setBootstrap(
        Effect.suspend(() => {
          bootCount++
          return bootCount === 1 ? Effect.interrupt : Effect.void
        }),
      )

      const interrupted = yield* sessionListRequest(dir)
      expect(interrupted.status).toBe(503)
      expect(interrupted.retryAfter).toBeDefined()
      expect(JSON.parse(interrupted.body)).toMatchObject({
        error: "instance_unavailable",
        reason: expect.stringContaining("instance bootstrap was interrupted"),
        retryAfterMs: expect.any(Number),
      })

      const recovered = yield* sessionListRequest(dir).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail(new Error("the next session-list request did not recover within 5 seconds")),
        }),
      )
      expect(recovered.status).toBe(200)
      expect(bootCount).toBe(2)
    }),
  )

  it.live("defective bootstrap answers the typed JSON 503 with a defect reason", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* setBootstrap(Effect.die(new Error("probe bootstrap defect")))
      const response = yield* statusRequest(dir)
      expect(response.status).toBe(503)
      expect(response.retryAfter).toBeDefined()
      const parsed: unknown = JSON.parse(response.body)
      expect(parsed).toMatchObject({
        error: "instance_unavailable",
        reason: expect.stringContaining("probe bootstrap defect"),
        retryAfterMs: expect.any(Number),
      })
      expect(JSON.stringify(parsed)).toContain("opencode-test")
    }),
  )

  it.live("wedged bootstrap settles with a structured JSON 503 and Retry-After at the deadline", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* withBootstrapTimeout("400")
      yield* setBootstrap(Effect.never)
      const response = yield* statusRequest(dir).pipe(
        Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(new Error("request still pending at deadline")) }),
      )
      expect(response.status).toBe(503)
      expect(response.retryAfter).toBeDefined()
      const parsed: unknown = JSON.parse(response.body)
      expect(parsed).toMatchObject({
        error: "instance_unavailable",
        retryAfterMs: expect.any(Number),
      })
      expect(JSON.stringify(parsed)).toContain("opencode-test")
    }),
  )

  it.live("circuit opens after repeated bootstrap deadline failures and fails fast", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* withBootstrapTimeout("300")
      yield* withEnv("OPENCODE_SETTLEMENT_MAX_INSTANCE_RELOADS_PER_HOUR", "2")
      yield* withEnv("OPENCODE_SETTLEMENT_CIRCUIT_COOLDOWN_MS", "300")
      yield* setBootstrap(Effect.never)
      const store = yield* InstanceStore.Service
      // Two wedged loads record failures through the deadline watchdog.
      for (const _ of [1, 2]) {
        yield* store
          .load({ directory: dir })
          .pipe(Effect.ignore, Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.void }))
        yield* Effect.sleep("50 millis")
      }
      // The third attempt must fail fast instead of wedging for another deadline.
      const started = Date.now()
      const response = yield* statusRequest(dir).pipe(
        Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new Error("circuit did not fail fast")) }),
      )
      expect(Date.now() - started).toBeLessThan(3_000)
      expect(response.status).toBe(503)
      const parsed: unknown = JSON.parse(response.body)
      expect(parsed).toMatchObject({ error: "instance_unavailable" })
      expect((parsed as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0)
      expect((parsed as { retryAfterMs: number }).retryAfterMs).toBeLessThanOrEqual(300)
    }),
  )

  it.live("recovers Git discovery and session routes after the bootstrap circuit cooldown", () =>
    Effect.gen(function* () {
      const blockedDirectory = yield* tmpdirScoped({ git: true })
      yield* withBootstrapTimeout("300")
      yield* withEnv("OPENCODE_SETTLEMENT_MAX_INSTANCE_RELOADS_PER_HOUR", "2")
      yield* withEnv("OPENCODE_SETTLEMENT_CIRCUIT_COOLDOWN_MS", "120")
      yield* setBootstrap(Effect.never)

      expect((yield* discoverRequest(blockedDirectory)).status).toBe(503)
      const secondTimeout = yield* discoverRequest(blockedDirectory)
      expect(secondTimeout.status).toBe(503)
      expect(JSON.parse(secondTimeout.body)).toMatchObject({
        error: "instance_unavailable",
        retryAfterMs: 120,
      })

      const blockedStatus = yield* statusRequest(blockedDirectory)
      expect(blockedStatus.status).toBe(503)
      expect(JSON.parse(blockedStatus.body)).toMatchObject({ error: "instance_unavailable" })

      const healthyDirectory = yield* tmpdirScoped({ git: true })
      yield* Effect.sync(() => {
        bootstrapRun = Effect.void
      })
      expect((yield* statusRequest(healthyDirectory)).status).toBe(200)

      yield* Effect.sleep("150 millis")
      expect((yield* statusRequest(blockedDirectory)).status).toBe(200)
      expect((yield* discoverRequest(blockedDirectory)).status).toBe(200)
    }),
  )
})
