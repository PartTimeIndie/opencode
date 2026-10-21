import { Duration, Effect, Exit, ScopedCache, Scope } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRef, WorkspaceRef } from "./instance-ref"
import { registerDisposer } from "./instance-registry"
import { WorkspaceContext } from "@/control-plane/workspace-context"

const TypeId = "~opencode/InstanceState"

export interface InstanceState<A, E = never, R = never> {
  readonly [TypeId]: typeof TypeId
  readonly cache: ScopedCache.ScopedCache<string, A, E, R>
}

export const context = Effect.gen(function* () {
  const ctx = yield* InstanceRef
  if (!ctx) return yield* Effect.die(new Error("InstanceRef not provided"))
  return ctx
})

export const workspaceID = Effect.gen(function* () {
  return (yield* WorkspaceRef) ?? WorkspaceContext.workspaceID
})

export const directory = Effect.map(context, (ctx) => ctx.directory)

export const make = <A, E = never, R = never>(
  init: (ctx: InstanceContext) => Effect.Effect<A, E, R | Scope.Scope>,
): Effect.Effect<InstanceState<A, E, Exclude<R, Scope.Scope>>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const cache = yield* ScopedCache.makeWith<string, A, E, R>({
      capacity: Number.POSITIVE_INFINITY,
      // A cancelled first reader must not leave an interrupted lookup cached
      // forever for every later request in the same directory.
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
      lookup: () =>
        Effect.gen(function* () {
          return yield* init(yield* context)
        }),
    })

    const off = registerDisposer((directory) => Effect.runPromise(ScopedCache.invalidate(cache, directory)))
    yield* Effect.addFinalizer(() => Effect.sync(off))

    return {
      [TypeId]: TypeId,
      cache,
    }
  })

// ScopedCache.make captures the Effect context at construction time and merges
// it into every lookup via `effect.updateContext`. InstanceState.make runs during
// app/layer init when InstanceRef is NOT in scope yet, so the captured context
// lacks InstanceRef and all subsequent lookup calls (which read `yield* context`)
// fail with `InstanceRef not provided` — even when the calling fiber has it.
// Eagerly resolve the context in the caller's fiber (where InstanceRef IS present)
// and propagate it into the cache operation so the lookup sees a valid ref.
export const get = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    const ctx = yield* context
    return yield* ScopedCache.get(self.cache, ctx.directory).pipe(
      Effect.tapError(() => ScopedCache.invalidate(self.cache, ctx.directory)),
      Effect.provideService(InstanceRef, ctx),
    )
  })

export const use = <A, E, R, B>(self: InstanceState<A, E, R>, select: (value: A) => B) =>
  Effect.map(get(self), select)

export const useEffect = <A, E, R, B, E2, R2>(
  self: InstanceState<A, E, R>,
  select: (value: A) => Effect.Effect<B, E2, R2>,
) => Effect.flatMap(get(self), select)

export const has = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    const ctx = yield* context
    return yield* ScopedCache.has(self.cache, ctx.directory).pipe(Effect.provideService(InstanceRef, ctx))
  })

export const invalidate = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    const ctx = yield* context
    return yield* ScopedCache.invalidate(self.cache, ctx.directory).pipe(Effect.provideService(InstanceRef, ctx))
  })

export * as InstanceState from "./instance-state"
