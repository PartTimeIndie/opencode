import { Schema, SchemaGetter } from "effect"
import { ProviderMetadata, ToolContent } from "@opencode-ai/llm"
import { EventV2 } from "../event"
import { ModelV2 } from "../model"
import { NonNegativeInt } from "../schema"
import { V2Schema } from "../v2-schema"
import { FileAttachment, Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { Location } from "../location"
import { ProjectV2 } from "../project"
import { RelativePath } from "../schema"
import { SessionMessageID } from "./message-id"
import { SessionFailure } from "./failure"
import { StructuredOutputAttempt } from "./structured-output-attempt"

export { FileAttachment }

export const Source = Schema.Struct({
  start: NonNegativeInt,
  end: NonNegativeInt,
  text: Schema.String,
}).annotate({
  identifier: "session.next.event.source",
})
export type Source = typeof Source.Type

const Base = {
  timestamp: V2Schema.DateTimeUtcFromMillis,
  sessionID: SessionSchema.ID,
}

const options = {
  sync: {
    aggregate: "sessionID",
    version: 1,
  },
} as const
const stepSettlementOptions = {
  sync: {
    aggregate: "sessionID",
    version: 2,
  },
} as const

// Turn completion is an operational status and does not mutate the Session projection.
// Its decoder still belongs beside the durable Session stream so isolated checkpoint
// replay can validate and retain events published by the OpenCode runtime.
export const TurnCompleted = EventV2.define({
  type: "session.turn.completed",
  ...options,
  schema: {
    sessionID: SessionSchema.ID,
    status: Schema.Literals(["done", "incomplete", "plan_ready", "unknown"]).pipe(
      Schema.decodeTo(Schema.Literals(["done", "incomplete", "unknown"]), {
        decode: SchemaGetter.transform((status) => (status === "plan_ready" ? "incomplete" : status)),
        encode: SchemaGetter.transform((status) => status),
      }),
    ),
  },
})
export type TurnCompleted = typeof TurnCompleted.Type

export const UnknownError = Schema.Struct({
  type: Schema.Literal("unknown"),
  message: Schema.String,
}).annotate({
  identifier: "Session.Error.Unknown",
})
export type UnknownError = typeof UnknownError.Type

export const AgentSwitched = EventV2.define({
  type: "session.next.agent.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessageID.ID,
    agent: Schema.String,
  },
})
export type AgentSwitched = typeof AgentSwitched.Type

export const ModelSwitched = EventV2.define({
  type: "session.next.model.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessageID.ID,
    model: ModelV2.Ref,
  },
})
export type ModelSwitched = typeof ModelSwitched.Type

export const Moved = EventV2.define({
  type: "session.next.moved",
  ...options,
  schema: {
    ...Base,
    location: Location.Ref,
    projectID: ProjectV2.ID.pipe(Schema.optional),
    subdirectory: RelativePath.pipe(Schema.optional),
  },
})
export type Moved = typeof Moved.Type

export const ProjectAssigned = EventV2.define({
  type: "session.next.project.assigned",
  sync: {
    aggregate: "sessionID",
    version: 1,
  },
  schema: {
    timestamp: V2Schema.DateTimeUtcFromMillis,
    // Project discovery also repairs pre-prefix legacy Session IDs while preserving the ID brand downstream.
    sessionID: Schema.String.pipe(Schema.brand("SessionID")),
    projectID: ProjectV2.ID,
  },
})
export type ProjectAssigned = typeof ProjectAssigned.Type

export const GeneratedTitleExpectedMetadataKey = "session.generatedTitle.expected"
export class GeneratedTitleSuperseded extends Error {}

export const ModelSwitchedExpectedMetadataKey = "session.modelSwitched.expected"
export class ModelSwitchSuperseded extends Error {}

export const TitleUpdated = EventV2.define({
  type: "session.next.title.updated",
  ...options,
  schema: {
    ...Base,
    title: Schema.String,
  },
})
export type TitleUpdated = typeof TitleUpdated.Type

