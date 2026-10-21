import path from "path"
import fs from "fs/promises"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { FastCheck } from "effect/testing"
import { Config } from "@opencode-ai/core/config"
import { TaskTool } from "@opencode-ai/core/tool/task"
import { ConfigMaintenance } from "@opencode-ai/core/config/maintenance"
import { GrowthBudgets } from "@opencode-ai/core/maintenance/growth-budgets"
import { SettlementWatchdog } from "@opencode-ai/core/session/settlement-watchdog"
import { ConfigCapabilities } from "@opencode-ai/core/config/capabilities"
import { ConfigMultiAgent } from "@opencode-ai/core/config/multi-agent"
import { ConfigOptimization } from "@opencode-ai/core/config/optimization"
import { ConfigProvider } from "@opencode-ai/core/config/provider"
import { ConfigStorageCleanup } from "@opencode-ai/core/config/storage-cleanup"
import { ConfigMigrateV1 } from "@opencode-ai/core/v1/config/migrate"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { Policy } from "@opencode-ai/core/policy"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

test("preserves arbitrary plugin workflow settings and supports unlimited host coordination", () => {
  const input = {
    unlimited: true,
    max_threads: 300,
    max_depth: 128,
    review: { reviewers: [{ model: "provider/old" }] },
    problem_solver: { reviewers: [{ model: "provider/other" }] },
    neutral: { reviewers: [{ model: "provider/new", variant: "high" }] },
  }
  const active = Schema.decodeUnknownSync(ConfigMultiAgent.Info)(input)
  expect(Schema.encodeSync(ConfigMultiAgent.Info)(active)).toEqual(input)
  expect(ConfigMultiAgent.resolveReviewers({ skillKey: "neutral", active })).toMatchObject({
    ok: true,
    configuredPath: "multi_agent.neutral.reviewers",
    configuredReviewers: input.neutral.reviewers,
  })
  for (const invalid of [
    { max_threads: 0 },
    { max_depth: 0 },
    { neutral: 3 },
    { neutral: { reviewers: [{ model: 3 }] } },
  ])
    expect(() => Schema.decodeUnknownSync(ConfigMultiAgent.Info)(invalid)).toThrow()
})

test("accepts host-owned skill_capabilities in v1 project config and migrates them", () => {
  const v1 = Schema.decodeUnknownSync(ConfigV1.Info)({
    skill_capabilities: { "spawn-new-agent": ["spawn_agent"] },
  })
  const migrated = ConfigMigrateV1.migrate(v1)
  expect(migrated.skill_capabilities).toEqual({ "spawn-new-agent": ["spawn_agent"] })
  const v2 = Schema.decodeUnknownSync(Config.Info)(migrated, { errors: "all" })
  expect(v2.skill_capabilities).toEqual({ "spawn-new-agent": ["spawn_agent"] })
})

test("roadmap capabilities are reversible and disabled by default", () => {
  expect(ConfigCapabilities.resolve([])).toEqual({
    guarded_mutations: false,
    lsp_tools: false,
    structural_outline: false,
    reviewed_memory: false,
    dap: false,
    isolated_workspaces: false,
  })
  expect(
    ConfigCapabilities.resolve([
      new Config.Document({
        type: "document",
        info: new Config.Info({
          capabilities: new ConfigCapabilities.Info({
            guarded_mutations: true,
            lsp_tools: true,
            isolated_workspaces: true,
          }),
        }),
      }),
      new Config.Document({
        type: "document",
        info: new Config.Info({
          capabilities: new ConfigCapabilities.Info({ lsp_tools: false, reviewed_memory: true }),
        }),
      }),
    ]),
  ).toEqual({
    guarded_mutations: true,
    lsp_tools: false,
    structural_outline: false,
    reviewed_memory: true,
    dap: false,
    isolated_workspaces: true,
  })
})

test("v1 session turn completion preserves a configured model variant", () => {
  const info = Schema.decodeUnknownSync(ConfigV1.Info)({
    session: {
      turn_completion: {
        enabled: true,
        model: "openai/gpt-5.6-sol",
        variant: "high",
      },
    },
  })
  expect(info.session?.turn_completion?.variant).toBe("high")
})

test("storage cleanup config migrates with safe defaults", () => {
  const v1 = Schema.decodeUnknownSync(ConfigV1.Info)({
    storage_cleanup: {
      enabled: false,
      snapshot_retention_days: 45,
      compaction_backup_retention_days: 90,
      snapshot_max_bytes: 1024,
      check_interval_hours: 48,
    },
  })
  const migrated = ConfigMigrateV1.migrate(v1)
  const v2 = Schema.decodeUnknownSync(Config.Info)(migrated, { errors: "all" })

  expect(v2.storage_cleanup).toEqual(v1.storage_cleanup)
  expect(ConfigStorageCleanup.resolve()).toEqual({
    enabled: true,
    snapshotRetentionDays: 30,
    compactionBackupRetentionDays: 60,
    snapshotMaxBytes: 10 * 1024 * 1024 * 1024,
    checkIntervalHours: 24,
  })
})

test.each([
  ["snapshot_retention_days", 0],
  ["snapshot_retention_days", -1],
  ["snapshot_retention_days", 1.5],
  ["compaction_backup_retention_days", 0],
  ["check_interval_hours", 0],
  ["check_interval_hours", 23],
  ["snapshot_max_bytes", 0],
] as const)("storage cleanup rejects invalid %s=%s", (key, value) => {
  expect(() => Schema.decodeUnknownSync(ConfigV1.Info)({ storage_cleanup: { [key]: value } })).toThrow()
  expect(() => Schema.decodeUnknownSync(Config.Info)({ storage_cleanup: { [key]: value } })).toThrow()
})

test("optimization config defaults to the safe profile", () => {
  expect(ConfigOptimization.resolve([], {})).toEqual({
    profile: "safe",
    features: {
      core_search_limits: true,
      stable_tool_output_preview: true,
      tool_materialization_cache: false,
      runner_request_metrics: true,
      read_deduplication: true,
      deferred_tool_discovery: false,
      compact_tool_schemas: true,
      patch_verify_tool: true,
      batch_core_tools: false,
      tool_read_budget: false,
      tool_context_compression: true,
    },
  })
})

test("tool read budgets stay off for every profile unless explicitly enabled", () => {
  for (const profile of ["off", "safe", "speed"] as const) {
    expect(ConfigOptimization.resolve([], { OPENCODE_OPTIMIZATION_PROFILE: profile }).features.tool_read_budget).toBe(
      false,
    )
  }
  expect(
    ConfigOptimization.resolve([
      new Config.Document({
        type: "document",
        info: new Config.Info({
          optimization: new ConfigOptimization.Info({
            features: new ConfigOptimization.Features({ tool_read_budget: true }),
          }),
        }),
      }),
    ]).features.tool_read_budget,
  ).toBe(true)
})

test("optimization config resolves profile defaults and env feature overrides", () => {
  expect(
    ConfigOptimization.resolve(
      [
        new Config.Document({
          type: "document",
          info: new Config.Info({
            optimization: new ConfigOptimization.Info({
              profile: "safe",
              features: new ConfigOptimization.Features({ tool_materialization_cache: true }),
            }),
          }),
        }),
      ],
      { OPENCODE_OPTIMIZATION_FEATURES: "core-search-limits,runner_request_metrics" },
    ),
  ).toEqual({
    profile: "safe",
    features: {
      core_search_limits: true,
      stable_tool_output_preview: true,
      tool_materialization_cache: true,
      runner_request_metrics: true,
      read_deduplication: true,
      deferred_tool_discovery: false,
      compact_tool_schemas: true,
      patch_verify_tool: true,
      batch_core_tools: false,
      tool_read_budget: false,
      tool_context_compression: true,
    },
  })
})

