export * as ConfigOptimization from "./optimization"

import { Schema } from "effect"

export const Profile = Schema.Literals(["off", "safe", "speed"])
export type Profile = typeof Profile.Type

export class Features extends Schema.Class<Features>("ConfigV2.Optimization.Features")({
  core_search_limits: Schema.Boolean.pipe(Schema.optional),
  stable_tool_output_preview: Schema.Boolean.pipe(Schema.optional),
  tool_materialization_cache: Schema.Boolean.pipe(Schema.optional),
  runner_request_metrics: Schema.Boolean.pipe(Schema.optional),
  read_deduplication: Schema.Boolean.pipe(Schema.optional),
  deferred_tool_discovery: Schema.Boolean.pipe(Schema.optional),
  compact_tool_schemas: Schema.Boolean.pipe(Schema.optional),
  patch_verify_tool: Schema.Boolean.pipe(Schema.optional),
  batch_core_tools: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Deprecated: legacy request path only; no V2 effect",
  }),
  tool_read_budget: Schema.Boolean.pipe(Schema.optional),
  tool_context_compression: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Native deterministic tool-context views: compress large log/search/diff/JSON tool output for the model while storing session-owned originals",
  }),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Optimization")({
  profile: Profile.pipe(Schema.optional),
  features: Features.pipe(Schema.optional),
}) {}

export type FeatureSettings = {
  readonly core_search_limits: boolean
  readonly stable_tool_output_preview: boolean
  readonly tool_materialization_cache: boolean
  readonly runner_request_metrics: boolean
  readonly read_deduplication: boolean
  readonly deferred_tool_discovery: boolean
  readonly compact_tool_schemas: boolean
  readonly patch_verify_tool: boolean
  readonly batch_core_tools: boolean
  readonly tool_read_budget: boolean
  readonly tool_context_compression: boolean
}

export type Resolved = {
  readonly profile: Profile
  readonly features: FeatureSettings
}

type Entry = {
  readonly type: string
  readonly info?: {
    readonly optimization?: Info
  }
}

const featureNames = [
  "core_search_limits",
  "stable_tool_output_preview",
  "tool_materialization_cache",
  "runner_request_metrics",
  "read_deduplication",
  "deferred_tool_discovery",
  "compact_tool_schemas",
  "patch_verify_tool",
  "batch_core_tools",
  "tool_read_budget",
  "tool_context_compression",
] as const

const offFeatures: FeatureSettings = {
  core_search_limits: false,
  stable_tool_output_preview: false,
  tool_materialization_cache: false,
  runner_request_metrics: false,
  read_deduplication: false,
  deferred_tool_discovery: false,
  compact_tool_schemas: false,
  patch_verify_tool: false,
  batch_core_tools: false,
  tool_read_budget: false,
  tool_context_compression: false,
}

const safeFeatures: FeatureSettings = {
  ...offFeatures,
  core_search_limits: true,
  stable_tool_output_preview: true,
  runner_request_metrics: true,
  read_deduplication: true,
  compact_tool_schemas: true,
  patch_verify_tool: true,
  tool_context_compression: true,
}

const speedFeatures: FeatureSettings = {
  ...safeFeatures,
  tool_materialization_cache: true,
}

export function resolve(entries: readonly Entry[], env: Record<string, string | undefined> = process.env): Resolved {
  const documents = entries.filter((entry) => entry.type === "document")
  const configured = documents.reduce(
    (result, entry) => ({
      profile: entry.info?.optimization?.profile ?? result.profile,
      features: {
        ...result.features,
        ...(entry.info?.optimization?.features ?? {}),
      },
    }),
    {
      profile: "safe" as Profile,
      features: {} as Partial<typeof Features.Type>,
    },
  )
  const profile = parseProfile(env.OPENCODE_OPTIMIZATION_PROFILE) ?? configured.profile
  if (profile === "off") {
    // The off profile is the master opt-out: it wins even over explicit config features and env overrides.
    return { profile, features: { ...offFeatures } }
  }
  const defaults = profile === "speed" ? speedFeatures : safeFeatures
  const features = {
    ...defaults,
    ...configured.features,
    ...envFeatures(env.OPENCODE_OPTIMIZATION_FEATURES),
  }
  return {
    profile,
    features,
  }
}

