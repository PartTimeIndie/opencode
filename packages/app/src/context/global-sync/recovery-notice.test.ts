import { expect, test } from "bun:test"
import { adaptSessionMessages, needsOlderSessionMessageContext } from "./session-message-adapter"
import { createSessionLiveProjection } from "./session-live-projection"
import type { SessionMessage } from "@opencode-ai/sdk/v2/client"

test("recovery notice has identical live/reload display without creating a user turn", () => {
  const user: SessionMessage = { id: "msg_user", type: "user", text: "Work", time: { created: 1 } }
  const notice: SessionMessage = { id: "msg_crash_fixture", type: "system", text: "Server neu gestartet", time: { created: 2 }, metadata: { systemNotice: "server-recovery" } }
  const saved = adaptSessionMessages("ses_fixture", [user, notice])
  expect(saved.messages.map((message) => message.role)).toEqual(["user", "assistant"])
  expect(saved.messages[1]).toMatchObject({ agent: "system", parentID: "msg_user", time: { completed: 2 } })
  expect(saved.parts[1].part[0]).toMatchObject({ text: "Systemhinweis: Server neu gestartet" })
  const live = createSessionLiveProjection()
  const event = { id: "evt_crash", type: "session.next.context.updated", data: {
    sessionID: "ses_fixture", messageID: notice.id, timestamp: 2, text: notice.text,
  } }
  const projected = live.handle(event, { message: { ses_fixture: [saved.messages[0]] }, part: {} })
  expect(projected).toEqual({ kind: "message", sessionID: "ses_fixture", message: saved.messages[1], parts: saved.parts[1].part })
  expect(live.handle(event, { message: {}, part: {} })).toEqual({ kind: "handled", sessionID: "ses_fixture" })
  expect(needsOlderSessionMessageContext([notice])).toBe(true)
  expect(needsOlderSessionMessageContext([user, notice])).toBe(false)
})

test("ordinary system context remains hidden, and notices do not reparent later assistant messages", () => {
  const result = adaptSessionMessages("ses_fixture", [
    { id: "msg_user", type: "user", text: "Work", time: { created: 1 } },
    { id: "msg_context", type: "system", text: "Private baseline", time: { created: 2 } },
    { id: "msg_crash_fixture", type: "system", text: "Paused", time: { created: 3 }, metadata: { systemNotice: "server-recovery" } },
    { id: "msg_assistant", type: "assistant", agent: "build", model: { id: "model", providerID: "fixture" }, time: { created: 4 }, content: [] },
  ])
  expect(result.messages).toHaveLength(3)
  expect(result.messages[2]).toMatchObject({ parentID: "msg_user" })
})
