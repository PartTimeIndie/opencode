import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "@opencode-ai/core/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigMigrateV1 } from "@opencode-ai/core/v1/config/migrate"

const decode = Schema.decodeUnknownSync(Config.Info)
const legacy = Schema.decodeUnknownSync(ConfigV1.Info)

describe("experimental session orchestrator config", () => {
  test("stays opt-in and survives V1 sidecar migration in both directions", () => {
    expect(decode({}).experimental?.session_orchestrator ?? false).toBe(false)
    for (const value of [true, false]) {
      const input = { experimental: { session_orchestrator: value } }
      expect(decode(input).experimental?.session_orchestrator).toBe(value)
      expect(decode(ConfigMigrateV1.migrate(legacy(input))).experimental?.session_orchestrator).toBe(value)
    }
  })

  test("rejects invalid known values without weakening other experimental validation", () => {
    for (const value of ["true", 1, null, {}]) {
      expect(() => decode({ experimental: { session_orchestrator: value } })).toThrow()
      expect(() => legacy({ experimental: { session_orchestrator: value } })).toThrow()
    }
    expect(decode(ConfigMigrateV1.migrate(legacy({ experimental: { policies: [] } }))).experimental?.policies).toEqual(
      [],
    )
  })
})
