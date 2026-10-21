import { NonNegativeInt } from "@opencode-ai/core/schema"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/sync"
export const ReplayEvent = Schema.Struct({
  id: EventV2.ID,
  aggregateID: Schema.String,
  seq: NonNegativeInt,
  type: Schema.String,
  data: Schema.Record(Schema.String, Schema.Unknown),
})
export const LegacyReplayPayload = Schema.Struct({
  directory: Schema.String,
  capability: Schema.optional(Schema.Undefined),
  events: Schema.NonEmptyArray(ReplayEvent),
})
export const ReplayCheckpoint = Schema.Struct({
  aggregateID: Schema.String,
  seq: NonNegativeInt,
  version: Schema.Literal(EventV2.CheckpointVersion),
  baseline: Schema.Struct({
    adapter: Schema.String,
    version: NonNegativeInt,
    data: Schema.Record(Schema.String, Schema.Unknown),
  }),
  baselineHash: Schema.String,
  eventHash: Schema.String,
  compactedSeq: Schema.optional(NonNegativeInt),
  compactedAt: Schema.optional(NonNegativeInt),
})
export const LegacyReplayCheckpoint = Schema.Struct({
  aggregateID: Schema.String,
  seq: NonNegativeInt,
  version: Schema.Literal(EventV2.LegacyCheckpointVersion),
  events: Schema.Array(ReplayEvent),
  eventHash: Schema.optional(Schema.String),
  projectionHash: Schema.optional(Schema.String),
  compactedSeq: Schema.optional(NonNegativeInt),
  compactedAt: Schema.optional(NonNegativeInt),
})
export const CheckpointReplayPayload = Schema.Struct({
  directory: Schema.String,
  capability: Schema.Literal(EventV2.CheckpointCapability),
  checkpoint: ReplayCheckpoint,
  events: Schema.Array(ReplayEvent),
})
export const PreviousCheckpointReplayPayload = Schema.Struct({
  directory: Schema.String,
  capability: Schema.Literal(EventV2.PreviousCheckpointCapability),
  checkpoint: ReplayCheckpoint,
  events: Schema.Array(ReplayEvent),
})
export const LegacyCheckpointReplayPayload = Schema.Struct({
  directory: Schema.String,
  capability: Schema.Literal(EventV2.LegacyCheckpointCapability),
  checkpoint: LegacyReplayCheckpoint,
  events: Schema.Array(ReplayEvent),
})
const UnsupportedCheckpointCapability = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((capability) =>
      [
        EventV2.CheckpointCapability,
        EventV2.PreviousCheckpointCapability,
        EventV2.LegacyCheckpointCapability,
      ].some((known) => known === capability)
        ? "Expected an unsupported checkpoint capability"
        : undefined,
    ),
  ),
)
export const UnsupportedCheckpointReplayPayload = Schema.Struct({
  directory: Schema.String,
  capability: UnsupportedCheckpointCapability,
  events: Schema.Array(ReplayEvent),
})
export const ReplayPayload = Schema.Union([
  CheckpointReplayPayload,
  PreviousCheckpointReplayPayload,
  LegacyCheckpointReplayPayload,
  UnsupportedCheckpointReplayPayload,
  LegacyReplayPayload,
])
export const ReplayResponse = Schema.Struct({
  sessionID: Schema.String,
})
export const SessionPayload = Schema.Struct({
  sessionID: SessionID,
})
export const LegacyHistoryPayload = Schema.Record(Schema.String, NonNegativeInt)
export const CheckpointHistoryPayload = Schema.Struct({
  capability: Schema.Literal(EventV2.CheckpointCapability),
  cursors: LegacyHistoryPayload,
})
export const PreviousCheckpointHistoryPayload = Schema.Struct({
  capability: Schema.Literal(EventV2.PreviousCheckpointCapability),
  cursors: LegacyHistoryPayload,
})
export const LegacyCheckpointHistoryPayload = Schema.Struct({
  capability: Schema.Literal(EventV2.LegacyCheckpointCapability),
  cursors: LegacyHistoryPayload,
})
export const UnsupportedCheckpointHistoryPayload = Schema.Struct({
  capability: UnsupportedCheckpointCapability,
  cursors: Schema.optional(LegacyHistoryPayload),
})
export const HistoryPayload = Schema.Union([
  CheckpointHistoryPayload,
  PreviousCheckpointHistoryPayload,
  LegacyCheckpointHistoryPayload,
  UnsupportedCheckpointHistoryPayload,
  LegacyHistoryPayload,
])
export const HistoryEvent = Schema.Struct({
  id: EventV2.ID,
  aggregate_id: Schema.String,
  seq: NonNegativeInt,
  type: Schema.String,
  data: Schema.Record(Schema.String, Schema.Unknown),
})
export const CheckpointHistoryResponse = Schema.Struct({
  capability: Schema.Literal(EventV2.CheckpointCapability),
  aggregates: Schema.Array(
    Schema.Struct({
      aggregateID: Schema.String,
      checkpoint: Schema.optional(ReplayCheckpoint),
      events: Schema.Array(ReplayEvent),
    }),
  ),
})

export class SyncUpgradeRequiredError extends Schema.ErrorClass<SyncUpgradeRequiredError>("SyncUpgradeRequiredError")(
  {
    name: Schema.Literal("SyncUpgradeRequiredError"),
    data: Schema.Struct({
      requiredCapability: Schema.Literal(EventV2.CheckpointCapability),
      reason: Schema.Literals([
        "checkpoint_capability_required",
        "checkpoint_reset_required",
        "checkpoint_upgrade_required",
        "content_externalization_required",
      ]),
      message: Schema.String,
    }),
  },
  { httpApiStatus: 409 },
) {}

export const SyncPaths = {
  start: `${root}/start`,
  replay: `${root}/replay`,
  steal: `${root}/steal`,
  history: `${root}/history`,
} as const

export const SyncApi = HttpApi.make("sync")
  .add(
    HttpApiGroup.make("sync")
      .add(
        HttpApiEndpoint.post("start", SyncPaths.start, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Workspace sync started"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.start",
            summary: "Start workspace sync",
            description: "Start sync loops for workspaces in the current project that have active sessions.",
          }),
        ),
        HttpApiEndpoint.post("replay", SyncPaths.replay, {
          query: WorkspaceRoutingQuery,
          payload: ReplayPayload,
          success: described(ReplayResponse, "Replayed sync events"),
          error: [HttpApiError.BadRequest, SyncUpgradeRequiredError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.replay",
            summary: "Replay sync events",
            description: "Validate and replay a complete sync event history.",
          }),
        ),
        HttpApiEndpoint.post("steal", SyncPaths.steal, {
          query: WorkspaceRoutingQuery,
          payload: SessionPayload,
          success: described(SessionPayload, "Session stolen into workspace"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.steal",
            summary: "Steal session into workspace",
            description: "Update a session to belong to the current workspace through the sync event system.",
          }),
        ),
        HttpApiEndpoint.post("history", SyncPaths.history, {
          query: WorkspaceRoutingQuery,
          payload: HistoryPayload,
          success: described(Schema.Union([CheckpointHistoryResponse, Schema.Array(HistoryEvent)]), "Sync events"),
          error: [HttpApiError.BadRequest, SyncUpgradeRequiredError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.history.list",
            summary: "List sync events",
            description:
              "List sync state for all aggregates. Keys are aggregate IDs the client already knows about, values are the last known sequence ID. Events with seq > value are returned for those aggregates. A checkpoint-capable client receives a verified projection baseline plus its event tail for aggregates it does not know yet.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "sync",
          description: "Experimental HttpApi sync routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
