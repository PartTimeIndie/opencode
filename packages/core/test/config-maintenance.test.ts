import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigMaintenance } from "@opencode-ai/core/config/maintenance"
import { Config } from "@opencode-ai/core/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigMigrateV1 } from "@opencode-ai/core/v1/config/migrate"

const validMaintenance = {
  settlement_watchdog: {
    enabled: true,
    interval_ms: 15_000,
    lease_grace_ms: 30_000,
    bootstrap_timeout_ms: 45_000,
    max_instance_reloads_per_hour: 5,
  },
  growth_budgets: { runtime_log_max_bytes: 1024 },
}

describe("ConfigMaintenance", () => {
  test("accepts empty object (all fields optional)", () => {
    const result = Schema.decodeUnknownSync(ConfigMaintenance.Info)({})
    expect(result.settlement_watchdog).toBeUndefined()
    expect(result.growth_budgets).toBeUndefined()
  })

  test("accepts full config on the V2 dialect", () => {
    const result = Schema.decodeUnknownSync(Config.Info)({ maintenance: validMaintenance })
    expect(result.maintenance?.settlement_watchdog?.interval_ms).toBe(15_000)
    expect(result.maintenance?.growth_budgets?.runtime_log_max_bytes).toBe(1024)
  })

  test("accepts full config on the V1 dialect", () => {
    const result = Schema.decodeUnknownSync(ConfigV1.Info)({ maintenance: validMaintenance })
    expect(result.maintenance?.settlement_watchdog?.bootstrap_timeout_ms).toBe(45_000)
    expect(result.maintenance?.growth_budgets?.runtime_log_max_bytes).toBe(1024)
  })

  test("migrates maintenance through the V1 to V2 bridge", () => {
    const v1 = Schema.decodeUnknownSync(ConfigV1.Info)({ maintenance: validMaintenance })
    const migrated = ConfigMigrateV1.migrate(v1)
    expect(migrated.maintenance?.settlement_watchdog?.interval_ms).toBe(15_000)
    expect(migrated.maintenance?.growth_budgets?.runtime_log_max_bytes).toBe(1024)
    const v2 = Schema.decodeUnknownSync(Config.Info)(migrated)
    expect(v2.maintenance?.settlement_watchdog?.max_instance_reloads_per_hour).toBe(5)
  })

  test("rejects invalid values for known keys on both dialects", () => {
    const invalid = { maintenance: { settlement_watchdog: { interval_ms: "soon" } } }
    expect(() => Schema.decodeUnknownSync(Config.Info)(invalid)).toThrow()
    expect(() => Schema.decodeUnknownSync(ConfigV1.Info)(invalid)).toThrow()
  })

  test("inactive maintenance controls are not exposed as configurable schema fields", () => {
    const decoded = Schema.decodeUnknownSync(Config.Info)({ maintenance: {
      settlement_watchdog: { question_settle_ms: 1000 },
      growth_budgets: { enabled: false, event_retention_days: 1, runtime_log_max_bytes: 1024 },
    } })
    expect(decoded.maintenance?.settlement_watchdog).toEqual({})
    expect(decoded.maintenance?.growth_budgets).toEqual({ runtime_log_max_bytes: 1024 })
  })

  test("unknown top-level keys stay ignored alongside maintenance", () => {
    const result = Schema.decodeUnknownSync(Config.Info)({
      maintenance: validMaintenance,
      not_a_real_key: { any: "thing" },
    })
    expect(result.maintenance?.settlement_watchdog?.enabled).toBe(true)
  })

  test("resolve falls back to conservative defaults", () => {
    const resolved = ConfigMaintenance.resolve([])
    expect(resolved.watchdog).toEqual(ConfigMaintenance.defaultWatchdog)
    expect(resolved.growthBudgets).toEqual(ConfigMaintenance.defaultBudgets)
  })

  test("resolve applies configured overrides and keeps defaults for the rest", () => {
    const resolved = ConfigMaintenance.resolve([
      { type: "document", info: { maintenance: { settlement_watchdog: { interval_ms: 5_000 } } } },
    ])
    expect(resolved.watchdog.intervalMs).toBe(5_000)
    expect(resolved.watchdog.leaseGraceMs).toBe(ConfigMaintenance.defaultWatchdog.leaseGraceMs)
    expect(resolved.growthBudgets).toEqual(ConfigMaintenance.defaultBudgets)
  })

  test("resolve uses the newest document carrying maintenance", () => {
    const resolved = ConfigMaintenance.resolve([
      { type: "document", info: { maintenance: { settlement_watchdog: { interval_ms: 5_000 } } } },
      { type: "document", info: { maintenance: { settlement_watchdog: { interval_ms: 9_000 } } } },
    ])
    expect(resolved.watchdog.intervalMs).toBe(9_000)
  })
})
