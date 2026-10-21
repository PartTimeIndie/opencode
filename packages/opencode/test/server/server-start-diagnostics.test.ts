import { describe, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { Cause, Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Logger, Ref, References, Scope } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { Global } from "@opencode-ai/core/global"
import { Observability } from "@opencode-ai/core/observability"
import { Logging } from "@opencode-ai/core/observability/logging"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { disposeMiddleware } from "../../src/server/routes/instance/httpapi/lifecycle"
import { logLines } from "effect/testing/TestConsole"
import { adjust } from "effect/testing/TestClock"
import { measureServerStartLayer } from "../../src/server/routes/instance/httpapi/server-start-diagnostics"
import { testEffect } from "../lib/effect"

class ReadyService extends Context.Service<ReadyService, { readonly value: string }>()("test/ServerStartReady") {}
class AppService extends Context.Service<AppService, { readonly value: string }>()("test/ServerStartApp") {}

const it = testEffect(Layer.empty)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function phaseLogs(lines: readonly unknown[]) {
  return lines.flatMap((line) => {
    if (isRecord(line) && typeof line.phase === "string") return [line]
    if (Array.isArray(line) && line[0] === "server startup phase" && isRecord(line[1])) return [line[1]]
    return []
  })
}

function isRoundedToThreeDecimals(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number(value.toFixed(3)) === value
}

function phaseLogfmt(contents: string) {
  return contents.split(/\r?\n/).flatMap((line) => {
    const payload = line.match(/message="server startup phase"\s+(.*)$/)?.[1]
    if (!payload) return []
    const fields = Object.fromEntries(
      [...payload.matchAll(/([^=\s]+)=([^\s]+)/g)].map((match) => [match[1], match[2]]),
    )
    return [
      {
        keys: Object.keys(fields).sort(),
        phase: fields.phase,
        startedAt: Number(fields.startedAt),
        finishedAt: Number(fields.finishedAt),
        durationMs: Number(fields.durationMs),
        outcome: fields.outcome,
      },
    ]
  })
}

describe("server start layer diagnostics", () => {
  it.effect("reports a gated slow layer and preserves service scope lifetime", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const finalizers = yield* Ref.make(0)
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.asVoid))

      const appLayer = Layer.effect(
        AppService,
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
          yield* Effect.addFinalizer(() => Ref.update(finalizers, (count) => count + 1))
          return AppService.of({ value: "ready" })
        }),
      )
      const routeLayer = Layer.effect(
        ReadyService,
        Effect.gen(function* () {
          return ReadyService.of({ value: (yield* AppService).value })
        }),
      ).pipe(Layer.provide(measureServerStartLayer("app-service-graph", appLayer)))
      const building = yield* Layer.buildWithScope(
        measureServerStartLayer("httpapi-route-layer", routeLayer),
        scope,
      ).pipe(Effect.forkScoped)
      yield* Effect.addFinalizer(() => Fiber.interrupt(building))
      yield* Deferred.await(entered)
      expect(yield* Deferred.isDone(release)).toBe(false)
      yield* adjust(Duration.millis(1_000.123456))
      yield* Deferred.succeed(release, undefined)

      const services = yield* Fiber.join(building)
      expect(Context.get(services, ReadyService).value).toBe("ready")
      expect(yield* Ref.get(finalizers)).toBe(0)

      const phases = phaseLogs(yield* logLines)
      expect(phases).toHaveLength(2)
      expect(phases.map((log) => log.phase).sort()).toEqual(["app-service-graph", "httpapi-route-layer"])
      expect(phases).toContainEqual(
        expect.objectContaining({
          phase: "app-service-graph",
          startedAt: expect.any(Number),
          finishedAt: expect.any(Number),
          durationMs: 1_000.123,
          outcome: "success",
        }),
      )
      expect(phases).toContainEqual(
        expect.objectContaining({
          phase: "httpapi-route-layer",
          startedAt: expect.any(Number),
          finishedAt: expect.any(Number),
          durationMs: 1_000.123,
          outcome: "success",
        }),
      )
      expect(phases.every((log) => Object.keys(log).sort().join(",") === "durationMs,finishedAt,outcome,phase,startedAt"))
        .toBe(true)
      expect(phases.every((log) => isRoundedToThreeDecimals(log.durationMs)))
        .toBe(true)

      yield* Scope.close(scope, Exit.void)
      expect(yield* Ref.get(finalizers)).toBe(1)
    }),
  )

  it.effect("records failure without replacing the original cause", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const originalCause = Cause.fail(new Error("private layer failure"))
      const layer = Layer.effect(ReadyService, Effect.failCause(originalCause))
      const reports: unknown[] = []
      const throwingLogger = Logger.make((options) => {
        reports.push(options.message)
        throw new Error("private reporter failure")
      })
      const measured = measureServerStartLayer("httpapi-route-layer", layer).pipe(
        Layer.provide(Logger.layer([throwingLogger], { mergeWithExisting: false })),
      )
      const exit = yield* Layer.buildWithScope(measured, scope).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause).toBe(originalCause)
      expect(phaseLogs(reports)).toContainEqual(
        expect.objectContaining({ phase: "httpapi-route-layer", outcome: "failure" }),
      )
      expect(JSON.stringify(reports)).not.toContain("private layer failure")
    }),
  )

  it.effect("reports through the configured logger and minimum log level", () =>
    Effect.gen(function* () {
      const observed: Array<{ currentLoggers: ReadonlySet<unknown>; minimumLogLevel: unknown }> = []
      const logger = Logger.make((options) =>
        observed.push({
          currentLoggers: options.fiber.getRef(Logger.CurrentLoggers),
          minimumLogLevel: options.fiber.getRef(References.MinimumLogLevel),
        }),
      )
      const loggingLayer = Layer.merge(
        Logger.layer([logger], { mergeWithExisting: false }),
        Layer.succeed(References.MinimumLogLevel, "Debug"),
      )
      const measured = measureServerStartLayer(
        "httpapi-route-layer",
        Layer.succeed(ReadyService)(ReadyService.of({ value: "ready" })),
      ).pipe(Layer.provide(loggingLayer))
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))

      yield* Layer.buildWithScope(measured, scope)

      expect(observed).toHaveLength(1)
      expect(observed[0]?.currentLoggers.has(logger)).toBe(true)
      expect(observed[0]?.minimumLogLevel).toBe("Debug")
    }),
  )

  it.effect("records interruption and retains the interrupted exit", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const layer = Layer.effect(
        ReadyService,
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined)
          return yield* Effect.never
        }),
      )
      const building = yield* Layer.buildWithScope(measureServerStartLayer("httpapi-route-layer", layer), scope).pipe(
        Effect.forkScoped,
      )
      yield* Effect.addFinalizer(() => Fiber.interrupt(building))
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(building)
      const exit = yield* Fiber.join(building).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(JSON.stringify(yield* logLines)).toContain('"outcome":"interrupted"')
    }),
  )

  it.live("measures first-request acquisition once across shared and fresh MemoMaps", () =>
    Effect.gen(function* () {
      const messages: unknown[] = []
      let acquisitions = 0
      let finalizers = 0
      const logger = Logger.make((options) => messages.push(options.message))
      const appLayer = Layer.effect(
        AppService,
        Effect.gen(function* () {
          acquisitions += 1
          yield* Effect.addFinalizer(() => Effect.sync(() => (finalizers += 1)))
          return AppService.of({ value: "ready" })
        }),
      )
      const routes = HttpRouter.add("GET", "/ready", HttpServerResponse.text("ready")).pipe(
        Layer.provide(measureServerStartLayer("app-service-graph", appLayer)),
        Layer.provide(Logger.layer([logger], { mergeWithExisting: false })),
      )
      const measuredRoutes = measureServerStartLayer("httpapi-route-layer", routes)
      const sharedMemoMap = Layer.makeMemoMapUnsafe()
      const first = HttpRouter.toWebHandler(measuredRoutes, {
        disableLogger: true,
        memoMap: sharedMemoMap,
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => first.dispose()))
      const second = HttpRouter.toWebHandler(measuredRoutes, {
        disableLogger: true,
        memoMap: sharedMemoMap,
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => second.dispose()))

      const firstResponse = yield* Effect.promise(() => first.handler(new Request("http://localhost/ready")))
      expect(firstResponse.status).toBe(200)
      expect(yield* Effect.promise(() => firstResponse.text())).toBe("ready")
      expect(acquisitions).toBe(1)
      expect(phaseLogs(messages).map((log) => log.phase)).toEqual(["app-service-graph"])

      const secondResponse = yield* Effect.promise(() => second.handler(new Request("http://localhost/ready")))
      expect(secondResponse.status).toBe(200)
      expect(yield* Effect.promise(() => secondResponse.text())).toBe("ready")
      expect(acquisitions).toBe(1)
      expect(phaseLogs(messages)).toHaveLength(1)

      const fresh = HttpRouter.toWebHandler(measuredRoutes, {
        disableLogger: true,
        memoMap: Layer.makeMemoMapUnsafe(),
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => fresh.dispose()))
      const freshResponse = yield* Effect.promise(() => fresh.handler(new Request("http://localhost/ready")))
      expect(freshResponse.status).toBe(200)
      expect(yield* Effect.promise(() => freshResponse.text())).toBe("ready")
      expect(acquisitions).toBe(2)
      expect(phaseLogs(messages)).toHaveLength(2)

      yield* Effect.promise(() => first.dispose())
      expect(finalizers).toBe(0)
      yield* Effect.promise(() => second.dispose())
      expect(finalizers).toBe(1)
      yield* Effect.promise(() => fresh.dispose())
      expect(finalizers).toBe(2)
    }),
  )

  it.live("captures real app-graph phase events through the configured logger", () =>
    Effect.gen(function* () {
      const previousLogLevel = process.env.OPENCODE_LOG_LEVEL
      process.env.OPENCODE_LOG_LEVEL = "INFO"
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousLogLevel === undefined) delete process.env.OPENCODE_LOG_LEVEL
          else process.env.OPENCODE_LOG_LEVEL = previousLogLevel
        }),
      )
      const logDirectory = yield* Effect.promise(() => mkdtemp(path.join(Global.Path.tmp, "server-start-diagnostics-")))
      const logFile = path.join(logDirectory, "opencode.log")
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(logDirectory, { recursive: true, force: true })))

      const observabilityLayer = Layer.merge(
        Observability.layer,
        Logger.layer([Logging.fileLogger(logFile)], { mergeWithExisting: false }),
      )

      const startedAt = Date.now()
      let acquisitions = 0
      const countedRoutes = Layer.effectContext(
        Effect.gen(function* () {
          acquisitions += 1
          return yield* Layer.build(HttpApiApp.createRoutes(undefined, observabilityLayer))
        }),
      )
      const measuredRoutes = measureServerStartLayer("httpapi-route-layer", countedRoutes).pipe(
        Layer.provide(observabilityLayer),
      )
      const sharedMemoMap = Layer.makeMemoMapUnsafe()
      const first = HttpRouter.toWebHandler(measuredRoutes, {
        disableLogger: true,
        memoMap: sharedMemoMap,
        middleware: disposeMiddleware,
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => first.dispose()))
      const second = HttpRouter.toWebHandler(measuredRoutes, {
        disableLogger: true,
        memoMap: sharedMemoMap,
        middleware: disposeMiddleware,
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => second.dispose()))
      const context = Context.empty() as Context.Context<unknown>
      const request = () => new Request("http://localhost/app/storage/status")
      expect(acquisitions).toBe(0)
      expect(yield* Effect.promise(() => Bun.file(logFile).exists())).toBe(false)
      const firstResponse = yield* Effect.promise(() => first.handler(request(), context))
      expect(firstResponse.status).toBe(200)
      expect(acquisitions).toBe(1)
      const secondResponse = yield* Effect.promise(() => second.handler(request(), context))
      expect(secondResponse.status).toBe(200)
      expect(acquisitions).toBe(1)
      yield* Effect.promise(() => first.dispose())
      yield* Effect.promise(() => second.dispose())
      const sharedContents = yield* Effect.promise(() => Bun.file(logFile).text())
      const sharedEvents = phaseLogfmt(sharedContents).filter((event) => event.startedAt >= startedAt)
      expect(sharedEvents.map((event) => event.phase).sort()).toEqual([
        "app-service-graph",
        "httpapi-route-layer",
      ])

      const fresh = HttpRouter.toWebHandler(measuredRoutes, {
        disableLogger: true,
        memoMap: Layer.makeMemoMapUnsafe(),
        middleware: disposeMiddleware,
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => fresh.dispose()))
      const freshResponse = yield* Effect.promise(() => fresh.handler(request(), context))
      expect(freshResponse.status).toBe(200)
      expect(acquisitions).toBe(2)
      yield* Effect.promise(() => fresh.dispose())

      const contents = yield* Effect.promise(() => Bun.file(logFile).text())
      const events = phaseLogfmt(contents).filter((event) => event.startedAt >= startedAt)
      expect(events).toHaveLength(4)
      expect(events.map((event) => event.phase).sort()).toEqual([
        "app-service-graph",
        "app-service-graph",
        "httpapi-route-layer",
        "httpapi-route-layer",
      ])
      expect(
        events.every(
          (event) =>
            event.keys.join(",") === "durationMs,finishedAt,outcome,phase,startedAt" &&
            Number.isInteger(event.startedAt) &&
            Number.isInteger(event.finishedAt) &&
            Number.isFinite(event.durationMs) &&
            event.durationMs >= 0 &&
            isRoundedToThreeDecimals(event.durationMs) &&
            event.outcome === "success",
        ),
      ).toBe(true)
    }),
  )
})
