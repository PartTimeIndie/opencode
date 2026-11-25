import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { CapabilityLease } from "@opencode-ai/core/capability/lease"
import { Config } from "@opencode-ai/core/config"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SessionV2 } from "@opencode-ai/core/session"
import { testEffect } from "./lib/effect"

let now = 1_000
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            skill_capabilities: {
              "computer-use": ["browser_read", "browser_write"],
              "spawn-new-agent": ["spawn_agent"],
              "multi-agent-orchestrator": ["spawn_agent"],
            },
          }),
        }),
      ]),
  }),
)

const skills = Layer.succeed(
  SkillV2.Service,
  SkillV2.Service.of({
    transform: () => Effect.die("unused"),
    sources: () => Effect.die("unused"),
    list: () =>
      Effect.succeed([
        new SkillV2.Info({
          name: "spawn-new-agent",
          requestedCapabilities: ["spawn_agent"],
          location: AbsolutePath.make("/skills/spawn-new-agent/SKILL.md"),
          content: "Call spawn_agent.",
        }),
        new SkillV2.Info({
          name: "untrusted-orchestrator",
          requestedCapabilities: ["orchestrator"],
          location: AbsolutePath.make("/skills/untrusted-orchestrator/SKILL.md"),
          content: "No host grant.",
        }),
        new SkillV2.Info({
          name: "mixed-orchestrator",
          requestedCapabilities: ["orchestrator", "spawn_agent"],
          location: AbsolutePath.make("/skills/mixed-orchestrator/SKILL.md"),
          content: "Not an appended commissioning-only skill.",
        }),
        new SkillV2.Info({
          name: "main-orchestrator",
          aliases: ["managed-main"],
          requestedCapabilities: ["orchestrator"],
          location: AbsolutePath.make("/skills/main-orchestrator/SKILL.md"),
          content: "Call orchestrator after host consent.",
        }),
        new SkillV2.Info({
          name: "multi-agent-orchestrator",
          requestedCapabilities: ["spawn_agent"],
          location: AbsolutePath.make("/skills/multi-agent-orchestrator/SKILL.md"),
          content: "Call spawn_agent for independent implementation packets.",
        }),
      ]),
  }),
)
const leases = CapabilityLease.makeLayer(() => now).pipe(Layer.provide(config))
const it = testEffect(Layer.mergeAll(config, leases, skills))
const sessionID = SessionV2.ID.make("ses_capability")
const otherSessionID = SessionV2.ID.make("ses_capability_other")
const agent = AgentV2.ID.make("build")
const otherAgent = AgentV2.ID.make("review")
const slashSessionID = SessionV2.ID.make("ses_capability_slash")
const orchestratorSessionID = SessionV2.ID.make("ses_capability_orchestrator")

describe("CapabilityLease", () => {
  it.effect("requires the skill declaration and host grant, and isolates session plus agent", () =>
    Effect.gen(function* () {
      now = 1_000
      const service = yield* CapabilityLease.Service
      const activated = yield* service.activate({
        sessionID,
        agent,
        skill: "computer-use",
        requested: ["browser_read"],
      })
      expect(activated).toHaveLength(1)
      expect(yield* service.snapshot(sessionID, agent)).toEqual({ browser_read: activated[0]!.generation })
      expect(yield* service.snapshot(otherSessionID, agent)).toEqual({})
      expect(yield* service.snapshot(sessionID, otherAgent)).toEqual({})

      const denied = yield* service
        .activate({ sessionID, agent, skill: "untrusted", requested: ["browser_write"] })
        .pipe(Effect.flip)
      expect(denied).toMatchObject({
        _tag: "CapabilityLease.DeniedError",
        skill: "untrusted",
        capability: "browser_write",
      })
    }),
  )

  it.effect("activates granted skill capabilities from a user slash command", () =>
    Effect.gen(function* () {
      now = 20_000
      const service = yield* CapabilityLease.Service
      yield* CapabilityLease.activateFromSlash({
        sessionID: slashSessionID,
        agent,
        text: "/spawn-new-agent implement the selected card",
      })
      expect(Object.keys(yield* service.snapshot(slashSessionID, agent))).toEqual(["spawn_agent"])
      expect(yield* service.snapshot(slashSessionID, otherAgent)).toEqual({})

      yield* CapabilityLease.activateFromSlash({
        sessionID: orchestratorSessionID,
        agent,
        text: "/multi-agent-orchestrator split the implementation into independent packets",
      })
      expect(Object.keys(yield* service.snapshot(orchestratorSessionID, agent))).toEqual(["spawn_agent"])

      yield* CapabilityLease.activateFromSlash({
        sessionID: slashSessionID,
        agent,
        text: "please spawn a session",
      })
      expect(Object.keys(yield* service.snapshot(slashSessionID, agent))).toEqual(["spawn_agent"])
    }),
  )

  it.effect("retired Main skill declarations and appended references grant no capabilities", () =>
    Effect.gen(function* () {
      const service = yield* CapabilityLease.Service
      for (const text of ["/main-orchestrator", "Implement the task\n\n/main-orchestrator", "Please /managed-main now", "/untrusted-orchestrator", "please /mixed-orchestrator", "please /spawn-new-agent now"]) {
        yield* service.revoke(orchestratorSessionID, agent)
        yield* CapabilityLease.activateFromSlash({ sessionID: orchestratorSessionID, agent, text })
        expect(yield* service.snapshot(orchestratorSessionID, agent)).toEqual({})
      }
    }),
  )

  it.effect("expires, revokes, and fences renewed leases by generation", () =>
    Effect.gen(function* () {
      now = 10_000
      const service = yield* CapabilityLease.Service
      const first = (
        yield* service.activate({
          sessionID,
          agent,
          skill: "computer-use",
          requested: ["browser_read"],
        })
      )[0]!
      const second = (
        yield* service.activate({
          sessionID,
          agent,
          skill: "computer-use",
          requested: ["browser_read"],
        })
      )[0]!
      expect(second.generation).toBeGreaterThan(first.generation)
      expect(yield* service.valid(sessionID, agent, "browser_read", first.generation)).toBe(false)
      expect(yield* service.valid(sessionID, agent, "browser_read", second.generation)).toBe(true)

      yield* service.revoke(sessionID, agent, "browser_read")
      expect(yield* service.valid(sessionID, agent, "browser_read", second.generation)).toBe(false)

      const expiring = (
        yield* service.activate({
          sessionID,
          agent,
          skill: "computer-use",
          requested: ["browser_write"],
        })
      )[0]!
      now = expiring.expiresAt
      expect(yield* service.snapshot(sessionID, agent)).toEqual({})
    }),
  )
})
