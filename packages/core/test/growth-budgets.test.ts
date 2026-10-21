import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { rotateLogFile } from "@opencode-ai/core/observability/logging"
import { GrowthBudgets } from "@opencode-ai/core/maintenance/growth-budgets"
import { ConfigMaintenance } from "@opencode-ai/core/config/maintenance"

describe("GrowthBudgets", () => {
  afterEach(() => ConfigMaintenance.publishRuntime(undefined))
  test("defaults come from the maintenance config defaults", () => {
    const budgets = GrowthBudgets.describe({})
    expect(budgets).toEqual({
      runtimeLogMaxBytes: ConfigMaintenance.defaultBudgets.runtimeLogMaxBytes,
      eventRetentionDays: ConfigMaintenance.defaultBudgets.eventRetentionDays,
      schedulerJournalMaxEntries: ConfigMaintenance.defaultBudgets.schedulerJournalMaxEntries,
      snapshotPatchMaxBytes: ConfigMaintenance.defaultBudgets.snapshotPatchMaxBytes,
      toolReplayMaxBytes: ConfigMaintenance.defaultBudgets.toolReplayMaxBytes,
    })
  })

  test("valid env overrides win per budget", () => {
    const budgets = GrowthBudgets.describe({
      OPENCODE_GROWTH_RUNTIME_LOG_MAX_BYTES: "1048576",
      OPENCODE_GROWTH_EVENT_RETENTION_DAYS: "7",
    })
    expect(budgets.runtimeLogMaxBytes).toBe(1_048_576)
    expect(budgets.eventRetentionDays).toBe(7)
    expect(budgets.schedulerJournalMaxEntries).toBe(
      ConfigMaintenance.defaultBudgets.schedulerJournalMaxEntries,
    )
  })

  test("invalid or non-positive env values fall back to defaults", () => {
    const budgets = GrowthBudgets.describe({
      OPENCODE_GROWTH_RUNTIME_LOG_MAX_BYTES: "-5",
      OPENCODE_GROWTH_SNAPSHOT_PATCH_MAX_BYTES: "huge",
    })
    expect(budgets.runtimeLogMaxBytes).toBe(ConfigMaintenance.defaultBudgets.runtimeLogMaxBytes)
    expect(budgets.snapshotPatchMaxBytes).toBe(ConfigMaintenance.defaultBudgets.snapshotPatchMaxBytes)
  })

  test("zero overrides are rejected", () => {
    const budgets = GrowthBudgets.describe({ OPENCODE_GROWTH_TOOL_REPLAY_MAX_BYTES: "0" })
    expect(budgets.toolReplayMaxBytes).toBe(ConfigMaintenance.defaultBudgets.toolReplayMaxBytes)
  })

  test("loaded log budget controls real rotation and environment takes priority", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "growth-budget-"))
    const file = path.join(directory, "runtime.log")
    try {
      ConfigMaintenance.publishRuntime(Schema.decodeUnknownSync(ConfigMaintenance.Info)({
        growth_budgets: { runtime_log_max_bytes: 4 },
      }))
      expect(GrowthBudgets.runtimeLogMaxBytes({})).toBe(4)
      expect(GrowthBudgets.runtimeLogMaxBytes({ OPENCODE_GROWTH_RUNTIME_LOG_MAX_BYTES: "8" })).toBe(8)
      await writeFile(file, "five!")
      await rotateLogFile(file)
      expect((await stat(file)).size).toBe(0)
      expect((await stat(`${file}.1`)).size).toBe(5)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
