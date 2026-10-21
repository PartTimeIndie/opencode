from pathlib import Path

p = Path(__file__).with_name("event-reducer.ts")
s = p.read_text(encoding="utf-8")
old1 = 'import type { TurnCompletionStatus } from "@/utils/session-status"'
new1 = 'import { latestAssistantSettled, type TurnCompletionStatus } from "@/utils/session-status"'
old2 = """    case \"session.status\": {
      const props = event.properties as { sessionID: string; status: SessionStatus }
      input.setStore(\"session_status\", props.sessionID, reconcile(props.status))
      updateSessionActivity(input.directory, props.sessionID, props.status)"""
new2 = """    case \"session.status\": {
      const props = event.properties as { sessionID: string; status: SessionStatus }
      if (props.status.type === \"idle\" && latestAssistantSettled(input.store, props.sessionID)) {
        finishSessionActivity(input.directory, props.sessionID)
      }
      input.setStore(\"session_status\", props.sessionID, reconcile(props.status))
      updateSessionActivity(input.directory, props.sessionID, props.status)"""
if old1 not in s:
    raise SystemExit("old1 missing")
if old2 not in s:
    raise SystemExit("old2 missing")
p.write_text(s.replace(old1, new1, 1).replace(old2, new2, 1), encoding="utf-8")
print("updated")
