import { afterEach, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigMaintenance } from "@opencode-ai/core/config/maintenance"
import { SettlementWatchdog } from "@opencode-ai/core/session/settlement-watchdog"

afterEach(() => ConfigMaintenance.publishRuntime(undefined))

test("runtime watchdog settings use defaults without a loaded maintenance block", () => {
  ConfigMaintenance.publishRuntime(undefined)
  expect(SettlementWatchdog.settings({})).toEqual(ConfigMaintenance.defaultWatchdog)
})

test("runtime watchdog settings apply config then valid environment overrides", () => {
  ConfigMaintenance.publishRuntime(
    Schema.decodeUnknownSync(ConfigMaintenance.Info)({
      settlement_watchdog: {
        enabled: false,
        interval_ms: 5_000,
        lease_grace_ms: 8_000,
        bootstrap_timeout_ms: 10_000,
        max_instance_reloads_per_hour: 2,
      },
    }),
  )
  expect(SettlementWatchdog.settings({})).toEqual({
    enabled: false,
    intervalMs: 5_000,
    leaseGraceMs: 8_000,
    bootstrapTimeoutMs: 10_000,
    maxInstanceReloadsPerHour: 2,
  })
  expect(SettlementWatchdog.settings({ OPENCODE_SETTLEMENT_INTERVAL_MS: "7000" }).intervalMs).toBe(7_000)
  expect(SettlementWatchdog.settings({ OPENCODE_SETTLEMENT_INTERVAL_MS: "-1" }).intervalMs).toBe(5_000)
})

test("environment disable still wins over configured enable", () => {
  ConfigMaintenance.publishRuntime(Schema.decodeUnknownSync(ConfigMaintenance.Info)({ settlement_watchdog: { enabled: true } }))
  expect(SettlementWatchdog.settings({ OPENCODE_SETTLEMENT_WATCHDOG: "0" }).enabled).toBeFalse()
})
