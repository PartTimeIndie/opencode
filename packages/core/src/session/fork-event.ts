export * as SessionForkEvent from "./fork-event"

import { Schema } from "effect"
import { AgentV2 } from "../agent"
import { EventV2 } from "../event"
import { NonNegativeInt } from "../schema"
import { SystemContext } from "../system-context/index"
import { V2Schema } from "../v2-schema"
import { SessionForkAttachmentID } from "./fork-attachment-id"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"

const sync = { aggregate: "sessionID", version: 1 } as const

// This namespace identifies event-backed attachment rows for checkpoints only.
// It carries no permission or execution authority.
export const AttachmentPrefix = SessionForkAttachmentID.AttachmentPrefix
export const AttachmentID = Schema.String.check(Schema.isPattern(/^att_fork_[a-f0-9]{32}$/))

// Separate from session/event.ts: Message itself depends on the base event
// schemas. Importing it back there would create a runtime schema cycle.
export const MessageImported = EventV2.define({
  type: "session.next.fork.message-imported",
  sync,
  schema: {
    sessionID: SessionSchema.ID,
    sourceSessionID: SessionSchema.ID,
    sourceMessageID: SessionMessage.ID,
    timestamp: V2Schema.DateTimeUtcFromMillis,
    message: SessionMessage.Message,
  },
})

export const EpochImported = EventV2.define({
  type: "session.next.fork.epoch-imported",
  sync,
  schema: {
    sessionID: SessionSchema.ID,
    sourceSessionID: SessionSchema.ID,
    throughSeq: NonNegativeInt,
    baseline: Schema.String,
    baselineSeq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1)),
    agent: AgentV2.ID,
    snapshot: SystemContext.Snapshot,
  },
})

// This boundary selects historical messages only; it is never a grant to run a child.
export const HistoryBoundaryImported = EventV2.define({
  type: "session.next.fork.history-boundary-imported",
  sync,
  schema: {
    sessionID: SessionSchema.ID,
    sourceSessionID: SessionSchema.ID,
    throughSeq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1)),
    dispatchDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(Schema.optional),
  },
})

export const AttachmentsImported = EventV2.define({
  type: "session.next.fork.attachments-imported",
  sync,
  schema: {
    sessionID: SessionSchema.ID,
    attachments: Schema.Array(
      Schema.Struct({
        id: AttachmentID,
        messageID: SessionMessage.ID.pipe(Schema.optional),
        mime: Schema.String,
        filename: Schema.String.pipe(Schema.optional),
        sizeBytes: NonNegativeInt,
        sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
        storagePath: Schema.String,
        createdAt: NonNegativeInt,
      }),
    ),
  },
})
