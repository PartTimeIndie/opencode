export * as CapabilityDefinition from "./definition"

import type { ConfigSkillCapabilities } from "../config/skill-capabilities"

export type ID = ConfigSkillCapabilities.Capability

export type Info = {
  readonly id: ID
  readonly tools: ReadonlyArray<string>
  readonly permission: string
  readonly maxTTL: number
}

export const DEFAULT_TTL_MS = 30 * 60 * 1_000

const definitions: Readonly<Record<ID, Info>> = {
  browser_read: {
    id: "browser_read",
    tools: ["browser_snapshot", "browser_wait"],
    permission: "browser_read",
    maxTTL: DEFAULT_TTL_MS,
  },
  browser_write: {
    id: "browser_write",
    tools: ["browser_click", "browser_type", "browser_navigate"],
    permission: "browser_write",
    maxTTL: DEFAULT_TTL_MS,
  },
  spawn_agent: {
    id: "spawn_agent",
    tools: ["spawn_agent"],
    permission: "spawn_agent",
    maxTTL: DEFAULT_TTL_MS,
  },
}

export const get = (id: string): Info | undefined => definitions[id as ID]
export const all = () => Object.values(definitions)
