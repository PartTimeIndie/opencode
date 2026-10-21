import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigAgent } from "@opencode-ai/core/config/agent"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"

describe("project availability configuration", () => {
  test("matches normalized Windows paths without changing POSIX case sensitivity", () => {
    const scope = { mode: "projects" as const, projects: ["C:/Projects/PU"] }
    expect(ConfigAgent.projectScopeAllows(scope, "c:\\projects\\pu\\.\\")).toBe(true)
    expect(ConfigAgent.projectScopeAllows(scope, "C:/Projects/Other")).toBe(false)
    expect(ConfigAgent.projectScopeAllows({ mode: "projects", projects: [] }, "C:/Projects/PU")).toBe(false)
    expect(ConfigAgent.projectScopeAllows({ mode: "global" }, "C:/Projects/Future")).toBe(true)
    expect(ConfigAgent.projectScopeAllows({ mode: "projects", projects: ["/work/PU"] }, "/work/pu")).toBe(false)
    expect(ConfigAgent.projectPermissionForPath({ "c:\\projects\\pu\\": "deny" }, "C:/Projects/PU")).toBe("deny")
  })

  test("round-trips tool and skill policies in both config dialects", () => {
    const tools = { mode: "explicit", entries: { image_generate: { visible: true, permission: "ask", scope: { mode: "projects", projects: ["C:/Projects/PU"] }, projectPermissions: { "C:/Projects/PU": "deny" } } } } as const
    expect(Schema.decodeUnknownSync(ConfigAgent.Tools)(tools)).toEqual(tools)
    expect(Schema.decodeUnknownSync(ConfigAgentV1.Info)({ tools } as unknown).options?.__agentTools).toEqual(tools)
    const scopes = { "C:/Skills/shared": { mode: "projects" as const, projects: ["C:/Projects/PU"] } }
    expect(Schema.decodeUnknownSync(Config.Info)({ skill_scopes: scopes }).skill_scopes).toEqual(scopes)
    expect(Schema.decodeUnknownSync(ConfigV1.Info)({ skill_scopes: scopes }).skill_scopes).toEqual(scopes)
  })
})
