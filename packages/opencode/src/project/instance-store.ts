import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GlobalBus } from "@/bus/global"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { InstanceRef } from "@/effect/instance-ref"
import { disposeInstance as runDisposers, type DisposeReason } from "@/effect/instance-registry"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ConfigMaintenance } from "@opencode-ai/core/config/maintenance"
import { Cause, Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import { HttpServerRespondable, HttpServerResponse } from "effect/unstable/http"
import path from "node:path"
import { type InstanceContext } from "./instance-context"
import { InstanceBootstrap } from "./bootstrap-service"
import { InstanceBootstrap as InstanceBootstrapGraph } from "./bootstrap"
import * as Project from "./project"

export interface LoadInput {
  directory: string
  worktree?: string
  project?: Project.Info
}

/**
 * A directory-scoped answer for "this project's instance is not usable right now".
 * Encodes itself as a JSON 503 with Retry-After so clients never observe the
 * historical empty-body 503 (see docs/workitems/2026-09-25-empty-503-trace.md).
 */
export class InstanceUnavailableError extends Schema.TaggedErrorClass<InstanceUnavailableError>()(
  "InstanceUnavailableError",
  {
    directory: Schema.String,
    reason: Schema.String,
    retryAfterMs: Schema.Number,
  },
  { httpApiStatus: 503 },
) {
  static isInstance(input: unknown): input is InstanceUnavailableError {
    return input instanceof InstanceUnavailableError
  }

  [HttpServerRespondable.symbol]() {
    return Effect.succeed(InstanceUnavailableError.response(this))
  }

  /**
   * The JSON 503 contract: instance routing answers with a structured body and
   * Retry-After so clients can surface a cause instead of an empty failure.
   */
  static response(error: InstanceUnavailableError) {
    return HttpServerResponse.jsonUnsafe(
      {
        error: "instance_unavailable",
        directory: error.directory,
        reason: error.reason,
        retryAfterMs: error.retryAfterMs,
      },
      {
        status: 503,
        headers: { "retry-after": String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))) },
      },
    )
  }
}
export interface Interface {
  readonly load: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly reload: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly dispose: (ctx: InstanceContext) => Effect.Effect<void>
  readonly disposeDirectory: (directory: string) => Effect.Effect<void>
  readonly disposeAll: () => Effect.Effect<void>
  readonly disposeAllFresh: () => Effect.Effect<void>
  readonly provide: <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceStore") {}

export const use = serviceUse(Service)

export function instanceDisposeTimeoutMs(env: Readonly<Record<string, string | undefined>> = process.env) {
  const value = Number(env.OPENCODE_INSTANCE_DISPOSE_TIMEOUT_MS)
  return Number.isInteger(value) && value > 0 ? value : 5000
}

const HOUR_MS = 60 * 60 * 1000
const DEFAULT_BOOTSTRAP_CIRCUIT_COOLDOWN_MS = 30_000

export function instanceBootstrapTimeoutMs(env: Readonly<Record<string, string | undefined>> = process.env) {
  const value = Number(env.OPENCODE_SETTLEMENT_BOOTSTRAP_TIMEOUT_MS)
  return Number.isInteger(value) && value > 0 ? value : ConfigMaintenance.runtime().watchdog.bootstrapTimeoutMs
}

export function instanceBootstrapMaxFailuresPerHour(env: Readonly<Record<string, string | undefined>> = process.env) {
  const value = Number(env.OPENCODE_SETTLEMENT_MAX_INSTANCE_RELOADS_PER_HOUR)
  return Number.isInteger(value) && value > 0 ? value : ConfigMaintenance.runtime().watchdog.maxInstanceReloadsPerHour
}

export function instanceBootstrapCircuitCooldownMs(env: Readonly<Record<string, string | undefined>> = process.env) {
  const value = Number(env.OPENCODE_SETTLEMENT_CIRCUIT_COOLDOWN_MS)
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_BOOTSTRAP_CIRCUIT_COOLDOWN_MS
}

interface Entry {
  readonly directory: string
  readonly deferred: Deferred.Deferred<InstanceContext>
  fiber?: Fiber.Fiber<void>
  disposal?: Deferred.Deferred<void>
}

export const layer: Layer.Layer<Service, never, Project.Service | InstanceBootstrap.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const project = yield* Project.Service
    const bootstrap = yield* InstanceBootstrap.Service
    const scope = yield* Scope.Scope
    const cache = new Map<string, Entry>()
    const resolving = new Map<string, Promise<string>>()
    const cacheKey = (directory: string) => {
      const resolved = path.resolve(FSUtil.windowsPath(directory))
      return process.platform === "win32" ? resolved.replaceAll("/", "\\").toLowerCase() : resolved
    }