test("env feature lists are sparse: retired-only lists keep new defaults and explicit negation disables", () => {
  const retiredOnly = ConfigOptimization.resolve([], { OPENCODE_OPTIMIZATION_FEATURES: "deferred_tool_discovery" })
  expect(retiredOnly.features.tool_context_compression).toBe(true)
  expect(retiredOnly.features.deferred_tool_discovery).toBe(true)

  const explicitOff = ConfigOptimization.resolve([], { OPENCODE_OPTIMIZATION_FEATURES: "--tool-context-compression" })
  expect(explicitOff.features.tool_context_compression).toBe(false)

  const negated = ConfigOptimization.resolve([], { OPENCODE_OPTIMIZATION_FEATURES: "!tool_context_compression" })
  expect(negated.features.tool_context_compression).toBe(false)

  const offProfile = ConfigOptimization.resolve(
    [
      new Config.Document({
        type: "document",
        info: new Config.Info({
          optimization: new ConfigOptimization.Info({
            features: new ConfigOptimization.Features({ tool_context_compression: true }),
          }),
        }),
      }),
    ],
    { OPENCODE_OPTIMIZATION_PROFILE: "off" },
  )
  expect(offProfile.features.tool_context_compression).toBe(false)
})

test("speed profile only activates tool_materialization_cache beyond safe; retired extras stay false", () => {
  const speed = ConfigOptimization.resolve([], { OPENCODE_OPTIMIZATION_PROFILE: "speed" })
  const safe = ConfigOptimization.resolve([], {})
  expect(speed.features.tool_materialization_cache).toBe(true)
  expect(speed.features.deferred_tool_discovery).toBe(false)
  expect(speed.features.batch_core_tools).toBe(false)
  for (const key of Object.keys(speed.features) as (keyof ConfigOptimization.FeatureSettings)[]) {
    const expected = key === "tool_materialization_cache" ? true : safe.features[key]
    expect(speed.features[key]).toBe(expected)
  }
  // retired keys stay settable through config/env without changing profile defaults
  const retiredEnabled = ConfigOptimization.resolve(
    [
      new Config.Document({
        type: "document",
        info: new Config.Info({
          optimization: new ConfigOptimization.Info({
            profile: "speed",
            features: new ConfigOptimization.Features({ deferred_tool_discovery: true }),
          }),
        }),
      }),
    ],
    { OPENCODE_OPTIMIZATION_FEATURES: "batch_core_tools" },
  )
  expect(retiredEnabled.profile).toBe("speed")
  expect(retiredEnabled.features.deferred_tool_discovery).toBe(true)
  expect(retiredEnabled.features.batch_core_tools).toBe(true)
})

test("off profile forces every feature false despite config features and env overrides", () => {
  const resolved = ConfigOptimization.resolve(
    [
      new Config.Document({
        type: "document",
        info: new Config.Info({
          optimization: new ConfigOptimization.Info({
            profile: "off",
            features: new ConfigOptimization.Features({
              core_search_limits: true,
              tool_context_compression: true,
              tool_read_budget: true,
              tool_materialization_cache: true,
            }),
          }),
        }),
      }),
    ],
    {
      OPENCODE_OPTIMIZATION_PROFILE: "off",
      OPENCODE_OPTIMIZATION_FEATURES: "core_search_limits,tool_context_compression,!runner_request_metrics",
    },
  )
  expect(resolved.profile).toBe("off")
  expect(resolved.features).toEqual(ConfigOptimization.resolve([], { OPENCODE_OPTIMIZATION_PROFILE: "off" }).features)
  for (const value of Object.values(resolved.features)) {
    expect(value).toBe(false)
  }
})

test("optimization snapshot reports the effective server state with sources and warnings", () => {
  const empty = ConfigOptimization.snapshot(undefined, {})
  expect(empty.schemaVersion).toBe(1)
  expect(empty.profile).toBe("safe")
  expect(empty.features.tool_context_compression).toBe(true)
  expect(empty.sources).toEqual({ profileFromEnvironment: false, featuresFromEnvironment: false })
  expect(empty.warnings).toEqual([])

  const profileOnly = ConfigOptimization.snapshot(new ConfigOptimization.Info({ profile: "speed" }), {})
  expect(profileOnly.profile).toBe("speed")
  expect(profileOnly.features.tool_materialization_cache).toBe(true)

  const configured = new ConfigOptimization.Info({
    profile: "speed",
    features: new ConfigOptimization.Features({
      tool_context_compression: false,
      batch_core_tools: true,
      deferred_tool_discovery: true,
    }),
  })
  const snap = ConfigOptimization.snapshot(configured, {})
  expect(snap.profile).toBe("speed")
  expect(snap.features.tool_context_compression).toBe(false)
  expect(snap.overrides).toContain("tool_context_compression")
  expect(snap.warnings.some((warning) => warning.includes("batch_core_tools"))).toBe(true)
  expect(snap.warnings.some((warning) => warning.includes("deferred_tool_discovery"))).toBe(true)
  expect(snap.warnings.length).toBeLessThanOrEqual(8)

  // the revision changes when effective values change and stays stable otherwise
  expect(ConfigOptimization.snapshot(configured, {}).revision).toBe(snap.revision)
  const flipped = ConfigOptimization.snapshot(
    new ConfigOptimization.Info({
      profile: "speed",
      features: new ConfigOptimization.Features({ tool_context_compression: true }),
    }),
    {},
  )
  expect(flipped.revision).not.toBe(snap.revision)

  // environment sources are reported without secret values
  const envSnap = ConfigOptimization.snapshot(undefined, {
    OPENCODE_OPTIMIZATION_PROFILE: "off",
    OPENCODE_OPTIMIZATION_FEATURES: "--tool_context_compression",
  })
  expect(envSnap.profile).toBe("off")
  expect(envSnap.features.tool_context_compression).toBe(false)
  expect(envSnap.sources).toEqual({ profileFromEnvironment: true, featuresFromEnvironment: true })
  expect(JSON.stringify(envSnap)).not.toContain("process.env")
})

