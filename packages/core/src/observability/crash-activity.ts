export * as CrashActivity from "./crash-activity"

import { Cause, Effect, Exit } from "effect"

type Operation = { name: string } & (
  | { kind: "tool" | "provider" | "session-read" | "session-stage"; sessionID: string }
  | { kind: "sqlite"; sessionID?: never }
  | { kind: "plugin"; pluginID: string; sessionID?: string }
)

type Outcome = "success" | "failure" | "interrupted"
export type Update = ({ phase: "start"; id: number } & Operation) | { phase: "end"; id: number; outcome: Outcome }

export function create() {
  let sink: ((update: Update) => void) | undefined
  let nextID = 0

  function send(target: NonNullable<typeof sink>, update: Update) {
    try {
      target(update)
    } catch {
      // A closed diagnostics channel must never affect session execution.
    }
  }

  function start(target: NonNullable<typeof sink>, operation: Operation) {
    const id = ++nextID
    const base = { phase: "start", id, name: operation.name } as const
    if (operation.kind === "plugin") {
      send(target, {
        ...base, kind: operation.kind, pluginID: operation.pluginID,
        ...(operation.sessionID === undefined ? {} : { sessionID: operation.sessionID }),
      })
    } else if (operation.kind === "sqlite") {
      send(target, { ...base, kind: operation.kind })
    } else {
      send(target, { ...base, kind: operation.kind, sessionID: operation.sessionID })
    }
    return (outcome: Outcome) => send(target, { phase: "end", id, outcome })
  }

  return {
    configure(target: NonNullable<typeof sink>) {
      sink = target
      return () => {
        if (sink === target) sink = undefined
      }
    },
    track<A, E, R>(operation: Operation, effect: Effect.Effect<A, E, R>) {
      const target = sink
      if (!target) return effect
      return Effect.acquireUseRelease(
        Effect.sync(() => start(target, operation)),
        () => effect,
        (end, exit) => Effect.sync(() => end(
          Exit.isSuccess(exit) ? "success" : Cause.hasInterrupts(exit.cause) ? "interrupted" : "failure",
        )),
      )
    },
    trackSync<A>(operation: Operation, work: () => A): A {
      if (!sink) return work()
      const end = start(sink, operation)
      try {
        const result = work()
        end("success")
        return result
      } catch (error) {
        end("failure")
        throw error
      }
    },
    trackPromise<A>(operation: Operation, work: () => Promise<A>): Promise<A> {
      if (!sink) return work()
      const end = start(sink, operation)
      try {
        return work().then(
          (value) => { end("success"); return value },
          (error) => { end("failure"); throw error },
        )
      } catch (error) {
        end("failure")
        throw error
      }
    },
  }
}

export const { configure, track, trackSync, trackPromise } = create()