    const boot = (input: LoadInput & { directory: string }) =>
      Effect.gen(function* () {
        const ctx: InstanceContext =
          input.project && input.worktree
            ? {
                directory: input.directory,
                worktree: input.worktree,
                project: input.project,
              }
            : yield* project.fromDirectory(input.directory).pipe(
                Effect.map((result) => ({
                  directory: input.directory,
                  worktree: result.sandbox,
                  project: result.project,
                })),
              )
        yield* bootstrap.run.pipe(Effect.provideService(InstanceRef, ctx))
        return ctx
      }).pipe(Effect.withSpan("InstanceStore.boot"))

    const removeEntry = (directory: string, entry: Entry) =>
      Effect.sync(() => {
        if (cache.get(directory) !== entry) return false
        cache.delete(directory)
        return true
      })

    // Read the mutable disposal flag through a function boundary: an earlier
    // `if (entry.disposal) return` statically narrows the property to
    // `undefined`, and that stale narrowing survives yields, so a later
    // re-check must re-read it through the accessor's declared union type.
    const entryDisposal = (entry: Entry) => entry.disposal

    // Bootstrap deadline + circuit breaker. A wedged bootstrap used to hold
    // every directory-scoped request open forever; now the entry settles with a
    // typed InstanceUnavailableError after the deadline, and repeated bootstrap
    // failures fail fast until the circuit window clears.
    const bootstrapTimeoutMs = () => instanceBootstrapTimeoutMs()
    const pathResolveTimeoutMs = () => {
      const value = Number(process.env.OPENCODE_INSTANCE_PATH_RESOLVE_TIMEOUT_MS)
      return Number.isInteger(value) && value > 0 ? value : 5000
    }
    const resolveDirectory = (directory: string) => {
      const key = cacheKey(directory)
      const pending = resolving.get(key) ?? FSUtil.resolveAsync(directory)
      if (!resolving.has(key)) {
        resolving.set(key, pending)
        void pending.then(
          () => { if (resolving.get(key) === pending) resolving.delete(key) },
          () => { if (resolving.get(key) === pending) resolving.delete(key) },
        )
      }
      return Effect.tryPromise({
        try: () => pending,
        catch: () => new InstanceUnavailableError({
          directory,
          reason: "project directory resolution failed",
          retryAfterMs: pathResolveTimeoutMs(),
        }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(pathResolveTimeoutMs()),
          orElse: () => Effect.fail(new InstanceUnavailableError({
            directory,
            reason: "project directory resolution timed out",
            retryAfterMs: pathResolveTimeoutMs(),
          })),
        }),
      ) as Effect.Effect<string>
    }
    const maxBootstrapFailuresPerHour = () => instanceBootstrapMaxFailuresPerHour()
    const bootstrapCircuitCooldownMs = () => instanceBootstrapCircuitCooldownMs()
    const bootstrapFailures = new Map<string, number[]>()
    const bootstrapCircuits = new Map<string, number>()

    const circuitOpenUntil = (directory: string, now: number) => {
      const openUntil = bootstrapCircuits.get(directory)
      if (openUntil === undefined) return undefined
      if (now < openUntil) return openUntil
      bootstrapCircuits.delete(directory)
      bootstrapFailures.delete(directory)
    }

    const recordBootstrapFailure = (directory: string, now: number) => {
      const failures = (bootstrapFailures.get(directory) ?? []).filter((ts) => now - ts < HOUR_MS)
      failures.push(now)
      bootstrapFailures.set(directory, failures)
      if (failures.length < maxBootstrapFailuresPerHour()) return
      const openUntil = now + bootstrapCircuitCooldownMs()
      bootstrapCircuits.set(directory, openUntil)
      return openUntil
    }

