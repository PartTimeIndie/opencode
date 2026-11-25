import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { CapabilityDefinition } from "@opencode-ai/core/capability/definition"
import { Config } from "@opencode-ai/core/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigMigrateV1 } from "@opencode-ai/core/v1/config/migrate"

const decode = Schema.decodeUnknownSync(Config.Info)
const legacy = Schema.decodeUnknownSync(ConfigV1.Info)

describe("retired delegation configuration", () => {
  test("neither config dialect advertises the retired feature or capability", () => {
    for (const schema of [Config.Info, ConfigV1.Info])
      expect(JSON.stringify(Schema.toJsonSchemaDocument(schema))).not.toContain("session_orchestrator")
    expect(CapabilityDefinition.get("orchestrator")).toBeUndefined()
    expect(CapabilityDefinition.all().flatMap((entry) => entry.tools)).not.toContain("orchestrator")
  })

  test("old flags cannot reactivate execution or break compatible config loading", () => {
    const input = { experimental: { session_orchestrator: true, session_orchestrator_legacy_new_entries: "allow", tool_live_progress: false } }
    for (const config of [decode(input), decode(ConfigMigrateV1.migrate(legacy(input)))]) {
      expect(config.experimental?.tool_live_progress).toBe(false)
      expect(config.experimental).not.toHaveProperty("session_orchestrator")
      expect(config.experimental).not.toHaveProperty("session_orchestrator_legacy_new_entries")
    }
    expect(() => decode({ experimental: { tool_live_progress: "false" } })).toThrow()
    expect(() => legacy({ experimental: { tool_live_progress: "false" } })).toThrow()
  })
})
