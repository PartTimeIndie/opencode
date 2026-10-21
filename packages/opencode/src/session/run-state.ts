import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { registerDisposer } from "@/effect/instance-registry"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Effect, Exit, Latch, Layer, Scope, Context, SynchronizedRef } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { TurnCompletion } from "./turn-completion"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<SessionV1.WithParts>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

type State = {
  readonly runners: SynchronizedRef.SynchronizedRef<Map<SessionID, Runner.Runner<SessionV1.WithParts>>>
  readonly scope: Scope.Scope
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service
    const states = yield* SynchronizedRef.make(new Map<string, Effect.Effect<State>>())

    const state = Effect.fn("SessionRunState.state")(function* () {
      const ctx = yield* InstanceState.context
      const cached = yield* SynchronizedRef.modifyEffect(
        states,
        Effect.fnUntraced(function* (items) {
          const existing = items.get(ctx.directory)
          if (existing) return [existing, items] as const
          const next = yield* Effect.cached(
            Effect.gen(function* () {
              return {
                runners: yield* SynchronizedRef.make(new Map<SessionID, Runner.Runner<SessionV1.WithParts>>()),
                scope: yield* Scope.make(),
              }
            }),
          )
          return [next, new Map(items).set(ctx.directory, next)] as const
        }),
      )
      return yield* cached
    })

    const disposeState = Effect.fn("SessionRunState.disposeState")(function* (directory: string) {
      const cached = yield* SynchronizedRef.modify(states, (items) => {
        const existing = items.get(directory)
        if (!existing) return [undefined, items] as const
        const next = new Map(items)
        next.delete(directory)
        return [existing, next] as const
      })
      if (!cached) return
      const data = yield* cached
      const runners = yield* SynchronizedRef.get(data.runners)
      yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
        concurrency: "unbounded",
        discard: true,
      })
      yield* SynchronizedRef.set(data.runners, new Map())
      yield* Scope.close(data.scope, Exit.void)
    })

    const off = registerDisposer((directory, reason) => {
      if (reason === "all" || reason === "reload") return Promise.resolve()
      return Effect.runPromise(disposeState(directory))
    })
    yield* Effect.addFinalizer(() => Effect.sync(off))

    yield* Effect.addFinalizer(
      Effect.fnUntraced(function* () {
        yield* Effect.forEach([...(yield* SynchronizedRef.get(states)).keys()], disposeState, {
          concurrency: "unbounded",
          discard: true,
        })
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
    ) {
      const data = yield* state()
      // Runner callbacks fire later on this instance scope, outside the request
      // fiber, so the instance context must be captured now: status publishes
      // without it lose their routed location and never reach per-directory
      // consumers such as project plugins and the session UI.
      const instance = yield* InstanceRef
      const workspace = yield* WorkspaceRef
      const setStatus = (next: { type: "idle" } | { type: "busy" }) =>
        status.set(sessionID, next).pipe(
          Effect.provideService(InstanceRef, instance),
          Effect.provideService(WorkspaceRef, workspace),
        )
      return yield* SynchronizedRef.modifyEffect(
        data.runners,
        Effect.fnUntraced(function* (runners) {
          const existing = runners.get(sessionID)
          if (existing) return [existing, runners] as const
          const next = Runner.make<SessionV1.WithParts>(data.scope, {
            onIdle: Effect.gen(function* () {
              yield* SynchronizedRef.update(data.runners, (items) => {
                const updated = new Map(items)
                updated.delete(sessionID)
                return updated
              })
              // Turn completion verdicts are owned by TurnCompletionV2's durable claim/lease
              // path; evaluating here kept the session "busy" for up to 55 seconds whenever the
              // completion target was slow or broken. The status must flip to idle immediately,
              // so the legacy idle-time evaluation is intentionally gone.
              yield* setStatus({ type: "idle" })
            }),
            onBusy: setStatus({ type: "busy" }),
            onInterrupt,
          })
          return [next, new Map(runners).set(sessionID, next)] as const
        }),
      )
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* state()
      const existing = (yield* SynchronizedRef.get(data.runners)).get(sessionID)
      if (existing?.busy) yield* busyError(sessionID)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      yield* cancelBackgroundJobs(background, sessionID)
      const data = yield* state()
      const instance = yield* InstanceRef
      const workspace = yield* WorkspaceRef
      const existing = (yield* SynchronizedRef.get(data.runners)).get(sessionID)
      if (!existing) {
        yield* status.set(sessionID, { type: "idle" }).pipe(
          Effect.provideService(InstanceRef, instance),
          Effect.provideService(WorkspaceRef, workspace),
        )
        return
      }
      yield* existing.cancel
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      const runnerHandle = yield* runner(sessionID, onInterrupt)
      const wasIdle = !runnerHandle.busy
      // Publish busy before forking the work: the request fiber carries the
      // instance context (routed location), and this ordering guarantees busy
      // precedes the completion idle even for instantly finishing work.
      if (wasIdle) yield* status.set(sessionID, { type: "busy" })
      const result = yield* runnerHandle.ensureRunning(work)
      return result
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      ready?: Latch.Latch,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt))
        .startShell(work, ready)
        .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
    })

    return Service.of({ assertNotBusy, cancel, ensureRunning, startShell })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provide(TurnCompletion.defaultLayer),
)

const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const pending = new Set<string>([sessionID])
  const cancelled = new Set<string>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId)
  }
  let batch = (yield* background.list()).filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        background.cancel(job.id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
              if (typeof job.metadata?.sessionId === "string") pending.add(job.metadata.sessionId)
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
    batch = (yield* background.list()).filter(matches)
  }
})

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export const node = LayerNode.make(layer, [BackgroundJob.node, SessionStatus.node, TurnCompletion.node])

export * as SessionRunState from "./run-state"
