import { Cause, Deferred, Effect, Exit, Fiber, Latch, Schema, Scope, SynchronizedRef } from "effect"

export interface Runner<A, E = never> {
  readonly state: State<A, E>
  readonly busy: boolean
  readonly ensureRunning: (work: Effect.Effect<A, E>) => Effect.Effect<A, E>
  readonly startShell: (work: Effect.Effect<A, E>, ready?: Latch.Latch) => Effect.Effect<A, E | Busy>
  readonly cancel: Effect.Effect<void>
}

export class Cancelled extends Schema.TaggedErrorClass<Cancelled>()("RunnerCancelled", {}) {}
export class Busy extends Schema.TaggedErrorClass<Busy>()("RunnerBusy", {}) {}

interface RunHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  work: Effect.Effect<A, E>
  fiber: Fiber.Fiber<A, E>
}

interface ShellHandle<A, E> {
  id: number
  cancelled: Deferred.Deferred<void>
  ready?: Latch.Latch
  fiber: Fiber.Fiber<A, E>
}

interface PendingHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  work: Effect.Effect<A, E>
}

export type State<A, E> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Running"; readonly run: RunHandle<A, E> }
  | { readonly _tag: "RunningThenRun"; readonly run: RunHandle<A, E>; readonly next: PendingHandle<A, E> }
  | { readonly _tag: "Shell"; readonly shell: ShellHandle<A, E> }
  | { readonly _tag: "ShellThenRun"; readonly shell: ShellHandle<A, E>; readonly run: PendingHandle<A, E> }

