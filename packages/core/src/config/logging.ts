export * as ConfigLogging from "./logging"

import { Schema } from "effect"

export const Profile = Schema.Literals(["off", "safe", "verbose"])
export type Profile = typeof Profile.Type

export class Features extends Schema.Class<Features>("ConfigV2.Logging.Features")({
  trace: Schema.Boolean.pipe(Schema.optional),
  performance: Schema.Boolean.pipe(Schema.optional),
  interrupts: Schema.Boolean.pipe(Schema.optional),
  optimization: Schema.Boolean.pipe(Schema.optional),
  ui: Schema.Boolean.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Logging")({
  profile: Profile.pipe(Schema.optional),
  features: Features.pipe(Schema.optional),
}) {}

export type FeatureSettings = {
  readonly trace: boolean
  readonly performance: boolean
  readonly interrupts: boolean
  readonly optimization: boolean
  readonly ui: boolean
}

export type Resolved = {
  readonly profile: Profile
  readonly features: FeatureSettings
}

type Entry = {
  readonly type: string
  readonly info?: {
    readonly logging?: Info
  }
}

const featureNames = ["trace", "performance", "interrupts", "optimization", "ui"] as const

const offFeatures: FeatureSettings = {
  trace: false,
  performance: false,
  interrupts: false,
  optimization: false,
  ui: false,
}

const safeFeatures: FeatureSettings = {
  ...offFeatures,
  performance: true,
  optimization: true,
}

const verboseFeatures: FeatureSettings = {
  ...safeFeatures,
  trace: true,
  interrupts: true,
  ui: true,
}

export function resolve(entries: readonly Entry[], env: Record<string, string | undefined> = process.env): Resolved {
  const documents = entries.filter((entry) => entry.type === "document")
  const configured = documents.reduce(
    (result, entry) => ({
      profile: entry.info?.logging?.profile ?? result.profile,
      features: {
        ...result.features,
        ...(entry.info?.logging?.features ?? {}),
      },
    }),
    { profile: "verbose" as Profile, features: {} as Partial<FeatureSettings> },
  )
  const profile = parseProfile(env.OPENCODE_LOG_PROFILE) ?? configured.profile
  const defaults = profile === "verbose" ? verboseFeatures : profile === "safe" ? safeFeatures : offFeatures
  return {
    profile,
    features: {
      ...defaults,
      ...configured.features,
      ...envFeatures(env.OPENCODE_LOG_FEATURES),
    },
  }
}

function envFeatures(value: string | undefined) {
  if (!value) return {}
  const enabled = new Set(value.split(",").map((item) => normalizeFeature(item.trim())))
  return Object.fromEntries(featureNames.map((name) => [name, enabled.has(name)]))
}

function parseProfile(value: string | undefined): Profile | undefined {
  if (value === "off" || value === "safe" || value === "verbose") return value
}

function normalizeFeature(value: string) {
  return value.replaceAll("-", "_").replace(/[A-Z]/g, (match) => "_" + match.toLowerCase()).replace(/^_/, "")
}
