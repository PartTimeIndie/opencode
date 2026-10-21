export * as CapabilityLease from "./lease"

import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { AgentV2 } from "../agent"
import { Config } from "../config"
import { ConfigSkillCapabilities } from "../config/skill-capabilities"
import { SessionSchema } from "../session/schema"
import { SkillV2 } from "../skill"
import { CapabilityDefinition } from "./definition"

export type Lease = {
  readonly id: string
  readonly capability: CapabilityDefinition.ID
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly skill: string
  readonly generation: number
  readonly issuedAt: number
  readonly expiresAt: number
}

export type Snapshot = Readonly<Record<string, number>>

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("CapabilityLease.DeniedError", {
  skill: Schema.String,
  capability: Schema.String,
  message: Schema.String,
}) {}

export interface Interface {
  readonly activate: (input: {
    readonly sessionID: SessionSchema.ID
    readonly agent: AgentV2.ID
    readonly skill: string
    readonly requested: ReadonlyArray<string>
  }) => Effect.Effect<ReadonlyArray<Lease>, DeniedError>
  readonly snapshot: (sessionID: SessionSchema.ID, agent: AgentV2.ID) => Effect.Effect<Snapshot>
  readonly valid: (
    sessionID: SessionSchema.ID,
    agent: AgentV2.ID,
    capability: string,
    generation?: number,
  ) => Effect.Effect<boolean>
  readonly revoke: (sessionID: SessionSchema.ID, agent: AgentV2.ID, capability?: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/CapabilityLease") {}

const key = (sessionID: SessionSchema.ID, agent: AgentV2.ID, capability: string) =>
  `${sessionID}\0${agent}\0${capability}`

export const makeLayer = (now: () => number = Date.now) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const grants = (yield* config.entries())
        .filter((entry): entry is Config.Document => entry.type === "document")
        .reduce<ConfigSkillCapabilities.Info>(
          (result, entry) => ({ ...result, ...(entry.info.skill_capabilities ?? {}) }),
          {},
        )
      const leases = new Map<string, Lease>()
      let generation = 0

      const current = (sessionID: SessionSchema.ID, agent: AgentV2.ID, capability: string) => {
        const lease = leases.get(key(sessionID, agent, capability))
        if (!lease) return
        if (lease.expiresAt > now()) return lease
        leases.delete(key(sessionID, agent, capability))
      }

      return Service.of({
        activate: Effect.fn("CapabilityLease.activate")(function* (input) {
          const allowed = new Set(grants[input.skill] ?? [])
          const requested = [...new Set(input.requested)]
          for (const capability of requested) {
            if (!CapabilityDefinition.get(capability))
              return yield* new DeniedError({
                skill: input.skill,
                capability,
                message: `Skill '${input.skill}' requested unknown capability '${capability}'`,
              })
          }
          const authorized = requested.filter((capability) =>
            allowed.has(capability as ConfigSkillCapabilities.Capability),
          )
          if (requested.length > 0 && authorized.length === 0)
            return yield* new DeniedError({
              skill: input.skill,
              capability: requested[0]!,
              message: `Skill '${input.skill}' is not authorized to activate its requested capabilities`,
            })
          const issuedAt = now()
          return authorized.map((capability) => {
            const definition = CapabilityDefinition.get(capability)!
            const lease: Lease = {
              id: randomUUID(),
              capability: definition.id,
              sessionID: input.sessionID,
              agent: input.agent,
              skill: input.skill,
              generation: ++generation,
              issuedAt,
              expiresAt: issuedAt + definition.maxTTL,
            }
            leases.set(key(input.sessionID, input.agent, capability), lease)
            return lease
          })
        }),
        snapshot: Effect.fn("CapabilityLease.snapshot")(function* (sessionID, agent) {
          const result: Record<string, number> = {}
          for (const definition of CapabilityDefinition.all()) {
            const lease = current(sessionID, agent, definition.id)
            if (lease) result[definition.id] = lease.generation
          }
          return result
        }),
        valid: Effect.fn("CapabilityLease.valid")(function* (sessionID, agent, capability, expected) {
          const lease = current(sessionID, agent, capability)
          return lease !== undefined && (expected === undefined || lease.generation === expected)
        }),
        revoke: Effect.fn("CapabilityLease.revoke")(function* (sessionID, agent, capability) {
          if (capability) {
            leases.delete(key(sessionID, agent, capability))
            return
          }
          for (const definition of CapabilityDefinition.all()) leases.delete(key(sessionID, agent, definition.id))
        }),
      })
    }),
  )

export const layer = makeLayer()
export const locationLayer = layer.pipe(Layer.provide(Config.locationLayer))

const slashName = /^\/([A-Za-z0-9][A-Za-z0-9._-]*)/

/** Activate host-granted skill capabilities when the user invoked a slash skill. */
export const activateFromSlash = Effect.fn("CapabilityLease.activateFromSlash")(function* (input: {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly text: string
}) {
  const name = input.text.trim().match(slashName)?.[1]
  if (!name) return
  const leases = Option.getOrUndefined(yield* Effect.serviceOption(Service))
  const skills = Option.getOrUndefined(yield* Effect.serviceOption(SkillV2.Service))
  if (!leases || !skills) return
  const skill = (yield* skills.list()).find((item) => item.name === name || item.aliases?.includes(name))
  const requested = skill?.requestedCapabilities ?? []
  if (!skill || requested.length === 0) return
  yield* leases
    .activate({
      sessionID: input.sessionID,
      agent: input.agent,
      skill: skill.name,
      requested,
    })
    .pipe(Effect.catchTag("CapabilityLease.DeniedError", () => Effect.void))
})