export const MetadataPatched = EventV2.define({
  type: "session.next.metadata.patched",
  ...options,
  schema: {
    ...Base,
    set: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
    unset: Schema.Array(Schema.String).pipe(Schema.optional),
  },
})
export type MetadataPatched = typeof MetadataPatched.Type

export const ShareUpdated = EventV2.define({
  type: "session.next.share.updated",
  ...options,
  schema: {
    ...Base,
    share: SessionSchema.Share.pipe(Schema.optional),
  },
})
export type ShareUpdated = typeof ShareUpdated.Type

export const SummaryUpdated = EventV2.define({
  type: "session.next.summary.updated",
  ...options,
  schema: {
    ...Base,
    summary: SessionSchema.Summary.pipe(Schema.optional),
  },
})
export type SummaryUpdated = typeof SummaryUpdated.Type

export const Prompted = EventV2.define({
  type: "session.next.prompted",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessageID.ID,
    prompt: Prompt,
    delivery: Schema.Literals(["steer", "queue"]),
  },
})
export type Prompted = typeof Prompted.Type

export namespace PromptLifecycle {
  export const Admitted = EventV2.define({
    type: "session.next.prompt.admitted",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessageID.ID,
      prompt: Prompt,
      delivery: Schema.Literals(["steer", "queue"]),
      origin: Schema.Literals(["interactive", "plugin"]).pipe(Schema.optional),
    },
  })
  export type Admitted = typeof Admitted.Type

  export const Held = EventV2.define({
    type: "session.next.prompt.held",
    ...options,
    schema: {
      ...Base,
      inputIDs: Schema.Array(SessionMessageID.ID),
    },
  })
  export type Held = typeof Held.Type

  export const Released = EventV2.define({
    type: "session.next.prompt.released",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessageID.ID,
      prompt: Prompt,
    },
  })
  export type Released = typeof Released.Type

  export const Promoted = EventV2.define({
    type: "session.next.prompt.promoted",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessageID.ID,
      prompt: Prompt,
      timeCreated: V2Schema.DateTimeUtcFromMillis,
    },
  })
  export type Promoted = typeof Promoted.Type
}

export namespace SkillSelection {
  export const Origin = Schema.Struct({
    kind: Schema.Literals(["input", "chat_send", "command", "renewal"]),
    id: Schema.String,
    seq: NonNegativeInt,
  }).annotate({ identifier: "session.next.skill_selection.origin" })
  export type Origin = typeof Origin.Type

  export const Limits = Schema.Struct({
    // Limits come from the positive-integer config validation; the durable
    // event stores them with the union-light integer codec so the Session
    // event union stays within type-instantiation limits.
    minutes: NonNegativeInt,
    messages: NonNegativeInt,
  }).annotate({ identifier: "session.next.skill_selection.limits" })
  export type Limits = typeof Limits.Type

  /**
   * Single durable ledger event for selection memory. One union member keeps
   * the Session event union within type-instantiation limits; the mutation
   * discriminates the recorded decision:
   * - `selected`: provenance, limits snapshot, generation.
   * - `forgotten`: optional name (absent forgets every selection and raises
   *   the durable backfill barrier) plus the operation identity.
   * - `renewal_declined`: suppression until the next genuine selection.
   *
   * Deliberately NOT a member of `DurableDefinitions`: the definition is
   * registered with its sync option, so EventV2 persists and replays it
   * durably, while the public Session event stream stays free of internal
   * ledger noise. The projector subscribes by definition, so checkpoint
   * replay and projection rebuild reconstruct the ledger exactly.
   */
  export const Mutation = EventV2.define({
    type: "session.next.skill_selection.mutation",
    ...options,
    schema: {
      ...Base,
      mutation: Schema.Literals(["selected", "forgotten", "renewal_declined"]),
      name: Schema.String.pipe(Schema.optional),
      generation: NonNegativeInt.pipe(Schema.optional),
      origin: Origin.pipe(Schema.optional),
      selectedAt: V2Schema.DateTimeUtcFromMillis.pipe(Schema.optional),
      limits: Limits.pipe(Schema.optional),
      operationID: Schema.String.pipe(Schema.optional),
      boundMessageID: SessionMessageID.ID.pipe(Schema.optional),
      receiptInputID: SessionMessageID.ID.pipe(Schema.optional),
    },
  })
  export type Mutation = typeof Mutation.Type
}

