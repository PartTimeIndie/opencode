export * as SessionSchema from "./schema"

import { Schema } from "effect"
import { FileMutation } from "../file-mutation"
import { Location } from "../location"
import { ModelV2 } from "../model"
import { ProjectV2 } from "../project"
import { externalID, type ExternalID, NonNegativeInt, RelativePath, optionalOmitUndefined, withStatics } from "../schema"
import { Identifier } from "../util/identifier"
import { V2Schema } from "../v2-schema"
import { AgentV2 } from "../agent"
import { SessionAgentPolicy } from "./agent-policy"

export const ID = Schema.String.check(Schema.isStartsWith("ses")).pipe(
  Schema.brand("SessionID"),
  withStatics((schema) => {
    const create = () => schema.make("ses_" + Identifier.descending())
    return {
      create,
      descending: (id?: string) => (id === undefined ? create() : schema.make(id)),
      fromExternal: (input: ExternalID) => schema.make(externalID("ses", input)),
    }
  }),
)
export type ID = typeof ID.Type

const MessageID = Schema.String.check(Schema.isStartsWith("msg"))

export const RevertConflict = Schema.Struct({
  target: Schema.String,
  resource: Schema.String,
  expected: FileMutation.CheckpointState,
  actual: FileMutation.CheckpointState,
  message: Schema.String,
})
export type RevertConflict = typeof RevertConflict.Type

export const MetadataPatch = Schema.Struct({
  set: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
  unset: Schema.Array(Schema.String).pipe(Schema.optional),
}).annotate({ identifier: "SessionMetadataPatch" })
export type MetadataPatch = typeof MetadataPatch.Type

export const RevertRepair = Schema.Struct({
  status: Schema.Literals(["not_started", "requested", "running", "resolved", "failed"]),
  attempts: NonNegativeInt,
  childSessionID: ID.pipe(optionalOmitUndefined),
  error: Schema.String.pipe(optionalOmitUndefined),
})
export type RevertRepair = typeof RevertRepair.Type

export const Revert = Schema.Struct({
  messageID: MessageID,
  partID: Schema.String.pipe(optionalOmitUndefined),
  snapshot: Schema.String.pipe(optionalOmitUndefined),
  diff: Schema.String.pipe(optionalOmitUndefined),
  status: Schema.Literals(["reverted", "blocked"]).pipe(optionalOmitUndefined),
  blockedReason: Schema.Literals(["conflict", "unattributed"]).pipe(optionalOmitUndefined),
  fileAction: Schema.Literals(["journal", "messages_only"]).pipe(optionalOmitUndefined),
  conflicts: Schema.Array(RevertConflict).pipe(optionalOmitUndefined),
  repair: RevertRepair.pipe(optionalOmitUndefined),
})
export type Revert = typeof Revert.Type

export const Share = Schema.Struct({
  url: Schema.String,
})
export type Share = typeof Share.Type

export const SummaryFileDiff = Schema.Struct({
  file: Schema.String.pipe(optionalOmitUndefined),
  patch: Schema.String.pipe(optionalOmitUndefined),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.Literals(["added", "deleted", "modified"]).pipe(optionalOmitUndefined),
})
export type SummaryFileDiff = typeof SummaryFileDiff.Type

export const Summary = Schema.Struct({
  additions: Schema.Finite,
  deletions: Schema.Finite,
  files: Schema.Finite,
  diffs: Schema.Array(SummaryFileDiff).pipe(optionalOmitUndefined),
})
export type Summary = typeof Summary.Type

export class Info extends Schema.Class<Info>("SessionV2.Info")({
  id: ID,
  parentID: ID.pipe(optionalOmitUndefined),
  projectID: ProjectV2.ID,
  agent: AgentV2.ID.pipe(Schema.optional),
  model: ModelV2.Ref.pipe(Schema.optional),
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
  time: Schema.Struct({
    created: V2Schema.DateTimeUtcFromMillis,
    updated: V2Schema.DateTimeUtcFromMillis,
    archived: V2Schema.DateTimeUtcFromMillis.pipe(Schema.optional),
  }),
  title: Schema.String,
  protected: Schema.Boolean.pipe(Schema.optional),
  share: Share.pipe(optionalOmitUndefined),
  summary: Summary.pipe(optionalOmitUndefined),
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
  agentPolicy: SessionAgentPolicy.Info.pipe(Schema.optional),
  revert: Revert.pipe(optionalOmitUndefined),
  location: Location.Ref,
  subpath: RelativePath.pipe(Schema.optional),
}) {}
