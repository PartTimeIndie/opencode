import { describe, expect, test } from "bun:test"
import { SessionHostContext } from "../src/session/host-context"
import { SessionSchema } from "../src/session/schema"

const identity = (text: string) => JSON.parse(text.split("\n")[0]!.slice("OpenCode host session (authoritative): ".length))

describe("SessionHostContext", () => {
  test("renders only host identity without provider environment, title or approval", () => {
    const text = SessionHostContext.render({ id: SessionSchema.ID.make("ses_host_main") })
    expect(identity(text)).toEqual({ app: "opencode", sessionID: "ses_host_main", parentSessionID: null, role: "main" })
    expect(text).toContain("grants no user approval")
    expect(text).not.toContain("mainSessionID")
    expect(text).not.toContain("CODEX_SESSION_ID")
  })

  test("retains the current child's own ID and explicitly forbids acting as its parent", () => {
    const text = SessionHostContext.render({ id: SessionSchema.ID.make("ses_host_child"), parentID: SessionSchema.ID.make("ses_host_parent") })
    expect(identity(text)).toEqual({ app: "opencode", sessionID: "ses_host_child", parentSessionID: "ses_host_parent", role: "child" })
    expect(text).toContain("Child sessions must not start a main-session workflow or act as their parent")
    expect(text).not.toContain("mainSessionID")
  })
})