export const InterruptRequested = EventV2.define({
  type: "session.next.interrupt.requested",
  ...options,
  schema: Base,
})
export type InterruptRequested = typeof InterruptRequested.Type

export const ContextUpdated = EventV2.define({
  type: "session.next.context.updated",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessageID.ID,
    text: Schema.String,
  },
})
export type ContextUpdated = typeof ContextUpdated.Type

export const Synthetic = EventV2.define({
  type: "session.next.synthetic",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessageID.ID,
    text: Schema.String,
  },
})
export type Synthetic = typeof Synthetic.Type

export namespace Shell {
  export const Started = EventV2.define({
    type: "session.next.shell.started",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessageID.ID,
      callID: Schema.String,
      command: Schema.String,
    },
  })
  export type Started = typeof Started.Type

  export const Ended = EventV2.define({
    type: "session.next.shell.ended",
    ...options,
    schema: {
      ...Base,
      callID: Schema.String,
      output: Schema.String,
    },
  })
  export type Ended = typeof Ended.Type
}

export const TokenMeasurement = Schema.Struct({
  version: Schema.Literal(1),
  inputTokens: NonNegativeInt.pipe(Schema.optional),
  outputTokens: NonNegativeInt.pipe(Schema.optional),
  nonCachedInputTokens: NonNegativeInt.pipe(Schema.optional),
  cacheReadInputTokens: NonNegativeInt.pipe(Schema.optional),
  cacheWriteInputTokens: NonNegativeInt.pipe(Schema.optional),
  reasoningTokens: NonNegativeInt.pipe(Schema.optional),
  totalTokens: NonNegativeInt.pipe(Schema.optional),
  // Wall-clock time in which token deltas actually streamed from the provider.
  // Excludes request assembly, first-token latency, and tool execution waits.
  generationMilliseconds: NonNegativeInt.pipe(Schema.optional),
}).annotate({ identifier: "Session.TokenMeasurement" })
export type TokenMeasurement = typeof TokenMeasurement.Type

export namespace Step {
  export const Started = EventV2.define({
    type: "session.next.step.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      agent: Schema.String,
      model: ModelV2.Ref,
      snapshot: Schema.String.pipe(Schema.optional),
      structuredOutputAttempt: StructuredOutputAttempt.Receipt.pipe(Schema.optional),
    },
  })
  export type Started = typeof Started.Type

  export const Ended = EventV2.define({
    type: "session.next.step.ended",
    ...stepSettlementOptions,
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      finish: Schema.String,
      cost: Schema.Finite,
      tokens: Schema.Struct({
        input: Schema.Finite,
        output: Schema.Finite,
        reasoning: Schema.Finite,
        cache: Schema.Struct({
          read: Schema.Finite,
          write: Schema.Finite,
        }),
      }),
      tokenMeasurement: TokenMeasurement.pipe(Schema.optional),
      snapshot: Schema.String.pipe(Schema.optional),
      structured: Schema.Unknown.pipe(Schema.optional),
    },
  })
  export type Ended = typeof Ended.Type

  export const Failed = EventV2.define({
    type: "session.next.step.failed",
    ...stepSettlementOptions,
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      error: UnknownError,
      // Typed failure contract (E2); optional so legacy events without it keep replaying.
      failure: SessionFailure.Failure.pipe(Schema.optional),
    },
  })
  export type Failed = typeof Failed.Type
}