    const armBootstrapDeadline = (directory: string, entry: Entry) =>
      Effect.gen(function* () {
        yield* Effect.sleep(`${bootstrapTimeoutMs()} millis`)
        if (Deferred.isDoneUnsafe(entry.deferred)) return
        const now = Date.now()
        // Record the failure before releasing waiters so an immediate retry
        // sees the bounded circuit cooldown instead of starting another boot.
        const openUntil = recordBootstrapFailure(directory, now)
        const retryAfterMs = openUntil === undefined ? bootstrapTimeoutMs() : Math.max(openUntil - now, 1)
        yield* Effect.logWarning("instance bootstrap deadline exceeded", {
          directory,
          timeoutMs: bootstrapTimeoutMs(),
          retryAfterMs,
        })
        const disposal = Deferred.makeUnsafe<void>()
        entry.disposal = disposal
        const completed = Deferred.doneUnsafe(
          entry.deferred,
          Effect.fail(
            new InstanceUnavailableError({
              directory,
              reason: `instance bootstrap did not settle within ${bootstrapTimeoutMs()}ms`,
              retryAfterMs,
            }),
          ) as unknown as Effect.Effect<InstanceContext>,
        )
        if (!completed) {
          entry.disposal = undefined
          Deferred.doneUnsafe(disposal, Effect.void)
          return
        }
        // Interrupting the boot does not invalidate InstanceState's separately
        // scoped caches. An expired lookup can otherwise publish a replacement
        // deferred and then wedge while closing its old scope, poisoning every
        // retry. Keep this generation pinned until invalidation has started.
        yield* Effect.gen(function* () {
          if (entry.fiber) yield* Fiber.interrupt(entry.fiber).pipe(Effect.forkDetach)
          yield* disposeState(entry.directory, "reload")
        }).pipe(Effect.ensuring(
          removeEntry(directory, entry).pipe(
            Effect.andThen(Effect.sync(() => Deferred.doneUnsafe(disposal, Effect.void))),
          ),
        ))
      }).pipe(Effect.forkIn(scope, { startImmediately: true }))
    const completeLoad = (cacheKey: string, input: LoadInput, entry: Entry) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(boot(input))
        // The watchdog/reload already owns this generation. A late exit must
        // neither remove its cleanup barrier nor reset a newer boot's circuit.
        if (Deferred.isDoneUnsafe(entry.deferred)) return
        if (Exit.isFailure(exit)) {
          yield* Effect.logError("instance bootstrap failed", {
            directory: input.directory,
            cause: Cause.pretty(exit.cause),
          })
          yield* removeEntry(cacheKey, entry)
          // Deliberate disposal/reload interrupts settle the deferred through
          // interruptPending and abort this fiber, so an interrupt-only cause
          // here is bookkeeping noise. Any other failure counts toward the
          // circuit breaker and hands waiters the typed 503 contract instead
          // of the raw bootstrap defect.
          const interrupted = exit.cause.reasons.every((reason) => Cause.isInterruptReason(reason))
          if (interrupted) {
            // Waiters must receive the typed 503 contract here. Settling the
            // deferred with the raw interrupt exit rendered as an empty-body
            // 503 client-side (observed on cold start 2026-10-03T13:56:28Z,
            // PhotoBrowser: InterruptError escaping Config.waitForDependencies
            // via Fiber.join). Deliberate disposal/reload interrupts never
            // reach this branch: interruptPending settles the deferred first
            // and the isDoneUnsafe guard above returns early.
            yield* Deferred.done(
              entry.deferred,
              Exit.fail(
                new InstanceUnavailableError({
                  directory: input.directory,
                  reason: `instance bootstrap was interrupted: ${Cause.pretty(exit.cause).split("\n")[0]}`,
                  retryAfterMs: bootstrapTimeoutMs(),
                }),
              ) as unknown as Exit.Exit<InstanceContext>,
            ).pipe(Effect.asVoid)
            return
          }
          const now = Date.now()
          const openUntil = recordBootstrapFailure(cacheKey, now)
          const retryAfterMs = openUntil === undefined ? bootstrapTimeoutMs() : Math.max(openUntil - now, 1)
          yield* Deferred.done(
            entry.deferred,
            Exit.fail(
              new InstanceUnavailableError({
                directory: input.directory,
                reason: `instance bootstrap failed: ${Cause.pretty(exit.cause).split("\n")[0]}`,
                retryAfterMs,
              }),
            ) as unknown as Exit.Exit<InstanceContext>,
          ).pipe(Effect.asVoid)
        } else {
          bootstrapFailures.delete(cacheKey)
          bootstrapCircuits.delete(cacheKey)
          yield* Deferred.done(entry.deferred, exit).pipe(Effect.asVoid)
        }
      })

    const interruptPending = (entry: Entry) =>
      Effect.gen(function* () {
        // Settle waiters with the typed 503 contract instead of a raw
        // interrupt: Deferred.interrupt alone renders as an empty-body 503
        // client-side. doneUnsafe is a no-op when the deferred already
        // settled (watchdog/reload owns the generation), so this never
        // overwrites a newer boot or revives an aborted one.
        Deferred.doneUnsafe(
          entry.deferred,
          Effect.fail(
            new InstanceUnavailableError({
              directory: entry.directory,
              reason: "instance bootstrap was interrupted by reload or dispose",
              retryAfterMs: bootstrapTimeoutMs(),
            }),
          ) as unknown as Effect.Effect<InstanceContext>,
        )
        // doneUnsafe already resumes waiters with the typed failure; the
        // deferred is settled here, so a Deferred.interrupt would be a no-op.
        // The boot fiber is still interrupted unconditionally below so an
        // aborted generation cannot keep running past its removal.
        if (entry.fiber) yield* Fiber.interrupt(entry.fiber).pipe(Effect.forkDetach, Effect.ignore)
      })

    const emitDisposed = (input: { directory: string; project?: string }) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: input.directory,
          project: input.project,
          workspace: WorkspaceContext.workspaceID,
          payload: {
            type: "server.instance.disposed",
            properties: {
              directory: input.directory,
            },
          },
        }),
      )

    const disposeState = Effect.fn("InstanceStore.disposeState")(function* (
      directory: string,
      reason: DisposeReason,
    ) {
      // A hung instance disposer must not keep a disposed context cached forever;
      // directory-scoped requests would then wait on resources that no longer exist.
      const timedOut = yield* Effect.promise(() => runDisposers(directory, reason)).pipe(
        Effect.as(false),
        Effect.timeoutOrElse({
          duration: Duration.millis(instanceDisposeTimeoutMs()),
          orElse: () => Effect.succeed(true),
        }),
        Effect.catchDefect(() => Effect.succeed(false)),
      )
      if (timedOut)
        yield* Effect.logWarning("instance disposers timed out", {
          directory,
          reason,
          timeoutMs: instanceDisposeTimeoutMs(),
        })
    })

    const disposeContext = Effect.fn("InstanceStore.disposeContext")(function* (
      ctx: InstanceContext,
      reason: DisposeReason = "dispose",
    ) {
      yield* Effect.logInfo("disposing instance", { directory: ctx.directory })
      yield* disposeState(ctx.directory, reason)
      yield* emitDisposed({ directory: ctx.directory, project: ctx.project.id })
    })

    const disposeEntry = Effect.fnUntraced(function* (
      directory: string,
      entry: Entry,
      ctx: InstanceContext,
      reason: DisposeReason = "dispose",
    ) {
      if (cache.get(directory) !== entry) return false
      // Single-flight: an in-flight disposal owns the context. Later callers
      // (overlapping reload, directory dispose, or a global sweep) wait for it
      // instead of running the disposers and disposed event a second time.
      if (entry.disposal) return yield* Deferred.await(entry.disposal).pipe(Effect.as(false))
      const disposal = Deferred.makeUnsafe<void>()
      entry.disposal = disposal
      yield* disposeContext(ctx, reason).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.logWarning("instance dispose failed", { directory, cause: Cause.pretty(exit.cause) }),
        ),
        Effect.ensuring(Effect.sync(() => Deferred.doneUnsafe(disposal, Effect.void))),
      )
      if (cache.get(directory) !== entry) return false
      cache.delete(directory)
      return true
    })

    const load = (input: LoadInput): Effect.Effect<InstanceContext> => Effect.gen(function* () {
      const resolved = cache.get(cacheKey(input.directory))?.directory ?? (yield* resolveDirectory(input.directory))
      const directory = cacheKey(resolved)
      const circuitDeferred = Deferred.makeUnsafe<InstanceContext>()
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const now = Date.now()
          const openUntil = circuitOpenUntil(directory, now)
          if (openUntil !== undefined) {
            yield* Effect.logWarning("instance bootstrap circuit open", {
              directory,
              retryAfterMs: openUntil - now,
            })
            Deferred.doneUnsafe(
              circuitDeferred,
              Effect.fail(
                new InstanceUnavailableError({
                  directory,
                  reason: "instance bootstrap failed repeatedly; retry after the circuit window clears",
                  retryAfterMs: Math.max(openUntil - now, 1),
                }),
              ) as unknown as Effect.Effect<InstanceContext>,
            )
            return yield* restore(Deferred.await(circuitDeferred))
          }
          while (true) {
            const existing = cache.get(directory)
            if (!existing) break
            if (!existing.disposal) return yield* restore(Deferred.await(existing.deferred))
            yield* restore(Deferred.await(existing.disposal))
          }

          const entry: Entry = { directory: resolved, deferred: Deferred.makeUnsafe<InstanceContext>() }
          cache.set(directory, entry)
          yield* armBootstrapDeadline(directory, entry)
          entry.fiber = yield* Effect.gen(function* () {
            yield* Effect.logInfo("creating instance", { directory: directory })
            yield* completeLoad(directory, { ...input, directory: resolved }, entry)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          return yield* restore(Deferred.await(entry.deferred))
        }),
      ).pipe(Effect.withSpan("InstanceStore.load"))
    })

    const reload = (input: LoadInput): Effect.Effect<InstanceContext> => Effect.gen(function* () {
      const resolved = cache.get(cacheKey(input.directory))?.directory ?? (yield* resolveDirectory(input.directory))
      const directory = cacheKey(resolved)
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // An explicit reload is a deliberate recovery probe after bootstrap
          // timeouts, so it bypasses and clears any open circuit for this path.
          bootstrapFailures.delete(directory)
          bootstrapCircuits.delete(directory)
          const retiring = cache.get(directory)?.disposal
          if (retiring) yield* Deferred.await(retiring)
          const previous = cache.get(directory)
          const pending = previous ? !(yield* Deferred.isDone(previous.deferred)) : false
          if (previous && pending) {
            // A concurrent retirement may have claimed the entry between the
            // checks above; its barrier owns the cleanup.
            const claimed = entryDisposal(previous)
            if (claimed) yield* Deferred.await(claimed)
            else {
              // The retirement owns the retiring entry: concurrent reloads and
              // dispose paths wait on this barrier instead of racing a fresh
              // boot against the dying generation's state cache.
              const disposal = Deferred.makeUnsafe<void>()
              previous.disposal = disposal
              yield* Effect.gen(function* () {
                // Retire the aborted generation's state-cache entries before
                // the replacement boot reads them. A still-cached dying lookup
                // would be joined by the new boot (inheriting the interrupt —
                // the observed follow-up 503) or park the next reader behind
                // the old entry-scope teardown. Deadline cleanup already runs
                // disposeState for the same reason; bounded by the dispose
                // timeout.
                yield* interruptPending(previous)
                yield* disposeState(previous.directory, "reload")
              }).pipe(Effect.ensuring(Effect.sync(() => Deferred.doneUnsafe(disposal, Effect.void))))
            }
          }
          const entry: Entry = { directory: resolved, deferred: Deferred.makeUnsafe<InstanceContext>() }
          cache.set(directory, entry)
          yield* armBootstrapDeadline(directory, entry)
          entry.fiber = yield* Effect.gen(function* () {
            yield* Effect.logInfo("reloading instance", { directory: directory })
            if (previous && !pending) {
              const previousContext = yield* Deferred.await(previous.deferred).pipe(Effect.option)
              if (previousContext._tag === "Some") {
                yield* disposeContext(previousContext.value, "reload")
              }
            }
            yield* completeLoad(directory, { ...input, directory: resolved }, entry)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          return yield* restore(Deferred.await(entry.deferred))
        }),
      ).pipe(Effect.withSpan("InstanceStore.reload"))
    })

    const dispose = Effect.fn("InstanceStore.dispose")(function* (ctx: InstanceContext) {
      const directory = cacheKey(ctx.directory)
      const entry = cache.get(directory)
      if (!entry) return yield* disposeContext(ctx)
      if (entry.disposal) return yield* Deferred.await(entry.disposal)
      if (!(yield* Deferred.isDone(entry.deferred))) return

      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) return yield* removeEntry(directory, entry).pipe(Effect.asVoid)
      if (exit.value !== ctx) return
      yield* disposeEntry(directory, entry, ctx).pipe(Effect.asVoid)
    })

    const disposeDirectory = Effect.fn("InstanceStore.disposeDirectory")(function* (input: string) {
      const directory = cache.has(cacheKey(input)) ? cacheKey(input) : cacheKey(yield* resolveDirectory(input))
      const entry = cache.get(directory)
      if (!entry) return
      if (entry.disposal) return yield* Deferred.await(entry.disposal)
      if (!(yield* Deferred.isDone(entry.deferred))) {
        // A concurrent retirement may have claimed the entry between the
        // checks above; its barrier owns the cleanup.
        const claimed = entryDisposal(entry)
        if (claimed) return yield* Deferred.await(claimed)
        // Retire the old generation's state BEFORE removing the entry so no
        // fresh load can boot against the dying generation's state cache; the
        // disposal barrier makes concurrent loads and reloads wait for that.
        const disposal = Deferred.makeUnsafe<void>()
        entry.disposal = disposal
        yield* Effect.gen(function* () {
          yield* interruptPending(entry)
          yield* disposeState(entry.directory, "dispose")
          yield* removeEntry(directory, entry)
        }).pipe(Effect.ensuring(Effect.sync(() => Deferred.doneUnsafe(disposal, Effect.void))))
        return
      }
      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) return yield* removeEntry(directory, entry).pipe(Effect.asVoid)
      yield* disposeEntry(directory, entry, exit.value).pipe(Effect.asVoid)
    })

    const disposeAllOnce = Effect.fnUntraced(function* () {
      yield* Effect.logInfo("disposing all instances")
      // Instances are independent, so dispose them concurrently: one wedged
      // disposer costs its own timeout instead of stalling every other
      // instance behind it.
      yield* Effect.forEach(
        [...cache.entries()],
        (item) =>
          Effect.gen(function* () {
            if (item[1].disposal) return yield* Deferred.await(item[1].disposal)
            if (!(yield* Deferred.isDone(item[1].deferred))) {
              // A concurrent retirement may have claimed the entry between
              // the checks above; its barrier owns the cleanup.
              const claimed = entryDisposal(item[1])
              if (claimed) return yield* Deferred.await(claimed)
              const disposal = Deferred.makeUnsafe<void>()
              item[1].disposal = disposal
              yield* Effect.gen(function* () {
                yield* interruptPending(item[1])
                yield* disposeState(item[1].directory, "all")
                yield* removeEntry(item[0], item[1])
              }).pipe(Effect.ensuring(Effect.sync(() => Deferred.doneUnsafe(disposal, Effect.void))))
              return
            }
            const exit = yield* Deferred.await(item[1].deferred).pipe(Effect.exit)
            if (Exit.isFailure(exit)) {
              yield* Effect.logWarning("instance dispose failed", { key: item[0], cause: exit.cause })
              yield* removeEntry(item[0], item[1])
              return
            }
            yield* disposeEntry(item[0], item[1], exit.value, "all")
          }),
        { discard: true, concurrency: "unbounded" },
      )
    })

    const cachedDisposeAll = yield* Effect.cachedWithTTL(disposeAllOnce(), Duration.zero)
    const disposeAll = Effect.fn("InstanceStore.disposeAll")(function* () {
      return yield* cachedDisposeAll
    })

    // A fresh sweep never shares an in-flight run, so it always includes
    // instances that were loaded after an earlier sweep took its snapshot.
    // Config reloads need that guarantee; shutdown paths prefer the coalescing
    // disposeAll.
    const disposeAllFresh = Effect.fn("InstanceStore.disposeAllFresh")(function* () {
      return yield* disposeAllOnce()
    })

    const provide = <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      load(input).pipe(Effect.flatMap((ctx) => effect.pipe(Effect.provideService(InstanceRef, ctx))))

    yield* Effect.addFinalizer(() => disposeAll().pipe(Effect.ignore))

    return Service.of({
      load,
      reload,
      dispose,
      disposeDirectory,
      disposeAll,
      disposeAllFresh,
      provide,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Project.defaultLayer))

export const node = LayerNode.make(layer, [Project.node, InstanceBootstrapGraph.node])

export * as InstanceStore from "./instance-store"
