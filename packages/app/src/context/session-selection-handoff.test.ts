import { describe, expect, test } from "bun:test"
import { sessionSelectionHandoff } from "./session-selection-handoff"

const snapshot = { agent: "build", chainID: "chain-build" }

const scope = (directory: string, sessionID: string) => ({
  scope: "server-scope",
  directory,
  sessionID,
})

describe("sessionSelectionHandoff", () => {
  test("begin locks the session and rejects a second concurrent begin", () => {
    const key = scope("/handoff-owner", "ses_owner")
    expect(sessionSelectionHandoff.busy(key.scope, key.directory, key.sessionID)).toBe(false)

    expect(sessionSelectionHandoff.begin(key.scope, key.directory, key.sessionID, snapshot)).toBe(true)
    expect(sessionSelectionHandoff.busy(key.scope, key.directory, key.sessionID)).toBe(true)
    expect(sessionSelectionHandoff.begin(key.scope, key.directory, key.sessionID, { agent: "plan" })).toBe(false)
    expect(sessionSelectionHandoff.busy(key.scope, key.directory, key.sessionID)).toBe(true)
  })

  test("commit publishes the confirmed snapshot and unlocks the session", () => {
    const key = scope("/handoff-commit", "ses_commit")
    expect(sessionSelectionHandoff.begin(key.scope, key.directory, key.sessionID, snapshot)).toBe(true)

    sessionSelectionHandoff.commit(key.scope, key.directory, key.sessionID, snapshot)
    expect(sessionSelectionHandoff.busy(key.scope, key.directory, key.sessionID)).toBe(false)
    expect(sessionSelectionHandoff.entry(key.scope, key.directory, key.sessionID)).toMatchObject({
      phase: "committed",
      snapshot,
    })

    // The committed transition is finished; a new one is allowed and increments the generation.
    const committedGeneration = sessionSelectionHandoff.entry(key.scope, key.directory, key.sessionID)!.generation
    expect(sessionSelectionHandoff.begin(key.scope, key.directory, key.sessionID, { agent: "plan" })).toBe(true)
    expect(sessionSelectionHandoff.entry(key.scope, key.directory, key.sessionID)!.generation).toBe(committedGeneration + 1)
  })

  test("fail and uncertain unlock without claiming a committed selection", () => {
    const failed = scope("/handoff-failed", "ses_failed")
    sessionSelectionHandoff.begin(failed.scope, failed.directory, failed.sessionID, snapshot)
    sessionSelectionHandoff.fail(failed.scope, failed.directory, failed.sessionID)
    expect(sessionSelectionHandoff.busy(failed.scope, failed.directory, failed.sessionID)).toBe(false)
    expect(sessionSelectionHandoff.entry(failed.scope, failed.directory, failed.sessionID)).toMatchObject({ phase: "failed" })

    const uncertain = scope("/handoff-uncertain", "ses_uncertain")
    sessionSelectionHandoff.begin(uncertain.scope, uncertain.directory, uncertain.sessionID, snapshot)
    sessionSelectionHandoff.uncertain(uncertain.scope, uncertain.directory, uncertain.sessionID)
    expect(sessionSelectionHandoff.busy(uncertain.scope, uncertain.directory, uncertain.sessionID)).toBe(false)
    expect(sessionSelectionHandoff.entry(uncertain.scope, uncertain.directory, uncertain.sessionID)).toMatchObject({
      phase: "uncertain",
      snapshot,
    })
  })

  test("settle ignores keys without a pending transition", () => {
    const key = scope("/handoff-idle", "ses_idle")
    expect(sessionSelectionHandoff.entry(key.scope, key.directory, key.sessionID)).toBeUndefined()
    sessionSelectionHandoff.commit(key.scope, key.directory, key.sessionID, snapshot)
    expect(sessionSelectionHandoff.entry(key.scope, key.directory, key.sessionID)).toBeUndefined()
  })

  test("keys isolate scope, directory and session", () => {
    const first = scope("/handoff-iso", "ses_iso")
    const second = { scope: first.scope, directory: first.directory, sessionID: "ses_iso_other" }
    const third = { scope: first.scope, directory: "/handoff-iso-other", sessionID: first.sessionID }

    sessionSelectionHandoff.begin(first.scope, first.directory, first.sessionID, snapshot)
    expect(sessionSelectionHandoff.busy(second.scope, second.directory, second.sessionID)).toBe(false)
    expect(sessionSelectionHandoff.busy(third.scope, third.directory, third.sessionID)).toBe(false)

    sessionSelectionHandoff.commit(first.scope, first.directory, first.sessionID, snapshot)
    expect(sessionSelectionHandoff.entry(second.scope, second.directory, second.sessionID)).toBeUndefined()
    expect(sessionSelectionHandoff.entry(third.scope, third.directory, third.sessionID)).toBeUndefined()
  })
})