export namespace Text {
  export const Started = EventV2.define({
    type: "session.next.text.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      textID: Schema.String,
    },
  })
  export type Started = typeof Started.Type

  // Stream fragments are live-only; Text.Ended is the replayable full-value boundary.
  export const Delta = EventV2.define({
    type: "session.next.text.delta",
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      textID: Schema.String,
      delta: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = EventV2.define({
    type: "session.next.text.ended",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      textID: Schema.String,
      text: Schema.String,
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Custom {
  export const Added = EventV2.define({
    type: "session.next.custom.added",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      partID: Schema.String,
      kind: Schema.String,
      data: Schema.Unknown,
      title: Schema.String.pipe(Schema.optional),
      fallback: Schema.String.pipe(Schema.optional),
      metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
      time: Schema.Struct({
        start: V2Schema.DateTimeUtcFromMillis,
        end: V2Schema.DateTimeUtcFromMillis.pipe(Schema.optional),
      }).pipe(Schema.optional),
    },
  })
  export type Added = typeof Added.Type
}

export namespace Reasoning {
  export const Started = EventV2.define({
    type: "session.next.reasoning.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      reasoningID: Schema.String,
      providerMetadata: ProviderMetadata.pipe(Schema.optional),
    },
  })
  export type Started = typeof Started.Type

  // Stream fragments are live-only; Reasoning.Ended is the replayable full-value boundary.
  export const Delta = EventV2.define({
    type: "session.next.reasoning.delta",
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      reasoningID: Schema.String,
      delta: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = EventV2.define({
    type: "session.next.reasoning.ended",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      reasoningID: Schema.String,
      text: Schema.String,
      providerMetadata: ProviderMetadata.pipe(Schema.optional),
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Tool {
  const ToolBase = {
    ...Base,
    assistantMessageID: SessionMessageID.ID,
    callID: Schema.String,
  }

  export namespace Input {
    export const Started = EventV2.define({
      type: "session.next.tool.input.started",
      ...options,
      schema: {
        ...ToolBase,
        name: Schema.String,
      },
    })
    export type Started = typeof Started.Type

    // Stream fragments are live-only; Input.Ended is the replayable raw-input boundary.
    export const Delta = EventV2.define({
      type: "session.next.tool.input.delta",
      schema: {
        ...ToolBase,
        delta: Schema.String,
      },
    })
    export type Delta = typeof Delta.Type

    export const Ended = EventV2.define({
      type: "session.next.tool.input.ended",
      ...options,
      schema: {
        ...ToolBase,
        text: Schema.String,
      },
    })
    export type Ended = typeof Ended.Type
  }

  export const Called = EventV2.define({
    type: "session.next.tool.called",
    ...options,
    schema: {
      ...ToolBase,
      tool: Schema.String,
      input: Schema.Record(Schema.String, Schema.Unknown),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(Schema.optional),
      }),
    },
  })
  export type Called = typeof Called.Type

  /**
   * Replayable bounded running-tool state. Tools should checkpoint semantic
   * transitions or at a bounded cadence, not persist every stdout/stderr chunk.
   */
  export const Progress = EventV2.define({
    type: "session.next.tool.progress",
    ...options,
    schema: {
      ...ToolBase,
      structured: Schema.Record(Schema.String, Schema.Any),
      content: Schema.Array(ToolContent),
    },
  })
  export type Progress = typeof Progress.Type

  export const Success = EventV2.define({
    type: "session.next.tool.success",
    ...options,
    schema: {
      ...ToolBase,
      structured: Schema.Record(Schema.String, Schema.Any),
      content: Schema.Array(ToolContent),
      outputPaths: Schema.Array(Schema.String).pipe(Schema.optional),
      result: Schema.Unknown.pipe(Schema.optional),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(Schema.optional),
      }),
    },
  })
  export type Success = typeof Success.Type

  export const Interruption = Schema.Struct({
    source: Schema.Literals(["session", "provider", "recovery"]),
    reason: SessionFailure.InterruptReason.pipe(Schema.optional),
  }).annotate({ identifier: "Session.Tool.Interruption" })
  export type Interruption = typeof Interruption.Type

  // Version 1 inferred runner interruption from an error string. Retain its decoder for deterministic legacy replay.
  export const FailedV1 = EventV2.define({
    type: "session.next.tool.failed",
    ...options,
    schema: {
      ...ToolBase,
      error: UnknownError,
      result: Schema.Unknown.pipe(Schema.optional),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(Schema.optional),
      }),
    },
  })

  export const Failed = EventV2.define({
    type: "session.next.tool.failed",
    sync: { aggregate: "sessionID", version: 2 },
    schema: {
      ...ToolBase,
      error: UnknownError,
      result: Schema.Unknown.pipe(Schema.optional),
      interruption: Interruption.pipe(Schema.optional),
      // Typed failure contract (E2); optional so legacy events without it keep replaying.
      failure: SessionFailure.Failure.pipe(Schema.optional),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(Schema.optional),
      }),
    },
  })
  export type Failed = typeof Failed.Type
}