test("multi-agent reviewer resolver prefers explicit request then active config then injected snapshot", () => {
  const injectedReviewers = [{ model: "cursor/default" }]
  const active = Schema.decodeUnknownSync(ConfigMultiAgent.Info)({
    review: new ConfigMultiAgent.Skill({
      reviewers: [
        new ConfigMultiAgent.Reviewer({ model: "openai/gpt-5.5", variant: "high" }),
        new ConfigMultiAgent.Reviewer({ model: "opencode/deepseek-v4-flash-free" }),
      ],
    }),
    problem_solver: new ConfigMultiAgent.Skill({
      reviewers: [new ConfigMultiAgent.Reviewer({ model: "zhipuai-coding-plan/glm-5.2" })],
    }),
  })

  expect(
    ConfigMultiAgent.resolveReviewers({
      skillKey: "review",
      active,
      requestedReviewers: [{ model: "opencode/nemotron-3-ultra-free", variant: "low" }],
      injectedReviewers,
    }),
  ).toEqual({
    ok: true,
    reviewers: [{ model: "opencode/nemotron-3-ultra-free", variant: "low" }],
    configuredReviewers: [
      new ConfigMultiAgent.Reviewer({ model: "openai/gpt-5.5", variant: "high" }),
      new ConfigMultiAgent.Reviewer({ model: "opencode/deepseek-v4-flash-free" }),
    ],
    source: "user override",
    configuredPath: "multi_agent.review.reviewers",
    changedFromInjected: true,
  })

  expect(ConfigMultiAgent.resolveReviewers({ skillKey: "review", active, injectedReviewers })).toEqual({
    ok: true,
    reviewers: [
      new ConfigMultiAgent.Reviewer({ model: "openai/gpt-5.5", variant: "high" }),
      new ConfigMultiAgent.Reviewer({ model: "opencode/deepseek-v4-flash-free" }),
    ],
    configuredReviewers: [
      new ConfigMultiAgent.Reviewer({ model: "openai/gpt-5.5", variant: "high" }),
      new ConfigMultiAgent.Reviewer({ model: "opencode/deepseek-v4-flash-free" }),
    ],
    source: "active config",
    configuredPath: "multi_agent.review.reviewers",
    changedFromInjected: true,
  })

  expect(ConfigMultiAgent.resolveReviewers({ skillKey: "problem_solver", active, injectedReviewers })).toEqual({
    ok: true,
    reviewers: [new ConfigMultiAgent.Reviewer({ model: "zhipuai-coding-plan/glm-5.2" })],
    configuredReviewers: [new ConfigMultiAgent.Reviewer({ model: "zhipuai-coding-plan/glm-5.2" })],
    source: "active config",
    configuredPath: "multi_agent.problem_solver.reviewers",
    changedFromInjected: true,
  })

  expect(ConfigMultiAgent.resolveReviewers({ skillKey: "review", injectedReviewers })).toEqual({
    ok: true,
    reviewers: injectedReviewers,
    configuredReviewers: [],
    source: "injected snapshot",
    configuredPath: "multi_agent.review.reviewers",
    changedFromInjected: false,
  })

  expect(ConfigMultiAgent.resolveReviewers({ skillKey: "review", active })).toEqual({
    ok: true,
    reviewers: [
      new ConfigMultiAgent.Reviewer({ model: "openai/gpt-5.5", variant: "high" }),
      new ConfigMultiAgent.Reviewer({ model: "opencode/deepseek-v4-flash-free" }),
    ],
    configuredReviewers: [
      new ConfigMultiAgent.Reviewer({ model: "openai/gpt-5.5", variant: "high" }),
      new ConfigMultiAgent.Reviewer({ model: "opencode/deepseek-v4-flash-free" }),
    ],
    source: "active config",
    configuredPath: "multi_agent.review.reviewers",
    changedFromInjected: false,
  })
})

test("empty tool reviewer overrides use Settings for both multi-agent modes", () => {
  const reviewers = [new ConfigMultiAgent.Reviewer({ model: "configured/reviewer" })]
  const active = Schema.decodeUnknownSync(ConfigMultiAgent.Info)({
    review: new ConfigMultiAgent.Skill({ reviewers }),
    problem_solver: new ConfigMultiAgent.Skill({ reviewers }),
  })
  for (const skillKey of ["review", "problem_solver"] as const) {
    expect(
      ConfigMultiAgent.resolveReviewers({ skillKey, active, requestedReviewers: [], injectedReviewers: [] }),
    ).toEqual({
      ok: true,
      reviewers,
      configuredReviewers: reviewers,
      source: "active config",
      configuredPath: `multi_agent.${skillKey}.reviewers`,
      changedFromInjected: false,
    })
  }
})

test("empty overrides cannot hide invalid Settings or invent a reviewer", () => {
  expect(
    ConfigMultiAgent.resolveReviewers({
      skillKey: "review",
      requestedReviewers: [],
      active: Schema.decodeUnknownSync(ConfigMultiAgent.Info)({
        review: new ConfigMultiAgent.Skill({ reviewers: [] }),
      }),
      injectedReviewers: [{ model: "snapshot/reviewer" }],
    }),
  ).toMatchObject({ ok: false, reason: "No valid active config reviewers found for multi_agent.review.reviewers" })
  expect(
    ConfigMultiAgent.resolveReviewers({ skillKey: "review", requestedReviewers: [], injectedReviewers: [] }),
  ).toMatchObject({ ok: false, reason: "No reviewers found for multi_agent.review.reviewers" })
  expect(
    ConfigMultiAgent.resolveReviewers({
      skillKey: "review",
      requestedReviewers: [],
      injectedReviewers: [{ model: "snapshot/reviewer" }],
    }),
  ).toMatchObject({ ok: true, source: "injected snapshot", configuredReviewers: [] })
})

test("multi-agent workflows do not invent default worker models", () => {
  expect(ConfigMultiAgent.resolveReviewers({ skillKey: "neutral" })).toMatchObject({
    ok: false,
    configuredPath: "multi_agent.neutral.reviewers",
  })
})

test("multi-agent problem solver reviewer resolver uses active config over stale injected settings", () => {
  const injectedReviewers = [
    { model: "openai/gpt-5.5", variant: "high" },
    { model: "zhipuai-coding-plan/glm-5.2" },
    { model: "cursor/default" },
  ]
  const active = Schema.decodeUnknownSync(ConfigMultiAgent.Info)({
    problem_solver: new ConfigMultiAgent.Skill({
      reviewers: [
        new ConfigMultiAgent.Reviewer({ model: "openai/gpt-5.5", variant: "high" }),
        new ConfigMultiAgent.Reviewer({ model: "zhipuai-coding-plan/glm-5.2" }),
        new ConfigMultiAgent.Reviewer({ model: "cursor/default" }),
        new ConfigMultiAgent.Reviewer({ model: "openrouter/openrouter/auto" }),
      ],
    }),
  })

  expect(ConfigMultiAgent.resolveReviewers({ skillKey: "problem_solver", active, injectedReviewers })).toEqual({
    ok: true,
    reviewers: [
      new ConfigMultiAgent.Reviewer({ model: "openai/gpt-5.5", variant: "high" }),
      new ConfigMultiAgent.Reviewer({ model: "zhipuai-coding-plan/glm-5.2" }),
      new ConfigMultiAgent.Reviewer({ model: "cursor/default" }),
      new ConfigMultiAgent.Reviewer({ model: "openrouter/openrouter/auto" }),
    ],
    configuredReviewers: [
      new ConfigMultiAgent.Reviewer({ model: "openai/gpt-5.5", variant: "high" }),
      new ConfigMultiAgent.Reviewer({ model: "zhipuai-coding-plan/glm-5.2" }),
      new ConfigMultiAgent.Reviewer({ model: "cursor/default" }),
      new ConfigMultiAgent.Reviewer({ model: "openrouter/openrouter/auto" }),
    ],
    source: "active config",
    configuredPath: "multi_agent.problem_solver.reviewers",
    changedFromInjected: true,
  })
})

