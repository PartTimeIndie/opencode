import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import path from "path"
import fs from "fs/promises"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { ConfigMigrateV1 } from "@opencode-ai/core/v1/config/migrate"
import { load } from "../../src/config/agent"
import { tmpdir } from "../fixture/fixture"

describe("agent markdown loader", () => {
  test("round-trips configurator structured policies through the legacy config schema", () => {
    const result = Schema.decodeUnknownSync(ConfigAgentV1.Info)({
      prompt: "Markdown body",
      system: { mode: "append", prompt: "Agent-specific system text", files: ["prompts/system.md"] },
      instructions: { mode: "manual", files: ["AGENTS.md", "docs/PU.md"] },
      tools: {
        mode: "explicit",
        entries: {
          read: { visible: true, permission: "allow" },
          write: { visible: true, permission: "ask" },
          bash: { visible: false, permission: "allow" },
        },
      },
      completion: { mode: "custom", prompt: "Return done or incomplete.", files: ["prompts/completion.prompt"] },
      disabled: true,
      permissions: [{ action: "bash", resource: "*", effect: "deny" }],
    })

    expect(result.disable).toBe(true)
    expect(result.prompt).toBe("Agent-specific system text\n\nMarkdown body")
    expect(result.permission).toEqual({ read: "allow", edit: "ask" })
    expect(result.options).toMatchObject({
      __agentSystemMode: "append",
      __agentSystemFiles: ["prompts/system.md"],
      __agentInstructions: { mode: "manual", files: ["AGENTS.md", "docs/PU.md"] },
      __agentPermissions: [{ action: "bash", resource: "*", effect: "deny" }],
      __agentTools: {
        mode: "explicit",
        entries: {
          read: { visible: true, permission: "allow" },
          write: { visible: true, permission: "ask" },
          bash: { visible: false, permission: "allow" },
        },
      },
    })
    expect(ConfigMigrateV1.migrateAgent(result).permissions).toEqual([
      { action: "bash", resource: "*", effect: "deny" },
    ])
    expect(ConfigMigrateV1.migrateAgent(result)).toMatchObject({
      system: {
        mode: "append",
        prompt: "Agent-specific system text\n\nMarkdown body",
        files: ["prompts/system.md"],
      },
      completion: {
        mode: "custom",
        prompt: "Return done or incomplete.",
        files: ["prompts/completion.prompt"],
      },
    })
  })

  test("preserves mixed legacy fields while decoding structured policies", () => {
    const result = Schema.decodeUnknownSync(ConfigAgentV1.Info)({
      system: { mode: "replace", prompt: "Structured system" },
      temperature: 0.2,
      top_p: 0.8,
      maxSteps: 7,
      disable: true,
      providerOption: "preserved",
    })

    expect(result).toMatchObject({
      prompt: "Structured system",
      temperature: 0.2,
      top_p: 0.8,
      steps: 7,
      disable: true,
      options: { providerOption: "preserved", __agentSystemMode: "replace" },
    })
  })

  test("persists a structured system prompt without creating a legacy prompt loop", () => {
    const first = Schema.decodeUnknownSync(ConfigAgentV1.Info)({
      system: {
        mode: "replace",
        prompt: "Use the configured bounded tools.",
        files: ["prompts/system.md"],
      },
    })
    const persisted = ConfigAgentV1.persisted(first)
    const second = Schema.decodeUnknownSync(ConfigAgentV1.Info)(persisted)

    expect(persisted.prompt).toBeUndefined()
    expect(persisted.system).toEqual({
      mode: "replace",
      prompt: "Use the configured bounded tools.",
      files: ["prompts/system.md"],
    })
    expect(second.prompt).toBe("Use the configured bounded tools.")
  })

  test("rejects malformed structured tool entries instead of defaulting them to allow", () => {
    expect(() =>
      Schema.decodeUnknownSync(ConfigAgentV1.Info)({
        tools: { mode: "explicit", entries: { bash: true } },
      }),
    ).toThrow()
  })

  test("loads structured markdown agents without rejecting tool policies", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "agents"), { recursive: true })
    await Bun.write(
      path.join(tmp.path, "agents", "pu-bot-user.md"),
      `---
description: PU agent
mode: primary
model: crng-local/gpt-oss-20b-MXFP4
system:
  mode: replace
  prompt: Answer from verified PU data.
instructions:
  mode: manual
  files:
    - AGENTS.md
tools:
  mode: explicit
  entries:
    pu_read_query:
      visible: true
      permission: allow
completion:
  mode: custom
  prompt: Return done only after a grounded answer.
---
Keep answers concise.
`,
    )

    const agents = await load(tmp.path)

    expect(agents["pu-bot-user"]).toMatchObject({
      model: "crng-local/gpt-oss-20b-MXFP4",
      prompt: "Answer from verified PU data.\n\nKeep answers concise.",
      tools: {
        mode: "explicit",
        entries: { pu_read_query: { visible: true, permission: "allow" } },
      },
      permission: { pu_read_query: "allow" },
      options: {
        __agentSystemMode: "replace",
        __agentInstructions: { mode: "manual", files: ["AGENTS.md"] },
        __agentTools: {
          mode: "explicit",
          entries: { pu_read_query: { visible: true, permission: "allow" } },
        },
      },
    })
  })

  test("rejects malformed structured markdown during project config loading", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "agents"), { recursive: true })
    await Bun.write(
      path.join(tmp.path, "agents", "invalid.md"),
      `---
tools:
  mode: explicit
  entries:
    bash: true
---
`,
    )

    await expect(load(tmp.path)).rejects.toThrow()
  })
})