export const RetryError = Schema.Struct({
  message: Schema.String,
  statusCode: Schema.Finite.pipe(Schema.optional),
  isRetryable: Schema.Boolean,
  responseHeaders: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  responseBody: Schema.String.pipe(Schema.optional),
  metadata: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
}).annotate({
  identifier: "session.next.retry_error",
})
export type RetryError = typeof RetryError.Type

export const Retried = EventV2.define({
  type: "session.next.retried",
  ...options,
  schema: {
    ...Base,
    attempt: Schema.Finite,
    error: RetryError,
    // Typed failure code assigned by the provider boundary mapper (E2).
    code: SessionFailure.Code.pipe(Schema.optional),
    // Provider behind the failing turn so clients can attach provider-specific actions.
    provider: Schema.String.pipe(Schema.optional),
    // Absolute wall-clock ms when the scheduled retry fires; drives client countdowns.
    next: Schema.Finite.pipe(Schema.optional),
  },
})
export type Retried = typeof Retried.Type

export namespace Revert {
  export const Marked = EventV2.define({
    type: "session.next.revert.marked",
    ...options,
    schema: {
      ...Base,
      revert: SessionSchema.Revert,
    },
  })
  export type Marked = typeof Marked.Type

  export const Cleared = EventV2.define({
    type: "session.next.revert.cleared",
    ...options,
    schema: Base,
  })
  export type Cleared = typeof Cleared.Type

  export const Cleaned = EventV2.define({
    type: "session.next.revert.cleaned",
    ...options,
    schema: {
      ...Base,
      revert: SessionSchema.Revert,
      messageIDs: Schema.Array(SessionMessageID.ID).pipe(Schema.optional),
    },
  })
  export type Cleaned = typeof Cleaned.Type
}

export namespace Activity {
  const activityOptions = {
    sync: {
      aggregate: "sessionID",
      version: 1,
    },
  } as const

  export const Started = EventV2.define({
    type: "session.next.activity.started",
    ...activityOptions,
    schema: {
      ...Base,
      activityID: Schema.String,
      kind: Schema.String,
      reason: Schema.String.pipe(Schema.optional),
    },
  })
  export type Started = typeof Started.Type

  export const Recovered = EventV2.define({
    type: "session.next.activity.recovered",
    ...activityOptions,
    schema: {
      ...Base,
      activityID: Schema.String,
      previousOwner: Schema.String.pipe(Schema.optional),
    },
  })
  export type Recovered = typeof Recovered.Type

  export const Interrupted = EventV2.define({
    type: "session.next.activity.interrupted",
    ...activityOptions,
    schema: {
      ...Base,
      activityID: Schema.String,
      reason: Schema.String.pipe(Schema.optional),
    },
  })
  export type Interrupted = typeof Interrupted.Type

