import { Perf } from "@opencode-ai/core/observability/perf"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { PerfRecordInput } from "../groups/perf"

const MAX_EVENTS = 100

export const perfHandlers = HttpApiBuilder.group(RootHttpApi, "perf", (handlers) =>
  Effect.gen(function* () {
    const record = Effect.fn("PerfHttpApi.record")(function* (ctx: { payload: typeof PerfRecordInput.Type }) {
      const events = ctx.payload.events.slice(0, MAX_EVENTS).map((event) => ({ ...event, source: event.source ?? "app" }))
      yield* Perf.recordBatch(events, "ui")
      return { accepted: events.length }
    })

    return handlers.handle("record", record)
  }),
)
