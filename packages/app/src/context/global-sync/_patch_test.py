from pathlib import Path

p = Path(r"C:/GitRepros/opencode/packages/app/src/context/global-sync/event-reducer.test.ts")
s = p.read_text(encoding="utf-8")
old1 = """import { applyDirectoryEvent, applyGlobalEvent, cleanupDroppedSessionCaches } from "./event-reducer"
import { isV2PermissionRequest } from "../permission-request"
"""
new1 = """import { applyDirectoryEvent, applyGlobalEvent, cleanupDroppedSessionCaches } from "./event-reducer"
import { isV2PermissionRequest } from "../permission-request"
import { sessionActivity } from "@/utils/session-activity"
"""
old2 = """    apply("session.next.activity.started", "activity_a")
    apply("session.next.activity.interrupted", "activity_a")
    apply("session.next.activity.started", "activity_a")

    expect(store.session_status[sessionID]).toEqual({ type: "idle" })
  })

  test("ignores obsolete completion states from session.turn.completed", () => {
"""
new2 = """    apply("session.next.activity.started", "activity_a")
    apply("session.next.activity.interrupted", "activity_a")
    apply("session.next.activity.started", "activity_a")

    expect(store.session_status[sessionID]).toEqual({ type: "idle" })
  })

  test("finishes leftover client activity on idle once the latest assistant has settled", () => {
    const directory = "/idle-settled-activity"
    const sessionID = "ses_idle_settled"
    const [store, setStore] = createStore({
      ...baseState(),
      message: {
        [sessionID]: [{ id: "msg_final", role: "assistant" as const, finish: "stop", time: { completed: 1 } }],
      },
      part: { msg_final: [{ type: "text" }] },
    })
    const apply = (event: { type: string; properties: unknown }) =>
      applyDirectoryEvent({
        event,
        store,
        setStore,
        push() {},
        directory,
        loadLsp() {},
      })

    apply({ type: "session.next.activity.started", properties: { sessionID, activityID: "activity_stuck" } })
    expect(sessionActivity(directory, sessionID)?.type).toBe("busy")

    apply({ type: "session.status", properties: { sessionID, status: { type: "idle" } } })
    expect(sessionActivity(directory, sessionID)).toBeUndefined()
    expect(store.session_status[sessionID]).toEqual({ type: "idle" })
  })

  test("keeps client activity through a premature idle snapshot while tools are still running", () => {
    const directory = "/idle-premature-activity"
    const sessionID = "ses_idle_premature"
    const [store, setStore] = createStore({
      ...baseState(),
      message: {
        [sessionID]: [{ id: "msg_tools", role: "assistant" as const, finish: "tool-calls", time: { completed: 1 } }],
      },
      part: { msg_tools: [{ type: "tool", state: { status: "running" } }] },
    })
    const apply = (event: { type: string; properties: unknown }) =>
      applyDirectoryEvent({
        event,
        store,
        setStore,
        push() {},
        directory,
        loadLsp() {},
      })

    apply({ type: "session.next.activity.started", properties: { sessionID, activityID: "activity_live" } })
    apply({ type: "session.status", properties: { sessionID, status: { type: "idle" } } })
    expect(sessionActivity(directory, sessionID)?.type).toBe("busy")
  })

  test("ignores obsolete completion states from session.turn.completed", () => {
"""
if old1 not in s:
    raise SystemExit("old1 missing")
if old2 not in s:
    raise SystemExit("old2 missing")
p.write_text(s.replace(old1, new1, 1).replace(old2, new2, 1), encoding="utf-8")
print("updated tests")