function envFeatures(value: string | undefined) {
  if (!value) return {}
  // Sparse explicit mapping: absence of a token falls back to config/profile defaults.
  // A list containing only retired tokens must not silently disable newly introduced defaults.
  const enabled = new Set<string>()
  const disabled = new Set<string>()
  for (const item of value.split(",")) {
    const raw = item.trim()
    if (!raw) continue
    if (raw.startsWith("!") || raw.startsWith("--")) disabled.add(normalizeFeature(raw.replace(/^[-!]+/, "")))
    else enabled.add(normalizeFeature(raw.replace(/^[-!]+/, "")))
  }
  return Object.fromEntries(
    featureNames
      .filter((name) => enabled.has(name) || disabled.has(name))
      .map((name) => [name, enabled.has(name) && !disabled.has(name)]),
  )
}

function parseProfile(value: string | undefined): Profile | undefined {
  if (value === "off" || value === "safe" || value === "speed") return value
}

function normalizeFeature(value: string) {
  return value
    .replaceAll("-", "_")
    .replace(/[A-Z]/g, (match) => "_" + match.toLowerCase())
    .replace(/^_/, "")
}

const retiredFeatures = [
  "read_deduplication",
  "stable_tool_output_preview",
  "deferred_tool_discovery",
  "compact_tool_schemas",
  "patch_verify_tool",
  "batch_core_tools",
] as const

export class Snapshot extends Schema.Class<Snapshot>("ConfigV2.Optimization.Snapshot")({
  schemaVersion: Schema.Literal(1),
  profile: Profile,
  features: Schema.Struct({
    core_search_limits: Schema.Boolean,
    stable_tool_output_preview: Schema.Boolean,
    tool_materialization_cache: Schema.Boolean,
    runner_request_metrics: Schema.Boolean,
    read_deduplication: Schema.Boolean,
    deferred_tool_discovery: Schema.Boolean,
    compact_tool_schemas: Schema.Boolean,
    patch_verify_tool: Schema.Boolean,
    batch_core_tools: Schema.Boolean,
    tool_read_budget: Schema.Boolean,
    tool_context_compression: Schema.Boolean,
  }),
  /** Cheap comparable fingerprint of the effective snapshot; changes whenever values change. */
  revision: Schema.String,
  sources: Schema.Struct({
    profileFromEnvironment: Schema.Boolean,
    featuresFromEnvironment: Schema.Boolean,
  }),
  /** Feature names explicitly overridden through config features or environment tokens. */
  overrides: Schema.Array(Schema.String),
  /** Bounded compatibility warnings, e.g. retired feature keys present in config. */
  warnings: Schema.Array(Schema.String),
}) {}

/**
 * Server-side effective optimization snapshot: what a fresh read of the current config
 * documents plus environment would resolve to right now. No secret environment values.
 */
export function snapshot(
  configured: Info | undefined,
  env: Record<string, string | undefined> = process.env,
): Snapshot {
  const featuresInput = configured?.features
  const entries: Entry[] = configured
    ? [
          {
            type: "document",
            info: { optimization: configured },
          } as Entry,
        ]
    : []
  const resolved = resolve(entries, env)
  const explicitConfigured = Object.keys(featuresInput ?? {})
  const envValue = env.OPENCODE_OPTIMIZATION_FEATURES
  const explicitEnv = envValue
    ? envValue
        .split(",")
        .map((item) => normalizeFeature(item.trim().replace(/^[-!]+/, "")))
        .filter((item) => item.length > 0)
    : []
  const overrides = [...new Set([...explicitConfigured, ...explicitEnv])].sort()
  const warnings = retiredFeatures
    .filter((name) => explicitConfigured.includes(name) || explicitEnv.includes(name))
    .slice(0, 8)
    .map((name) => `retired feature "${name}" is accepted but has no effect`)
  const revisionPayload = JSON.stringify({ profile: resolved.profile, features: resolved.features })
  let revisionHash = 0
  for (let index = 0; index < revisionPayload.length; index++) {
    revisionHash = (revisionHash * 31 + revisionPayload.charCodeAt(index)) >>> 0
  }
  return new Snapshot({
    schemaVersion: 1,
    profile: resolved.profile,
    features: resolved.features,
    revision: `opt-${revisionHash.toString(16)}`,
    sources: {
      profileFromEnvironment: env.OPENCODE_OPTIMIZATION_PROFILE !== undefined,
      featuresFromEnvironment: envValue !== undefined,
    },
    overrides,
    warnings,
  })
}
