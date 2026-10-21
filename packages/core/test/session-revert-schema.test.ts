import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"

test("legacy session events preserve the verified rollback file action and blocked reason", () => {
  const base = {
    id: "ses_rollback_schema",
    projectID: "global",
    slug: "rollback",
    directory: "/project",
    title: "Rollback",
    version: "test",
    time: { created: 1, updated: 2 },
  }
  for (const revert of [
    { messageID: "msg_rollback", status: "reverted", fileAction: "journal" },
    { messageID: "msg_rollback", status: "reverted", fileAction: "messages_only" },
    { messageID: "msg_rollback", status: "blocked", blockedReason: "unattributed" },
  ] as const) {
    const decoded = Schema.decodeUnknownSync(SessionV1.SessionInfo)({ ...base, revert })
    expect(Schema.encodeSync(SessionV1.SessionInfo)(decoded).revert).toEqual(revert)
  }
})
