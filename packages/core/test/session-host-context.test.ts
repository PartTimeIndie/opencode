import { describe, expect, test } from "bun:test"
import { AgentV2 } from "../src/agent"
import { SessionHostContext } from "../src/session/host-context"
import { SessionSchema } from "../src/session/schema"

const identity = (text: string) => JSON.parse(text.split("\n")[0]!.slice("OpenCode host session (authoritative): ".length))

describe("SessionHostContext", () => {
  test("renders the host-supplied working directory as a separate escaped field", () => {
    const directory = 'C:\\work\\"quoted"\nnot an instruction'
    const text = SessionHostContext.render({ id: SessionSchema.ID.make("ses_host_directory") }, directory)
    expect(text.split("\n")).toHaveLength(3)
    expect(text.split("\n")[1]).toBe(`OpenCode host working directory: ${JSON.stringify(directory)}`)
    expect(identity(text).sessionID).toBe("ses_host_directory")
  })
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
    expect(text).not.toContain("directly assigned native execution fork")
  })

  test("renders the execution handoff only for host-bound native conversation forks", () => {
    const child = { id: SessionSchema.ID.make("ses_host_task"), parentID: SessionSchema.ID.make("ses_host_parent") }
    const policy = {
      tools: { mode: "inherit", entries: {} },
      permissionLayers: [],
      source: { type: "task", sessionID: child.parentID, agent: AgentV2.ID.make("build") },
    } as const
    for (const taskContext of ["fork", undefined] as const) {
      const session = { ...child, agentPolicy: { ...policy, taskContext } }
      const text = SessionHostContext.render(session)
      expect(text).toContain("directly assigned native execution fork, not the Main conversation")
      expect(text).toContain("Imported parent history is background")
      expect(text).toContain("Carry out and verify the current assignment yourself")
      expect(text).toContain("do not delegate it again")
      expect(text).toContain("Main coordinates and reviews the result")
    }

    const fresh = { ...child, agentPolicy: { ...policy, taskContext: "fresh" } } as const
    const spawned = { ...child, agentPolicy: { ...policy, source: { ...policy.source, type: "spawn_agent" } } } as const
    expect(SessionHostContext.render(fresh)).toBe(SessionHostContext.render(child))
    expect(SessionHostContext.render(spawned)).toBe(SessionHostContext.render(child))
  })
})