  export const Completed = EventV2.define({
    type: "session.next.activity.completed",
    ...activityOptions,
    schema: {
      ...Base,
      activityID: Schema.String,
    },
  })
  export type Completed = typeof Completed.Type

  // Version 1 predates durable projection of failures that happen before an
  // assistant step starts. Keep its decoder registered so checkpoint replay
  // does not invent a message that was absent from the original projection.
  EventV2.define({
    type: "session.next.activity.failed",
    ...activityOptions,
    schema: {
      ...Base,
      activityID: Schema.String,
      error: UnknownError,
    },
  })

  export const Failed = EventV2.define({
    type: "session.next.activity.failed",
    sync: {
      aggregate: "sessionID",
      version: 2,
    },
    schema: {
      ...Base,
      activityID: Schema.String,
      error: UnknownError,
      // Optional so historical V2 activity failures continue to replay.
      failure: SessionFailure.Failure.pipe(Schema.optional),
    },
  })
  export type Failed = typeof Failed.Type
}

export namespace Compaction {
  export const Started = EventV2.define({
    type: "session.next.compaction.started",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessageID.ID,
      reason: Schema.Union([Schema.Literal("auto"), Schema.Literal("manual")]),
    },
  })
  export type Started = typeof Started.Type

  export const Delta = EventV2.define({
    type: "session.next.compaction.delta",
    schema: {
      ...Base,
      messageID: SessionMessageID.ID,
      text: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  // Retain the unpublished v1 decoder so stored beta events remain replayable.
  export const EndedV1 = EventV2.define({
    type: "session.next.compaction.ended",
    ...options,
    schema: {
      ...Base,
      text: Schema.String,
      include: Schema.String.pipe(Schema.optional),
    },
  })

  export const Ended = EventV2.define({
    type: "session.next.compaction.ended",
    sync: { aggregate: "sessionID", version: 2 },
    schema: {
      ...Base,
      messageID: SessionMessageID.ID,
      reason: Started.data.fields.reason,
      text: Schema.String,
      recent: Schema.String,
    },
  })
  export type Ended = typeof Ended.Type
}

const DurableDefinitions = [
  AgentSwitched,
  ModelSwitched,
  Moved,
  TitleUpdated,
  MetadataPatched,
  ShareUpdated,
  SummaryUpdated,
  ProjectAssigned,
  Prompted,
  PromptLifecycle.Admitted,
  PromptLifecycle.Promoted,
  InterruptRequested,
  ContextUpdated,
  Synthetic,
  Shell.Started,
  Shell.Ended,
  Step.Started,
  Step.Ended,
  Step.Failed,
  Text.Started,
  Text.Ended,
  Custom.Added,
  Tool.Input.Started,
  Tool.Input.Ended,
  Tool.Called,
  Tool.Progress,
  Tool.Success,
  Tool.Failed,
  Reasoning.Started,
  Reasoning.Ended,
  Retried,
  Revert.Marked,
  Revert.Cleared,
  Revert.Cleaned,
  Compaction.Started,
  Compaction.Ended,
  Activity.Started,
  Activity.Recovered,
  Activity.Interrupted,
  Activity.Completed,
  Activity.Failed,
] as const
const EphemeralDefinitions = [Text.Delta, Tool.Input.Delta, Reasoning.Delta, Compaction.Delta] as const

export const Durable = Schema.Union(DurableDefinitions, { mode: "oneOf" }).pipe(Schema.toTaggedUnion("type"))
export type DurableEvent = typeof Durable.Type

export const All = Schema.Union([...DurableDefinitions, ...EphemeralDefinitions], { mode: "oneOf" }).pipe(
  Schema.toTaggedUnion("type"),
)
export type Event = typeof All.Type
export type Type = Event["type"]

export * as SessionEvent from "./event"