export const make = <A, E = never>(
  scope: Scope.Scope,
  opts?: {
    onIdle?: Effect.Effect<void>
    onBusy?: Effect.Effect<void>
    onInterrupt?: Effect.Effect<A, E>
  },
): Runner<A, E> => {
  const ref = SynchronizedRef.makeUnsafe<State<A, E>>({ _tag: "Idle" })
  const idle = opts?.onIdle ?? Effect.void
  const onBusy = opts?.onBusy ?? Effect.void
  const onInterrupt = opts?.onInterrupt
  let ids = 0
  let accepting = true

  const state = () => SynchronizedRef.getUnsafe(ref)
  const next = () => {
    ids += 1
    return ids
  }

  const complete = (done: Deferred.Deferred<A, E | Cancelled>, exit: Exit.Exit<A, E>) =>
    Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
      ? Deferred.fail(done, new Cancelled()).pipe(Effect.asVoid)
      : Deferred.done(done, exit).pipe(Effect.asVoid)

  const awaitDone = (done: Deferred.Deferred<A, E | Cancelled>) =>
    Deferred.await(done).pipe(Effect.catchTag("RunnerCancelled", (e) => onInterrupt ?? Effect.die(e)))

  const awaitCancelled = () => onInterrupt ?? Effect.die(new Cancelled())
  const becomeIdle = Effect.uninterruptible(Effect.gen(function* () {
    yield* idle
    accepting = true
  }))
  const forceIdle = Effect.uninterruptible(Effect.gen(function* () {
    if (accepting) return
    yield* SynchronizedRef.set(ref, { _tag: "Idle" })
    yield* becomeIdle
  }))

  const finishRun = (
    id: number,
    done: Deferred.Deferred<A, E | Cancelled>,
    exit: Exit.Exit<A, E>,
  ): Effect.Effect<void> =>
    SynchronizedRef.modifyEffect(ref, (st): Effect.Effect<readonly [Effect.Effect<void>, State<A, E>]> => {
      if (st._tag === "Running" && st.run.id === id) {
        return Effect.succeed([
          Effect.gen(function* () {
            yield* becomeIdle
            yield* complete(done, exit)
          }),
          { _tag: "Idle" } as const,
        ] as const)
      }
      if (st._tag === "RunningThenRun" && st.run.id === id) {
        if (Exit.isSuccess(exit)) {
          return startRun(st.next.work, st.next.done).pipe(
            Effect.map((run) => [complete(done, exit), { _tag: "Running", run }] as const),
          )
        }
        return Effect.succeed([
          Effect.gen(function* () {
            yield* becomeIdle
            yield* complete(done, exit)
            yield* complete(st.next.done, exit)
          }),
          { _tag: "Idle" } as const,
        ] as const)
      }
      return Effect.succeed([complete(done, exit), st] as const)
    }).pipe(Effect.flatten)

  const startRun = (
    work: Effect.Effect<A, E>,
    done: Deferred.Deferred<A, E | Cancelled>,
  ): Effect.Effect<RunHandle<A, E>> =>
    Effect.gen(function* () {
      const id = next()
      const fiber = yield* work.pipe(
        Effect.onExit((exit) => finishRun(id, done, exit)),
        Effect.forkIn(scope),
      )
      return { id, done, work, fiber } satisfies RunHandle<A, E>
    })

  const finishShell = (id: number) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag === "Shell" && st.shell.id === id) {
          return [becomeIdle, { _tag: "Idle" }] as const
        }
        if (st._tag === "ShellThenRun" && st.shell.id === id) {
          const run = yield* startRun(st.run.work, st.run.done)
          return [Effect.void, { _tag: "Running", run }] as const
        }
        return [Effect.void, st] as const
      }),
    ).pipe(Effect.flatten)

  const stopShell = (shell: ShellHandle<A, E>) =>
    Effect.gen(function* () {
      if (shell.ready) yield* shell.ready.await.pipe(Effect.exit, Effect.asVoid)
      yield* Deferred.succeed(shell.cancelled, undefined).pipe(Effect.asVoid)
      yield* Fiber.interrupt(shell.fiber)
    })

  const ensureRunning = (work: Effect.Effect<A, E>) =>
    accepting
      ? SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        switch (st._tag) {
          case "ShellThenRun":
            return [awaitDone(st.run.done), st] as const
          case "RunningThenRun":
            return [awaitDone(st.next.done), st] as const
          case "Running": {
            if (st.run.work === work) return [awaitDone(st.run.done), st] as const
            const pending = {
              id: next(),
              done: yield* Deferred.make<A, E | Cancelled>(),
              work,
            } satisfies PendingHandle<A, E>
            return [awaitDone(pending.done), { _tag: "RunningThenRun", run: st.run, next: pending }] as const
          }
          case "Shell": {
            const run = {
              id: next(),
              done: yield* Deferred.make<A, E | Cancelled>(),
              work,
            } satisfies PendingHandle<A, E>
            return [awaitDone(run.done), { _tag: "ShellThenRun", shell: st.shell, run }] as const
          }
          case "Idle": {
            const done = yield* Deferred.make<A, E | Cancelled>()
            const run = yield* startRun(work, done)
            return [awaitDone(done), { _tag: "Running", run }] as const
          }
        }
      }),
    ).pipe(Effect.flatten)
      : awaitCancelled()

  const startShell = (work: Effect.Effect<A, E>, ready?: Latch.Latch): Effect.Effect<A, E | Busy> =>
    accepting
      ? SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag !== "Idle") {
          const reject: Effect.Effect<A, E | Busy> = Effect.fail(new Busy())
          return [reject, st] as const
        }
        yield* onBusy
        const id = next()
        const cancelled = yield* Deferred.make<void>()
        const fiber = yield* work.pipe(Effect.ensuring(finishShell(id)), Effect.forkChild)
        const shell = { id, cancelled, ready, fiber } satisfies ShellHandle<A, E>
        return [
          Effect.gen(function* () {
            const exit = yield* Fiber.await(fiber)
            if (Exit.isSuccess(exit)) return exit.value
            if (
              Cause.hasInterruptsOnly(exit.cause) ||
              ((yield* Deferred.isDone(cancelled)) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause))
            ) {
              if (onInterrupt) return yield* onInterrupt
              return yield* Effect.die(new Cancelled())
            }
            return yield* Effect.failCause(exit.cause)
          }),
          { _tag: "Shell", shell },
        ] as const
      }),
    ).pipe(Effect.flatten)
      : awaitCancelled()

  const cancel = SynchronizedRef.modify(ref, (st) => {
    accepting = false
    switch (st._tag) {
      case "Idle":
        return [forceIdle, st] as const
      case "Running":
        return [
          Effect.gen(function* () {
            yield* Fiber.interrupt(st.run.fiber)
            yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
            yield* forceIdle
          }),
          st,
        ] as const
      case "RunningThenRun":
        return [
          Effect.gen(function* () {
            yield* Deferred.fail(st.next.done, new Cancelled()).pipe(Effect.asVoid)
            yield* Fiber.interrupt(st.run.fiber)
            yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
            yield* forceIdle
          }),
          { _tag: "Running", run: st.run } as const,
        ] as const
      case "Shell":
        return [
          Effect.gen(function* () {
            yield* stopShell(st.shell)
            yield* forceIdle
          }),
          st,
        ] as const
      case "ShellThenRun":
        return [
          Effect.gen(function* () {
            yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
            yield* stopShell(st.shell)
            yield* forceIdle
          }),
          { _tag: "Shell", shell: st.shell } as const,
        ] as const
    }
  }).pipe(Effect.flatten)

  return {
    get state() {
      return state()
    },
    get busy() {
      return !accepting || state()._tag !== "Idle"
    },
    ensureRunning,
    startShell,
    cancel,
  }
}

export * as Runner from "./runner"
