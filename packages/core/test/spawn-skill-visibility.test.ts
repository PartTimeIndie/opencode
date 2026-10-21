import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { CapabilityLease } from "@opencode-ai/core/capability/lease"
import { Config } from "@opencode-ai/core/config"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillDiscovery } from "@opencode-ai/core/skill/discovery"
import { SpawnAgentTool } from "@opencode-ai/core/tool/spawn-agent"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity } from "./lib/tool"

const it = testEffect(Layer.empty)
const context = { sessionID: SessionV2.ID.make("ses_spawn_visibility"), agent: toolIdentity.agent }
const policy = { mode: "explicit", entries: { spawn_agent: { visible: true, permission: "ask" } } } as const
const rules: PermissionV2.Ruleset = [{ action: "spawn_agent", resource: "*", effect: "ask" }]

function fixture(declaration: boolean, grant: boolean) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((tmp) =>
      Effect.gen(function* () {
        // The normal suite is hermetic. This optional explicit probe parses a copy
        // of the installed skill through the same real loader, never personal config.
        const source = process.env.OPENCODE_TEST_SPAWN_SKILL
          ? yield* Effect.promise(() => fs.readFile(process.env.OPENCODE_TEST_SPAWN_SKILL!, "utf8"))
          : "---\nname: spawn-new-agent\ndescription: Manual Spawn\ndisable-model-invocation: true\ncapabilities: [spawn_agent]\n---\nCall spawn_agent.\n"
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(tmp.path, "SKILL.md"),
            declaration ? source : source.replace(/^capabilities:.*\r?\n/m, ""),
          ),
        )
        let now = 1_000
        const config = Layer.succeed(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  info: new Config.Info({ skill_capabilities: { "spawn-new-agent": grant ? ["spawn_agent"] : [] } }),
                }),
              ]),
          }),
        )
        const leases = CapabilityLease.makeLayer(() => now).pipe(Layer.provide(config))
        const skills = SkillV2.layer.pipe(
          Layer.provide(SkillDiscovery.defaultLayer),
          Layer.provide(FSUtil.defaultLayer),
          Layer.provide(config),
        )
        const permission = Layer.mock(PermissionV2.Service, {
          assert: () => Effect.die("Visibility must not execute or ask"),
          materializationRules: () => Effect.succeed([]),
        })
        const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(leases), Layer.provide(permission))
        // Native Spawn tool registration; none of its Session operations may run
        // during visibility/materialization checks.
        const spawn = SpawnAgentTool.layer.pipe(
          Layer.provide(registry),
          Layer.provide(permission),
          Layer.provide(AgentV2.locationLayer),
          Layer.provide(Layer.mock(SessionV2.Service, {})),
          Layer.provide(BackgroundJob.defaultLayer),
        )
        return {
          directory: tmp.path,
          expire: () => {
            now += 31 * 60_000
          },
          layer: Layer.mergeAll(leases, skills, registry, spawn),
        }
      }),
    ),
  )
}

describe("Spawn skill visibility and Ask are independent", () => {
  it.live("parses manual metadata, reveals the native Ask tool only after activation and fences expired calls", () =>
    Effect.gen(function* () {
      const setup = yield* fixture(true, true)
      yield* Effect.gen(function* () {
        const skills = yield* SkillV2.Service
        yield* (yield* skills.transform())((editor) =>
          editor.source({ type: "directory", path: AbsolutePath.make(setup.directory) }),
        )
        expect((yield* skills.list()).find((skill) => skill.name === "spawn-new-agent")).toMatchObject({
          disableModelInvocation: true,
          requestedCapabilities: ["spawn_agent"],
        })
        const registry = yield* ToolRegistry.Service
        expect((yield* registry.materialize(rules, policy, context)).definitions).toEqual([])
        yield* CapabilityLease.activateFromSlash({ ...context, text: "please use /spawn-new-agent" })
        expect((yield* registry.materialize(rules, policy, context)).definitions).toEqual([])
        yield* CapabilityLease.activateFromSlash({ ...context, text: "/spawn-new-agent inspect only" })
        const offered = yield* registry.materialize(rules, policy, context)
        expect(offered.definitions.map((tool) => tool.name)).toEqual(["spawn_agent"])
        expect(
          (yield* registry.materialize(rules, policy, { ...context, sessionID: SessionV2.ID.make("ses_other") }))
            .definitions,
        ).toEqual([])
        expect(
          (yield* registry.materialize(rules, policy, { ...context, agent: AgentV2.ID.make("review") })).definitions,
        ).toEqual([])
        expect((yield* registry.materialize(rules, { mode: "explicit", entries: {} }, context)).definitions).toEqual([])
        expect(
          (yield* registry.materialize(
            rules,
            { mode: "explicit", entries: { spawn_agent: { visible: false, permission: "ask" } } },
            context,
          )).definitions,
        ).toEqual([])
        expect(
          (yield* registry.materialize([{ action: "spawn_agent", resource: "*", effect: "deny" }], policy, context))
            .definitions,
        ).toEqual([])
        expect(
          (yield* registry.materialize(
            rules,
            { mode: "explicit", entries: { spawn_agent: { visible: true, permission: "deny" } } },
            context,
          )).definitions,
        ).toEqual([])
        setup.expire()
        expect((yield* registry.materialize(rules, policy, context)).definitions).toEqual([])
        const stale = yield* offered.settle({
          ...context,
          assistantMessageID: toolIdentity.assistantMessageID,
          call: { type: "tool-call", id: "expired", name: "spawn_agent", input: { prompt: "must not execute" } },
        })
        expect(stale.result).toEqual({ type: "error", value: "Capability lease is not active for tool: spawn_agent" })
      }).pipe(Effect.provide(setup.layer))
    }),
  )

  for (const [declaration, grant] of [
    [false, true],
    [true, false],
  ]) {
    it.live(`keeps Spawn hidden without declaration=${declaration} or host grant=${grant}`, () =>
      Effect.gen(function* () {
        const setup = yield* fixture(declaration!, grant!)
        yield* Effect.gen(function* () {
          const skills = yield* SkillV2.Service
          yield* (yield* skills.transform())((editor) =>
            editor.source({ type: "directory", path: AbsolutePath.make(setup.directory) }),
          )
          yield* CapabilityLease.activateFromSlash({ ...context, text: "/spawn-new-agent inspect only" })
          expect(yield* (yield* CapabilityLease.Service).snapshot(context.sessionID, context.agent)).toEqual({})
          expect((yield* (yield* ToolRegistry.Service).materialize(rules, policy, context)).definitions).toEqual([])
        }).pipe(Effect.provide(setup.layer))
      }),
    )
  }
})
