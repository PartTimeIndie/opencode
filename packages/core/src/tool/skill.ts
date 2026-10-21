export * as SkillTool from "./skill"

import path from "path"
import { pathToFileURL } from "url"
import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Option, Schema } from "effect"
import { AgentV2 } from "../agent"
import { Config } from "../config"
import { SkillCatalog } from "../skill/catalog"
import { CapabilityLease } from "../capability/lease"
import { Database } from "../database/database"
import { FSUtil } from "../fs-util"
import { PluginBoot } from "../plugin/boot"
import { SkillV2 } from "../skill"
import { PermissionV2 } from "../permission"
import { SessionHistory } from "../session/history"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "skill"
const FILE_LIMIT = 10

export const Input = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  group: Schema.String.pipe(Schema.optional),
}).check(
  Schema.makeFilter(
    (input) => (input.name !== undefined) !== (input.group !== undefined) || "Provide exactly one skill name or group",
  ),
)

// Some OpenAI-compatible gateways emit {} for a root union. Keep the wire shape
// simple; the Input codec still enforces exactly one string target at settlement.
export const InputSchema = {
  type: "object",
  properties: { name: { type: "string" }, group: { type: "string" } },
  additionalProperties: false,
} as const

export const Output = Schema.Struct({
  name: Schema.String,
  directory: Schema.String,
  output: Schema.String,
  capabilities: Schema.Array(Schema.String).pipe(Schema.optional),
  capabilityExpiresAt: Schema.Number.pipe(Schema.optional),
})

export const description = [
  "Load a specialized skill when the task at hand matches one of the available skills in the system context.",
  "",
  "Use this tool to inject the skill's instructions and resources into the current conversation. The output may contain detailed workflow guidance as well as references to scripts, files, etc. in the same directory as the skill.",
  "",
  "Use {name} to load one skill, or {group} to list direct child descriptions only. Exactly one target. Group navigation grants no capabilities. Manual-only skills still require explicit user invocation.",
].join("\n")

export const toModelOutput = (
  skill: SkillV2.Info,
  files: ReadonlyArray<string>,
  activated: ReadonlyArray<CapabilityLease.Lease> = [],
) => {
  const directory = path.dirname(skill.location)
  return [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    "",
    skill.content.trim(),
    "",
    `Base directory for this skill: ${pathToFileURL(directory).href}`,
    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    ...files.map((file) => `<file>${file}</file>`),
    "</skill_files>",
    ...(activated.length
      ? [
          `<activated_capabilities expires_at="${Math.min(...activated.map((lease) => lease.expiresAt))}">`,
          ...activated.map((lease) => `<capability>${lease.capability}</capability>`),
          "</activated_capabilities>",
        ]
      : []),
    "</skill_content>",
  ].join("\n")
}

export const loadFailureMessage = (name: string, error?: unknown) => {
  if (error instanceof CapabilityLease.DeniedError) return `Unable to load skill ${name}: ${error.message}`
  return `Unable to load skill ${name}`
}

const unableToLoad = (name: string, error?: unknown) =>
  new ToolFailure({ message: loadFailureMessage(name, error), error })

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const fs = yield* FSUtil.Service
    const boot = yield* PluginBoot.Service
    const skills = yield* SkillV2.Service
    const agents = Option.getOrUndefined(yield* Effect.serviceOption(AgentV2.Service))
    const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
    const permission = yield* PermissionV2.Service
    const capabilityLeases = Option.getOrUndefined(yield* Effect.serviceOption(CapabilityLease.Service))
    const database = yield* Database.Service
    yield* boot.wait()
    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          inputSchema: InputSchema,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const current = yield* skills.list()
              if (input.group !== undefined) {
                const agent = agents ? yield* agents.get(context.agent) : undefined
                if (!agent) return yield* unableToLoad(input.group)
                const catalog = SkillCatalog.project(
                  SkillV2.available(current, agent, context.toolPolicy ?? agent.tools),
                  Config.latest(config ? yield* config.entries() : [], "skill_groups"),
                )
                const output = SkillCatalog.expand(catalog, input.group, context.skillGroupOutputs ?? [])
                if (!output) return yield* unableToLoad(input.group)
                return { name: input.group, directory: "", output }
              }
              const skillName = input.name
              if (skillName === undefined) return yield* unableToLoad("missing target")
              const skill = current.find((skill) => skill.name === skillName)
              if (!skill) return yield* unableToLoad(skillName)
              if (skill.disableModelInvocation) {
                // Use durable user intent anchored before this call, not model input,
                // compacted summaries, or later prompts admitted to the Session.
                const history = yield* SessionHistory.loadForPermission(
                  database.db,
                  context.sessionID,
                  context.assistantMessageID,
                  0,
                ).pipe(Effect.orDie)
                const user = history?.findLast((message) => message.type === "user")
                if (!user || !SkillV2.invokedBySlash(skill, user.text))
                  return yield* new ToolFailure({
                    message: `Skill ${skill.name} requires an explicit /${skill.name} invocation`,
                  })
              }
              return yield* Effect.gen(function* () {
                yield* permission.assert({
                  action: name,
                  resources: [skill.name],
                  save: [skill.name],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                const directory = path.dirname(skill.location)
                const files =
                  path.basename(skill.location) === "SKILL.md"
                    ? (yield* fs.glob("**/*", { cwd: directory, absolute: true, include: "file", dot: true }))
                        .filter((file) => path.basename(file) !== "SKILL.md")
                        .toSorted()
                        .slice(0, FILE_LIMIT)
                    : []
                const requested = skill.requestedCapabilities ?? []
                if (requested.length > 0 && !capabilityLeases)
                  return yield* unableToLoad(skill.name, new Error("Capability lease service is unavailable"))
                // Activate only after all fallible skill loading work succeeds,
                // so a failed skill call cannot leave a capability unlocked.
                const activated = capabilityLeases
                  ? yield* capabilityLeases.activate({
                      sessionID: context.sessionID,
                      agent: context.agent,
                      skill: skill.name,
                      requested,
                    })
                  : []
                return {
                  name: skill.name,
                  directory,
                  output: toModelOutput(skill, files, activated),
                  capabilities: activated.length ? activated.map((lease) => lease.capability) : undefined,
                  capabilityExpiresAt: activated.length
                    ? Math.min(...activated.map((lease) => lease.expiresAt))
                    : undefined,
                }
              }).pipe(Effect.mapError((error) => unableToLoad(skillName, error)))
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