test("multi-agent reviewer resolver rejects empty reviewer entries instead of inventing defaults", () => {
  expect(
    ConfigMultiAgent.resolveReviewers({
      skillKey: "review",
      requestedReviewers: [{ model: "" }],
    }),
  ).toEqual({
    ok: false,
    reason: "No valid user override reviewers found for multi_agent.review.reviewers",
    configuredPath: "multi_agent.review.reviewers",
  })

  expect(
    ConfigMultiAgent.resolveReviewers({
      skillKey: "review",
      active: Schema.decodeUnknownSync(ConfigMultiAgent.Info)({
        review: new ConfigMultiAgent.Skill({
          reviewers: [new ConfigMultiAgent.Reviewer({ model: "openai/gpt-5.5" })],
        }),
      }),
      requestedReviewers: [{ model: "" }],
    }),
  ).toEqual({
    ok: false,
    reason: "No valid user override reviewers found for multi_agent.review.reviewers",
    configuredPath: "multi_agent.review.reviewers",
  })
})

function testLayer(
  directory: string,
  globalDirectory = path.join(directory, "global"),
  projectDirectory = directory,
  vcs?: Project.Vcs,
) {
  return Config.locationLayer.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Global.layerWith({ config: globalDirectory })),
    Layer.provide(
      Layer.succeed(
        Location.Service,
        Location.Service.of(
          location(
            { directory: AbsolutePath.make(directory) },
            { projectDirectory: AbsolutePath.make(projectDirectory), vcs },
          ),
        ),
      ),
    ),
  )
}

const provider = {
  api: { type: "native", settings: {} },
  request: {
    headers: {},
    body: {},
  },
  models: {},
}

