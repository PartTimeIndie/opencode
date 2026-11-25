export * as SkillGuidance from "./guidance"

import { Context, Effect, Layer, Option, Schema } from "effect"
import { AgentV2 } from "../agent"
import { Config } from "../config"
import { PermissionV2 } from "../permission"
import { PluginBoot } from "../plugin/boot"
import { SkillV2 } from "../skill"
import { SkillCatalog } from "./catalog"
import { SkillPolicy } from "./policy"
import { SystemContext } from "../system-context/index"

export interface Interface {
  readonly load: (
    agent: AgentV2.Selection,
    policy?: AgentV2.Info["tools"],
  ) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SkillGuidance") {}

export const CACHE_LIMIT = 32

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const boot = yield* PluginBoot.Service
    const skills = yield* SkillV2.Service
    const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
    const cache = new Map<string, SystemContext.SystemContext>()

    return Service.of({
      load: Effect.fn("SkillGuidance.load")(function* (selection, policy) {
        yield* boot.wait()
        const agent = selection.info
        if (!agent) return SystemContext.empty
        const permitted = SkillV2.available(yield* skills.list(), agent, policy)
        if (permitted.length === 0 && PermissionV2.evaluate("skill", "*", agent.permissions).effect === "deny")
          return SystemContext.empty
        const entries = config ? yield* config.entries() : []
        const policies = SkillPolicy.policiesFor(permitted, Config.globalLatest(entries, "skill_invocation"), agent.skills)
        const catalog = SkillCatalog.project(permitted, Config.latest(entries, "skill_groups"), policies)
        const rendered = SkillCatalog.render(catalog)
        const cached = cache.get(rendered)
        if (cached) {
          cache.delete(rendered)
          cache.set(rendered, cached)
          return cached
        }
        const context = SystemContext.make({
          key: SystemContext.Key.make("core/skill-guidance"),
          codec: Schema.toCodecJson(Schema.String),
          load: Effect.succeed(rendered),
          baseline: (current) => current,
          update: (_previous, current) =>
            [
              "The available skills have changed. This catalog supersedes all previous skill catalogs and group expansions.",
              current,
            ].join("\n"),
          removed: () => "Skill guidance is no longer available. Do not use any previously listed skill.",
        })
        cache.set(rendered, context)
        // Policy and refreshed catalog variants must not retain unbounded source text.
        if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
        return context
      }),
    })
  }),
)

export const locationLayer = layer
