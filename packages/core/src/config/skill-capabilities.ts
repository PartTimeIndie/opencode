export * as ConfigSkillCapabilities from "./skill-capabilities"

import { Schema } from "effect"

export const Capability = Schema.Literals(["browser_read", "browser_write", "spawn_agent"])
export type Capability = typeof Capability.Type

/**
 * Host-owned grants keyed by the exact skill name. A skill declaration is only
 * a request; it cannot activate a capability unless the merged configuration
 * grants the same capability to that skill.
 */
export const Info = Schema.Record(Schema.String, Schema.Array(Capability))
export type Info = typeof Info.Type