describe("Config", () => {
  it.effect("returns the latest defined scalar from priority-ordered documents", () =>
    Effect.sync(() => {
      const entries = [
        new Config.Document({ type: "document", info: new Config.Info({ model: "openrouter/openai/gpt-5" }) }),
        new Config.Directory({ type: "directory", path: AbsolutePath.make("/skills") }),
        new Config.Document({ type: "document", info: new Config.Info({}) }),
        new Config.Document({ type: "document", info: new Config.Info({ model: "openrouter/openai/gpt-5.5" }) }),
      ]

      expect(Config.latest(entries, "model")).toBe("openrouter/openai/gpt-5.5")
      expect(Config.latest(entries, "default_agent")).toBeUndefined()
    }),
  )

  it.effect("detects v1 configuration from any v1-only top-level key", () =>
    Effect.sync(() => {
      expect(ConfigMigrateV1.isV1({ snapshot: false })).toBe(true)
      expect(ConfigMigrateV1.isV1({ snapshot: false, agents: {} })).toBe(true)
      expect(ConfigMigrateV1.isV1({ reference: {} })).toBe(true)
      expect(ConfigMigrateV1.isV1({ mcp: { demo: { type: "local", command: ["demo"] } } })).toBe(true)
      expect(ConfigMigrateV1.isV1({ mcp: { demo: { enabled: false } } })).toBe(true)
      expect(ConfigMigrateV1.isV1({ mcp: { servers: { demo: { type: "local", command: ["demo"] } } } })).toBe(false)
      expect(ConfigMigrateV1.isV1({ shell: "/bin/zsh", model: "anthropic/claude" })).toBe(false)
      expect(ConfigMigrateV1.isV1({ references: {} })).toBe(false)
    }),
  )

  it.effect("migrates arbitrary v1 configuration into valid v2 configuration", () =>
    Effect.sync(() => {
      FastCheck.assert(
        FastCheck.property(Schema.toArbitrary(ConfigV1.Info), (info) => {
          Schema.decodeUnknownSync(Config.Info)(ConfigMigrateV1.migrate(info), { errors: "all" })
        }),
        { numRuns: 100 },
      )
    }),
  )

  it.effect("migrates v1 provider setup options into AISDK settings", () =>
    Effect.sync(() => {
      const migrated = ConfigMigrateV1.migrate({
        provider: {
          bedrock: {
            npm: "@ai-sdk/amazon-bedrock",
            options: {
              headers: { "x-test": "1" },
              body: { trace: true },
              region: "us-east-1",
              profile: "dev",
            },
          },
        },
      })

      expect(migrated.providers?.bedrock?.api).toEqual({
        type: "aisdk",
        package: "@ai-sdk/amazon-bedrock",
        url: undefined,
        settings: { region: "us-east-1", profile: "dev" },
      })
      expect(migrated.providers?.bedrock?.request).toEqual({
        headers: { "x-test": "1" },
        body: { trace: true },
      })
    }),
  )

  it.effect("preserves structured agent policies without leaking them into the model request body", () =>
    Effect.sync(() => {
      const info = Schema.decodeUnknownSync(ConfigV1.Info)({
        agent: {
          local: {
            model: "crng-local/gpt-oss",
            system: { mode: "replace", prompt: "Compact local prompt." },
            instructions: { mode: "manual", files: [] },
            tools: { mode: "explicit", entries: {} },
            completion: { mode: "custom", prompt: "Return done or incomplete." },
            temperature: 0.2,
          },
        },
      })

      expect(ConfigMigrateV1.migrate(info).agents?.local).toEqual({
        model: "crng-local/gpt-oss",
        variant: undefined,
        request: { body: { temperature: 0.2 } },
        system: { mode: "replace", prompt: "Compact local prompt." },
        instructions: { mode: "manual", files: [] },
        tools: { mode: "explicit", entries: {} },
        completion: { mode: "custom", prompt: "Return done or incomplete." },
        description: undefined,
        mode: undefined,
        hidden: undefined,
        color: undefined,
        steps: undefined,
        tool_budget: undefined,
        disabled: undefined,
        permissions: undefined,
      })
    }),
  )

  it.effect("migrates legacy agent switch configuration to target-scoped switch_agent rules", () =>
    Effect.sync(() => {
      const info = Schema.decodeUnknownSync(ConfigV1.Info)({
        agent: {
          local: {
            tools: {
              mode: "explicit",
              entries: { switch_to_plan: { visible: true, permission: "allow" } },
            },
            permission: {
              switch_to_plan: "allow",
              switch_agent: { plan: "deny" },
            },
          },
        },
      })
      const migrated = ConfigMigrateV1.migrate(info).agents?.local

      expect(migrated?.tools).toEqual({
        mode: "explicit",
        entries: { switch_agent: { visible: true, permission: "allow" } },
      })
      expect(migrated?.permissions).toEqual([
        { action: "switch_agent", resource: "*", effect: "deny" },
        { action: "switch_agent", resource: "plan", effect: "allow" },
        { action: "switch_agent", resource: "plan", effect: "allow" },
        { action: "switch_agent", resource: "plan", effect: "deny" },
      ])
    }),
  )

  it.effect("migrates v1 command configuration", () =>
    Effect.sync(() => {
      expect(
        ConfigMigrateV1.migrate({
          command: {
            review: {
              template: "Review changes",
              description: "Review code",
              agent: "reviewer",
              model: "anthropic/claude",
              variant: "high",
              subtask: true,
            },
          },
        }).commands,
      ).toEqual({
        review: {
          template: "Review changes",
          description: "Review code",
          agent: "reviewer",
          model: "anthropic/claude",
          variant: "high",
          subtask: true,
        },
      })
    }),
  )

  it.live("returns an empty configuration when directory files do not exist", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          const entries = yield* config.entries()

          expect(entries).toEqual([
            new Config.Directory({ type: "directory", path: AbsolutePath.make(path.join(tmp.path, "global")) }),
          ])
        }).pipe(Effect.provide(testLayer(tmp.path))),
      ),
    ),
  )

  it.live("resolves a saved six-reviewer list on the next task in the same location", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const globalDirectory = path.join(tmp.path, "global")
          yield* Effect.promise(() => fs.mkdir(globalDirectory, { recursive: true }))
          const configPath = path.join(globalDirectory, "opencode.json")
          const four = ["test/one", "test/two", "test/three", "test/four"].map((model) => ({ model }))
          const six = [...four, { model: "test/five" }, { model: "test/six" }]
          const save = (reviewers: typeof six) =>
            Effect.promise(() =>
              fs.writeFile(configPath, JSON.stringify({ multi_agent: { review: { reviewers } } })),
            )

          yield* save(four)
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const input = { skillKey: "review" }
            const beforeSave = yield* TaskTool.resolveConfiguredReviewers(config, input)
            expect(beforeSave.ok && beforeSave.reviewers.map((reviewer) => reviewer.model)).toEqual(four.map((reviewer) => reviewer.model))

            yield* save(six)
            const afterSave = yield* TaskTool.resolveConfiguredReviewers(config, input)
            expect(afterSave.ok && afterSave.source).toBe("active config")
            expect(afterSave.ok && afterSave.reviewers.map((reviewer) => reviewer.model)).toEqual(
              six.map((reviewer) => reviewer.model),
            )
          }).pipe(Effect.provide(testLayer(tmp.path, globalDirectory)))
        }),
      ),
    ),
  )

  it.live("does not use an injected reviewer snapshot when live Settings has no reviewer list", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const globalDirectory = path.join(tmp.path, "global")
          yield* Effect.promise(() => fs.mkdir(globalDirectory, { recursive: true }))
          yield* Effect.promise(() =>
            fs.writeFile(path.join(globalDirectory, "opencode.json"), JSON.stringify({ multi_agent: {} })),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const resolved = yield* TaskTool.resolveConfiguredReviewers(config, {
              skillKey: "review",
              injectedReviewers: [{ model: "stale/reviewer" }],
            })
            expect(resolved).toEqual({
              ok: false,
              reason: "No reviewers found for multi_agent.review.reviewers",
              configuredPath: "multi_agent.review.reviewers",
            })
          }).pipe(Effect.provide(testLayer(tmp.path, globalDirectory)))
        }),
      ),
    ),
  )

  it.live("loaded maintenance settings reach the process-global consumers", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "opencode.json"), JSON.stringify({
            maintenance: {
              settlement_watchdog: { enabled: false, interval_ms: 6_000, lease_grace_ms: 7_000 },
              growth_budgets: { runtime_log_max_bytes: 8192 },
            },
          })))
          yield* Config.Service.use((config) => config.entries()).pipe(Effect.provide(testLayer(tmp.path)))
          expect(SettlementWatchdog.settings({}).enabled).toBe(false)
          expect(SettlementWatchdog.settings({}).intervalMs).toBe(6_000)
          expect(SettlementWatchdog.settings({}).leaseGraceMs).toBe(7_000)
          expect(GrowthBudgets.runtimeLogMaxBytes({})).toBe(8192)
        }).pipe(Effect.ensuring(Effect.sync(() => ConfigMaintenance.publishRuntime(undefined)))),
      ),
    ),
  )

  it.live("the most recently opened location defines the process-global maintenance block", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = path.join(tmp.path, "first")
          const second = path.join(tmp.path, "second")
          yield* Effect.promise(() => fs.mkdir(first, { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(second, { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(path.join(first, "opencode.json"), JSON.stringify({
            maintenance: { settlement_watchdog: { enabled: false, interval_ms: 6_000 } },
          })))
          yield* Effect.promise(() => fs.writeFile(path.join(second, "opencode.json"), JSON.stringify({})))
          yield* Config.Service.use((config) => config.entries()).pipe(Effect.provide(testLayer(first)))
          expect(SettlementWatchdog.settings({}).enabled).toBe(false)
          // Latest-wins holder: opening a location without a maintenance block
          // republishes defaults so one project's limits never leak into another.
          yield* Config.Service.use((config) => config.entries()).pipe(Effect.provide(testLayer(second)))
          expect(SettlementWatchdog.settings({})).toEqual(ConfigMaintenance.defaultWatchdog)
          yield* Config.Service.use((config) => config.entries()).pipe(Effect.provide(testLayer(first)))
          expect(SettlementWatchdog.settings({}).intervalMs).toBe(6_000)
        }).pipe(Effect.ensuring(Effect.sync(() => ConfigMaintenance.publishRuntime(undefined)))),
      ),
    ),
  )

  it.live("loads skill_capabilities from a v1 project file and ignores unknown keys", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "opencode.json"),
              JSON.stringify({
                $schema: "https://opencode.ai/config.json",
                access_control: { mode: "approve_for_me" },
                skill_capabilities: { "spawn-new-agent": ["spawn_agent"] },
                unknown_future_key: true,
              }),
            ),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")
            expect(documents).toHaveLength(1)
            expect(documents[0]?.info.skill_capabilities).toEqual({ "spawn-new-agent": ["spawn_agent"] })
            expect(documents[0]?.info.access_control?.mode).toBe("approve_for_me")
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("loads JSON and JSONC files from lowest to highest priority", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(
                path.join(tmp.path, "config.json"),
                JSON.stringify({ $schema: "base", providers: { base: provider } }),
              ),
              fs.writeFile(
                path.join(tmp.path, "opencode.json"),
                JSON.stringify({ $schema: "middle", providers: { middle: provider } }),
              ),
              fs.writeFile(
                path.join(tmp.path, "opencode.jsonc"),
                `{
                  // Later global files override scalar fields while retaining providers.
                  "$schema": "last",
                  "providers": { "last": ${JSON.stringify(provider)} },
                }`,
              ),
            ]),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(3)
            expect(documents.map((document) => document.type)).toEqual(["document", "document", "document"])
            expect(documents.map((document) => document.info.$schema)).toEqual(["base", "middle", "last"])
            expect(documents[0]).toBeInstanceOf(Config.Document)
            expect(documents[0]?.path).toBe(path.join(tmp.path, "config.json"))
            expect(documents[2]?.info.providers?.last).toBeInstanceOf(ConfigProvider.Info)

            yield* Effect.promise(() =>
              fs.writeFile(path.join(tmp.path, "opencode.jsonc"), JSON.stringify({ $schema: "changed" })),
            )
            expect(
              (yield* config.entries())
                .filter((entry) => entry.type === "document")
                .map((document) => document.info.$schema),
            ).toEqual(["base", "middle", "last"])
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("accepts $schema metadata without writing it into config files", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "opencode.json")
          const contents = JSON.stringify({
            shell: "/bin/zsh",
            experimental: { policies: [{ effect: "deny", action: "provider.use", resource: "openai" }] },
            providers: { local: provider },
          })
          yield* Effect.promise(() => fs.writeFile(file, contents))

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents[0]?.info.$schema).toBeUndefined()
            expect(documents[0]?.info.shell).toBe("/bin/zsh")
            expect(documents[0]?.info.experimental?.policies?.[0]).toEqual({
              effect: "deny",
              action: "provider.use",
              resource: "openai",
            })
            expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(contents)
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("loads supported scalar and resource configuration", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "opencode.json"),
              JSON.stringify({
                shell: "/bin/bash",
                model: "anthropic/claude",
                default_agent: "reviewer",
                autoupdate: "notify",
                share: "disabled",
                enterprise: { url: "https://share.example.com" },
                username: "test-user",
                permissions: [
                  { action: "bash", resource: "*", effect: "ask" },
                  { action: "bash", resource: "git status", effect: "allow" },
                ],
                agents: {
                  reviewer: {
                    model: "openrouter/openai/gpt-5",
                    variant: "high",
                    request: {
                      headers: { "x-agent": "reviewer" },
                      body: { reasoningEffort: "high" },
                    },
                    description: "Review changes for correctness",
                    system: "Find regressions.",
                    mode: "subagent",
                    hidden: false,
                    color: "warning",
                    steps: 12,
                    disabled: false,
                    permissions: [{ action: "edit", resource: "*", effect: "deny" }],
                  },
                },
                snapshots: false,
                watcher: { ignore: ["node_modules/**", "dist/**", ".git"] },
                formatter: {
                  prettier: { disabled: true },
                  custom: { command: ["custom-fmt", "$FILE"], extensions: [".foo"] },
                },
                lsp: { typescript: { disabled: true }, custom: { command: ["custom-lsp"], extensions: [".foo"] } },
                attachments: {
                  image: { auto_resize: false, max_width: 1200, max_height: 900, max_base64_bytes: 1048576 },
                },
                tool_output: { max_lines: 1000, max_bytes: 32768 },
                mcp: {
                  timeout: 5000,
                  servers: {
                    local: {
                      type: "local",
                      command: ["node", "./mcp/server.js"],
                      environment: { API_KEY: "secret" },
                      disabled: false,
                      timeout: 10000,
                    },
                    remote: {
                      type: "remote",
                      url: "https://mcp.example.com/mcp",
                      headers: { Authorization: "Bearer token" },
                      oauth: { client_id: "client", scope: "read write", callback_port: 19876 },
                      disabled: true,
                    },
                  },
                },
                compaction: {
                  auto: true,
                  prune: false,
                  keep: { tokens: 2000 },
                  buffer: 10000,
                },
                optimization: {
                  profile: "speed",
                  features: {
                    core_search_limits: true,
                    stable_tool_output_preview: true,
                    tool_materialization_cache: true,
                    runner_request_metrics: true,
                    read_deduplication: true,
                  },
                },
                multi_agent: {
                  review: {
                    reviewers: [
                      { model: "openai/gpt-5.5", variant: "high" },
                      { model: "opencode/deepseek-v4-flash-free" },
                    ],
                  },
                  problem_solver: {
                    reviewers: [{ model: "opencode/nemotron-3-ultra-free", variant: "low" }],
                  },
                },
                skills: ["./skills", "~/shared-skills", "https://example.com/.well-known/skills/"],
                instructions: ["CONTRIBUTING.md", ".cursor/rules/*.md", "https://example.com/shared-rules.md"],
                references: {
                  local: { path: "../library" },
                  sdk: { repository: "github.com/example/sdk", branch: "main" },
                  shorthand: "github.com/example/docs",
                },
                plugins: [
                  "opencode-helicone-session",
                  { package: "@my-org/audit-plugin", options: { endpoint: "https://audit.example.com" } },
                ],
              }),
            ),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(1)
            expect(documents[0]?.info.shell).toBe("/bin/bash")
            expect(documents[0]?.info.model).toBe("anthropic/claude")
            expect(documents[0]?.info.default_agent).toBe("reviewer")
            expect(documents[0]?.info.autoupdate).toBe("notify")
            expect(documents[0]?.info.share).toBe("disabled")
            expect(documents[0]?.info.enterprise).toEqual({ url: "https://share.example.com" })
            expect(documents[0]?.info.username).toBe("test-user")
            expect(documents[0]?.info.permissions).toEqual([
              { action: "bash", resource: "*", effect: "ask" },
              { action: "bash", resource: "git status", effect: "allow" },
            ])
            const reviewer = documents[0]?.info.agents?.reviewer
            expect(reviewer?.model).toBe("openrouter/openai/gpt-5")
            expect(reviewer?.variant).toBe("high")
            expect(reviewer?.request).toEqual({
              headers: { "x-agent": "reviewer" },
              body: { reasoningEffort: "high" },
            })
            expect(reviewer?.description).toBe("Review changes for correctness")
            expect(reviewer?.system).toBe("Find regressions.")
            expect(reviewer?.mode).toBe("subagent")
            expect(reviewer?.hidden).toBe(false)
            expect(reviewer?.color).toBe("warning")
            expect(reviewer?.steps).toBe(12)
            expect(reviewer?.disabled).toBe(false)
            expect(reviewer?.permissions).toEqual([{ action: "edit", resource: "*", effect: "deny" }])
            expect(documents[0]?.info.multi_agent).toEqual(
              Schema.decodeUnknownSync(ConfigMultiAgent.Info)({
                review: new ConfigMultiAgent.Skill({
                  reviewers: [
                    new ConfigMultiAgent.Reviewer({ model: "openai/gpt-5.5", variant: "high" }),
                    new ConfigMultiAgent.Reviewer({ model: "opencode/deepseek-v4-flash-free" }),
                  ],
                }),
                problem_solver: new ConfigMultiAgent.Skill({
                  reviewers: [
                    new ConfigMultiAgent.Reviewer({ model: "opencode/nemotron-3-ultra-free", variant: "low" }),
                  ],
                }),
              }),
            )
            expect(documents[0]?.info.snapshots).toBe(false)
            expect(documents[0]?.info.watcher).toEqual({ ignore: ["node_modules/**", "dist/**", ".git"] })
            expect(documents[0]?.info.formatter).toEqual({
              prettier: { disabled: true },
              custom: { command: ["custom-fmt", "$FILE"], extensions: [".foo"] },
            })
            expect(documents[0]?.info.lsp).toEqual({
              typescript: { disabled: true },
              custom: { command: ["custom-lsp"], extensions: [".foo"] },
            })
            expect(documents[0]?.info.attachments).toEqual({
              image: { auto_resize: false, max_width: 1200, max_height: 900, max_base64_bytes: 1048576 },
            })
            expect(documents[0]?.info.tool_output).toEqual({ max_lines: 1000, max_bytes: 32768 })
            expect(documents[0]?.info.mcp).toEqual({
              timeout: 5000,
              servers: {
                local: {
                  type: "local",
                  command: ["node", "./mcp/server.js"],
                  environment: { API_KEY: "secret" },
                  disabled: false,
                  timeout: 10000,
                },
                remote: {
                  type: "remote",
                  url: "https://mcp.example.com/mcp",
                  headers: { Authorization: "Bearer token" },
                  oauth: { client_id: "client", scope: "read write", callback_port: 19876 },
                  disabled: true,
                },
              },
            })
            expect(documents[0]?.info.compaction).toEqual({
              auto: true,
              prune: false,
              keep: { tokens: 2000 },
              buffer: 10000,
            })
            expect(documents[0]?.info.optimization).toEqual({
              profile: "speed",
              features: {
                core_search_limits: true,
                stable_tool_output_preview: true,
                tool_materialization_cache: true,
                runner_request_metrics: true,
                read_deduplication: true,
              },
            })
            expect(documents[0]?.info.skills).toEqual([
              "./skills",
              "~/shared-skills",
              "https://example.com/.well-known/skills/",
            ])
            expect(documents[0]?.info.instructions).toEqual([
              "CONTRIBUTING.md",
              ".cursor/rules/*.md",
              "https://example.com/shared-rules.md",
            ])
            expect(documents[0]?.info.references).toEqual({
              local: { path: "../library" },
              sdk: { repository: "github.com/example/sdk", branch: "main" },
              shorthand: "github.com/example/docs",
            })
            expect(documents[0]?.info.plugins).toEqual([
              "opencode-helicone-session",
              { package: "@my-org/audit-plugin", options: { endpoint: "https://audit.example.com" } },
            ])
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("migrates the deprecated reference key into references", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "opencode.json"),
              JSON.stringify({
                reference: {
                  local: { path: "../library" },
                  sdk: { repository: "github.com/example/sdk", branch: "main" },
                  shorthand: "github.com/example/docs",
                },
              }),
            ),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(1)
            expect(documents[0]?.info.references).toEqual({
              local: { path: "../library" },
              sdk: { repository: "github.com/example/sdk", branch: "main" },
              shorthand: "github.com/example/docs",
            })
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("migrates v1 configuration when a v1-only key is present", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "opencode.json"),
              JSON.stringify({
                shell: "/bin/zsh",
                default_agent: "reviewer",
                snapshot: false,
                autoshare: true,
                permission: {
                  bash: "ask",
                  edit: { "*.md": "allow", "*": "deny" },
                  question: "deny",
                },
                agent: {
                  reviewer: {
                    prompt: "Review changes.",
                    disable: true,
                    temperature: 0.2,
                    permission: { read: "allow" },
                  },
                },
                plugin: [
                  "opencode-helicone-session",
                  ["@my-org/audit-plugin", { endpoint: "https://audit.example.com" }],
                ],
                skills: { paths: ["./skills"], urls: ["https://example.com/.well-known/skills/"] },
                references: {
                  docs: { path: "../docs", description: "Use for product documentation", hidden: true },
                },
                attachment: { image: { auto_resize: false, max_width: 1200 } },
                provider: {
                  custom: {
                    options: { apiKey: "secret" },
                    models: {
                      model: {
                        options: { reasoningEffort: "high" },
                        variants: { fast: { temperature: 0.2 } },
                      },
                    },
                  },
                  openai: {
                    npm: "@ai-sdk/openai",
                    options: { apiKey: "secret", organization: "org" },
                    models: {
                      model: {
                        options: { temperature: 0.3, reasoningEffort: "high", serviceTier: "priority" },
                        variants: { high: { reasoningEffort: "high", reasoningSummary: "auto" } },
                      },
                    },
                  },
                  anthropic: {
                    npm: "@ai-sdk/anthropic",
                    models: {
                      model: {
                        options: {
                          effort: "high",
                          taskBudget: 4096,
                          metadata: { userId: "user-1" },
                        },
                      },
                    },
                  },
                },
                compaction: { auto: true, tail_turns: 3, preserve_recent_tokens: 2000, reserved: 10000 },
                vision: {
                  enabled: true,
                  primary: { model: "openai/gpt-5.6-sol", variant: "low" },
                  fallbacks: [{ model: "lmstudio/qwen/qwen3.6-35b-a3b" }],
                },
                experimental: { mcp_timeout: 5000 },
                mcp: {
                  local: { type: "local", command: ["node", "server.js"], enabled: false },
                  remote: {
                    type: "remote",
                    url: "https://mcp.example.com",
                    startup: "on_demand",
                    oauth: { clientId: "client", callbackPort: 19876 },
                  },
                },
              }),
            ),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(1)
            expect(documents[0]?.info).toBeInstanceOf(Config.Info)
            expect(documents[0]?.info.shell).toBe("/bin/zsh")
            expect(documents[0]?.info.default_agent).toBe("reviewer")
            expect(documents[0]?.info.snapshots).toBe(false)
            expect(documents[0]?.info.share).toBe("auto")
            expect(documents[0]?.info.permissions).toEqual([
              { action: "bash", resource: "*", effect: "ask" },
              { action: "edit", resource: "*.md", effect: "allow" },
              { action: "edit", resource: "*", effect: "deny" },
              { action: "surface", resource: "*", effect: "deny" },
            ])
            expect(documents[0]?.info.agents?.reviewer).toMatchObject({
              system: "Review changes.",
              disabled: true,
              request: { body: { temperature: 0.2 } },
              permissions: [{ action: "read", resource: "*", effect: "allow" }],
            })
            expect(documents[0]?.info.plugins).toEqual([
              "opencode-helicone-session",
              { package: "@my-org/audit-plugin", options: { endpoint: "https://audit.example.com" } },
            ])
            expect(documents[0]?.info.skills).toEqual(["./skills", "https://example.com/.well-known/skills/"])
            expect(documents[0]?.info.references).toEqual({
              docs: { path: "../docs", description: "Use for product documentation", hidden: true },
            })
            expect(documents[0]?.info.attachments).toEqual({ image: { auto_resize: false, max_width: 1200 } })
            expect(documents[0]?.info.providers?.custom).toMatchObject({
              request: { body: { apiKey: "secret" } },
              models: {
                model: {
                  request: { body: { reasoningEffort: "high" } },
                  variants: [{ id: "fast", body: { temperature: 0.2 } }],
                },
              },
            })
            expect(documents[0]?.info.providers?.openai).toMatchObject({
              api: { settings: {} },
              request: { headers: { Authorization: "Bearer secret", "OpenAI-Organization": "org" } },
              models: {
                model: {
                  request: {
                    body: { temperature: 0.3, reasoningEffort: "high", serviceTier: "priority" },
                  },
                  variants: [{ id: "high", body: { reasoningEffort: "high", reasoningSummary: "auto" } }],
                },
              },
            })
            expect(documents[0]?.info.providers?.anthropic).toMatchObject({
              models: {
                model: {
                  request: {
                    body: {
                      output_config: { effort: "high", task_budget: 4096 },
                      metadata: { user_id: "user-1" },
                    },
                  },
                },
              },
            })
            expect(documents[0]?.info.compaction).toEqual({
              auto: true,
              prune: undefined,
              keep: { tokens: 2000 },
              buffer: 10000,
            })
            expect(documents[0]?.info.vision).toEqual({
              enabled: true,
              primary: { model: "openai/gpt-5.6-sol", variant: "low" },
              fallbacks: [{ model: "lmstudio/qwen/qwen3.6-35b-a3b" }],
            })
            expect(documents[0]?.info.mcp).toMatchObject({
              timeout: 5000,
              servers: {
                local: { type: "local", command: ["node", "server.js"], disabled: true },
                remote: {
                  type: "remote",
                  url: "https://mcp.example.com",
                  startup: "on_demand",
                  oauth: { client_id: "client", callback_port: 19876 },
                },
              },
            })
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("ignores invalid files while loading valid config values", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(path.join(tmp.path, "config.json"), JSON.stringify({ $schema: "base" })),
              fs.writeFile(path.join(tmp.path, "opencode.json"), "{ invalid"),
              fs.writeFile(path.join(tmp.path, "opencode.jsonc"), JSON.stringify({ providers: { invalid: true } })),
            ]),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents.map((document) => document.info.$schema)).toEqual(["base"])
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("loads policy statements in reverse config order", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.writeFile(
              path.join(global, "opencode.json"),
              JSON.stringify({
                experimental: { policies: [{ effect: "deny", action: "provider.use", resource: "openai" }] },
              }),
            )
            await fs.writeFile(
              path.join(tmp.path, "opencode.json"),
              JSON.stringify({
                experimental: { policies: [{ effect: "allow", action: "provider.use", resource: "openai" }] },
              }),
            )
          })

          return yield* Effect.gen(function* () {
            const policy = yield* Policy.Service

            expect(yield* policy.evaluate("provider.use", "openai", "allow")).toBe("deny")
          }).pipe(Effect.provide(testLayer(tmp.path, global)))
        })
      }),
    ),
  )

  test.each(["bounded", "unset", "unrelated", "prefix-lookalike", "narrower-project"] as const)(
    "isolates Core ancestor config discovery with a test root: %s",
    async (mode) => {
      await using tmp = await tmpdir()
      const global = path.join(tmp.path, "global")
      const root = path.join(tmp.path, "sandbox-sibling")
      const project = path.join(root, "repo")
      const directory = path.join(project, "app")
      await Promise.all(
        [global, directory, path.join(tmp.path, ".opencode"), path.join(project, ".opencode")].map((dir) =>
          fs.mkdir(dir, { recursive: true }),
        ),
      )
      await Promise.all([
        fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ $schema: "global" })),
        fs.writeFile(path.join(tmp.path, "opencode.json"), JSON.stringify({ $schema: "outside" })),
        fs.writeFile(path.join(root, "opencode.json"), JSON.stringify({ $schema: "root" })),
        fs.writeFile(path.join(project, "opencode.json"), JSON.stringify({ $schema: "project" })),
        fs.writeFile(path.join(directory, "opencode.json"), JSON.stringify({ $schema: "directory" })),
        fs.writeFile(
          path.join(tmp.path, ".opencode", "opencode.json"),
          JSON.stringify({
            $schema: "outside-dot",
            mcp: { servers: { outside: { type: "local", command: ["must-not-be-started"], startup: "eager" } } },
          }),
        ),
        fs.writeFile(
          path.join(project, ".opencode", "opencode.json"),
          JSON.stringify({
            $schema: "inside-dot",
            mcp: { servers: { inside: { type: "local", command: ["fixture-only"], disabled: true } } },
          }),
        ),
      ])
      const previous = process.env.OPENCODE_TEST_CONFIG_ROOT
      try {
        if (mode === "unset") delete process.env.OPENCODE_TEST_CONFIG_ROOT
        if (mode === "bounded" || mode === "narrower-project") process.env.OPENCODE_TEST_CONFIG_ROOT = root
        if (mode === "unrelated") process.env.OPENCODE_TEST_CONFIG_ROOT = path.join(tmp.path, "unrelated")
        if (mode === "prefix-lookalike") process.env.OPENCODE_TEST_CONFIG_ROOT = path.join(tmp.path, "sandbox")
        const entries = await Effect.runPromise(
          Config.Service.use((config) => config.entries()).pipe(
            Effect.provide(testLayer(directory, global, mode === "narrower-project" ? project : tmp.path)),
            Effect.scoped,
          ),
        )
        const documents = entries.filter((entry) => entry.type === "document")
        expect(documents.map((entry) => entry.info.$schema)).toEqual(
          mode === "bounded"
            ? ["global", "root", "project", "directory", "inside-dot"]
            : mode === "narrower-project"
              ? ["global", "project", "directory", "inside-dot"]
              : ["global", "outside", "root", "project", "directory", "outside-dot", "inside-dot"],
        )
        expect(documents.flatMap((entry) => Object.keys(entry.info.mcp?.servers ?? {}))).toEqual(
          mode === "bounded" || mode === "narrower-project" ? ["inside"] : ["outside", "inside"],
        )
      } finally {
        if (previous === undefined) delete process.env.OPENCODE_TEST_CONFIG_ROOT
        else process.env.OPENCODE_TEST_CONFIG_ROOT = previous
      }
    },
  )

  it.live("loads global, ancestor, and .opencode configuration up to the project boundary", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const root = path.join(tmp.path, "repo")
        const parent = path.join(root, "packages")
        const directory = path.join(parent, "app")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
            await fs.mkdir(path.join(directory, ".opencode"), { recursive: true })
            await Promise.all([
              fs.writeFile(path.join(tmp.path, "opencode.json"), JSON.stringify({ $schema: "outside" })),
              fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ $schema: "global" })),
              fs.writeFile(path.join(root, "opencode.json"), JSON.stringify({ $schema: "root" })),
              fs.writeFile(path.join(parent, "opencode.jsonc"), JSON.stringify({ $schema: "parent" })),
              fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ $schema: "directory" })),
              fs.writeFile(path.join(root, ".opencode", "opencode.json"), JSON.stringify({ $schema: "root-dot" })),
              fs.writeFile(
                path.join(directory, ".opencode", "opencode.jsonc"),
                JSON.stringify({ $schema: "directory-dot" }),
              ),
            ])
          })

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const entries = yield* config.entries()
            const documents = entries.filter((entry) => entry.type === "document")

            expect(entries.filter((entry) => entry.type === "directory").map((entry) => entry.path)).toEqual([
              AbsolutePath.make(global),
              AbsolutePath.make(path.join(root, ".opencode")),
              AbsolutePath.make(path.join(directory, ".opencode")),
            ])
            expect(documents.map((document) => document.info.$schema)).toEqual([
              "global",
              "root",
              "parent",
              "directory",
              "root-dot",
              "directory-dot",
            ])
            expect(entries.map((entry) => (entry.type === "document" ? entry.info.$schema : entry.path))).toEqual([
              "global",
              AbsolutePath.make(global),
              "root",
              "parent",
              "directory",
              "root-dot",
              AbsolutePath.make(path.join(root, ".opencode")),
              "directory-dot",
              AbsolutePath.make(path.join(directory, ".opencode")),
            ])
          }).pipe(
            Effect.provide(
              testLayer(directory, global, root, {
                type: "git",
                store: AbsolutePath.make(path.join(root, ".git")),
              }),
            ),
          )
        })
      }),
    ),
  )

  it.live("skips project configuration when project discovery is disabled", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const root = path.join(tmp.path, "repo")
        const directory = path.join(root, "packages", "app")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await Promise.all([
              fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ $schema: "global" })),
              fs.writeFile(path.join(root, "opencode.json"), JSON.stringify({ $schema: "root" })),
              fs.writeFile(path.join(root, ".opencode", "opencode.json"), JSON.stringify({ $schema: "root-dot" })),
            ])
          })

          const previousDisabled = process.env.OPENCODE_DISABLE_PROJECT_CONFIG
          const previousContent = process.env.OPENCODE_CONFIG_CONTENT
          yield* Effect.acquireUseRelease(
            Effect.sync(() => {
              process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
              process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ $schema: "environment" })
            }),
            () =>
              Effect.gen(function* () {
                const config = yield* Config.Service
                const entries = yield* config.entries()
                expect(entries.map((entry) => (entry.type === "document" ? entry.info.$schema : entry.path))).toEqual([
                  "global",
                  AbsolutePath.make(global),
                  "environment",
                ])
              }).pipe(
                Effect.provide(
                  testLayer(directory, global, root, {
                    type: "git",
                    store: AbsolutePath.make(path.join(root, ".git")),
                  }),
                ),
              ),
            () =>
              Effect.sync(() => {
                if (previousDisabled === undefined) delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
                else process.env.OPENCODE_DISABLE_PROJECT_CONFIG = previousDisabled
                if (previousContent === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
                else process.env.OPENCODE_CONFIG_CONTENT = previousContent
              }),
          )
        })
      }),
    ),
  )
})
