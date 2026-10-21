import { afterEach, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigMaintenance } from "@opencode-ai/core/config/maintenance"
import { instanceBootstrapMaxFailuresPerHour, instanceBootstrapTimeoutMs } from "../../src/project/instance-store"

afterEach(() => ConfigMaintenance.publishRuntime(undefined))

test("instance bootstrap limits use loaded maintenance with environment priority", () => {
  ConfigMaintenance.publishRuntime(Schema.decodeUnknownSync(ConfigMaintenance.Info)({
    settlement_watchdog: { bootstrap_timeout_ms: 4_000, max_instance_reloads_per_hour: 2 },
  }))
  expect(instanceBootstrapTimeoutMs({})).toBe(4_000)
  expect(instanceBootstrapMaxFailuresPerHour({})).toBe(2)
  expect(instanceBootstrapTimeoutMs({ OPENCODE_SETTLEMENT_BOOTSTRAP_TIMEOUT_MS: "9000" })).toBe(9_000)
  expect(instanceBootstrapMaxFailuresPerHour({ OPENCODE_SETTLEMENT_MAX_INSTANCE_RELOADS_PER_HOUR: "5" })).toBe(5)
  expect(instanceBootstrapTimeoutMs({ OPENCODE_SETTLEMENT_BOOTSTRAP_TIMEOUT_MS: "0" })).toBe(4_000)
})
