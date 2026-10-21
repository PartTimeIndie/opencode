import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

export const PerfEventInput = Schema.StructWithRest(
  Schema.Struct({
    kind: Schema.String,
    source: Schema.optional(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

export const PerfRecordInput = Schema.Struct({
  events: Schema.Array(PerfEventInput),
})

export const PerfRecordOutput = Schema.Struct({
  accepted: Schema.Number,
})

export const PerfPaths = {
  record: "/perf/record",
} as const

export const PerfApi = HttpApi.make("perf").add(
  HttpApiGroup.make("perf")
    .add(
      HttpApiEndpoint.post("record", PerfPaths.record, {
        payload: PerfRecordInput,
        success: described(PerfRecordOutput, "Performance events accepted"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "perf.record",
          summary: "Record performance events",
          description: "Record batched app and harness performance events in the server performance log.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "perf", description: "Performance observability routes." })),
)
