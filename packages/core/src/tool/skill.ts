export * as SkillTool from "./skill"

import path from "path"
import { pathToFileURL } from "url"
import { ToolFailure } from "@opencode-ai/llm"
import { Deferred, Effect, Exit, Layer, Option, Schema } from "effect"
import { AgentV2 } from "../agent"
import { Config } from "../config"
import { ConfigSkillInvocation } from "../config/skill-invocation"
import { SkillCatalog } from "../skill/catalog"
import { SkillPolicy } from "../skill/policy"
import { CapabilityLease } from "../capability/lease"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { FSUtil } from "../fs-util"
import { PluginBoot } from "../plugin/boot"
import { SkillV2 } from "../skill"
import { PermissionV2 } from "../permission"
import { SessionHistory } from "../session/history"
import { SessionInput } from "../session/input"
import { SessionSkillSelection } from "../session/skill-selection"
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

// Parallel loads of the same expired generation share one renewal question
// through a short-lived in-process claim, never through long-running locks.
const renewalClaims = new Map<string, Deferred.Deferred<boolean>>()

export const sharedRenewal = (key: string, run: Effect.Effect<boolean, unknown>): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const existing = renewalClaims.get(key)
    if (existing) return yield* Deferred.await(existing)
    const deferred = yield* Deferred.make<boolean>()
    renewalClaims.set(key, deferred)
    return yield* run.pipe(
      Effect.catch(() => Effect.succeed(false)),
      // Interruption also completes and releases the claim so waiting loads
      // re-check the ledger instead of hanging on a lost owner.
      Effect.onExit((exit) => Deferred.done(deferred, Exit.succeed(exit._tag === "Success" && exit.value === true)).pipe(
        Effect.andThen(Effect.sync(() => renewalClaims.delete(key))),
      )),
    )
  })

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
    const events = Option.getOrUndefined(yield* Effect.serviceOption(EventV2.Service))
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
              const agent = agents ? yield* agents.get(context.agent) : undefined
              const entries = config ? yield* config.entries() : []
              const invocation = Config.globalLatest(entries, "skill_invocation")
              if (input.group !== undefined) {
                if (!agent) return yield* unableToLoad(input.group)
                const permitted = SkillV2.available(current, agent, context.toolPolicy ?? agent.tools)
                const policies = SkillPolicy.policiesFor(permitted, invocation, agent.skills)
                const catalog = SkillCatalog.project(
                  permitted,
                  Config.latest(entries, "skill_groups"),
                  policies,
                )
                const output = SkillCatalog.expand(catalog, input.group, context.skillGroupOutputs ?? [])
                if (!output) return yield* unableToLoad(input.group)
                return { name: input.group, directory: "", output }
              }
              const skillName = input.name
              if (skillName === undefined) return yield* unableToLoad("missing target")
              const skill = current.find((skill) => skill.name === skillName)
              if (!skill) return yield* unableToLoad(skillName)
              const policyIssues = config?.issues ? yield* config.issues() : []
              if (policyIssues.length > 0)
                return yield* unableToLoad(
                  skillName,
                  new Error(
                    `Skill policy configuration is unreadable (${policyIssues[0]!.path}: ${policyIssues[0]!.message}); fix or remove the file before loading skills`,
                  ),
                )
              const policy = SkillPolicy.resolveForSkill({ skill, global: invocation, agentSkills: agent?.skills })
              const memory = ConfigSkillInvocation.resolveSelectionMemory(invocation)
              const invocationNow = config ? yield* config.entries() : []
              const memoryNow = ConfigSkillInvocation.resolveSelectionMemory(Config.globalLatest(invocationNow, "skill_invocation"))
              // Selection authority comes from the durable ledger against the
              // call-bound fence, never from model input or later prompts.
              const gateSelection = Effect.gen(function* () {
                if (policy.invocation.value === "allow") return { selected: true }
                if (!memory.enabled || events === undefined) return yield* legacySelected
                const source = yield* SessionHistory.entryForMessage(database.db, context.sessionID, context.assistantMessageID).pipe(Effect.orDie)
                const fenceSeq = source?.seq ?? 0
                const result = yield* SessionSkillSelection.resolveForGate({
                  db: database.db,
                  events,
                  sessionID: context.sessionID,
                  skill,
                  fenceSeq,
                  assistantMessageID: context.assistantMessageID,
                  limits: { minutes: memoryNow.minutes, messages: memoryNow.messages },
                  now: Date.now(),
                })
                return result.selected ? { selected: true } : result
              })
              const legacySelected = Effect.gen(function* () {
                // Disabled memory keeps the previous direct gate path exactly:
                // last user message before this call, strictly attested.
                const history = yield* SessionHistory.loadForPermission(
                  database.db,
                  context.sessionID,
                  context.assistantMessageID,
                  0,
                ).pipe(Effect.orDie)
                const user = history?.findLast((message) => message.type === "user")
                const admitted = user ? yield* SessionInput.find(database.db, user.id) : undefined
                const anchor = user
                  ? yield* SessionHistory.entryForMessage(database.db, context.sessionID, user.id).pipe(Effect.orDie)
                  : undefined
                const selected = !!user && admitted?.sessionID === context.sessionID && admitted.origin === "interactive" &&
                  admitted.promotedSeq === anchor?.seq && admitted.prompt.text === user.text && SkillV2.invokedBySlash(skill, admitted.prompt.text)
                return { selected }
              })
              const proceed = Effect.gen(function* () {
                yield* permission.assert({
                  action: name,
                  resources: [skill.name],
                  save: [skill.name],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  extraRules: SkillPolicy.askRules(policy, skill.name, { explicitlySelected: selection.selected }),
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
              const selection = yield* gateSelection
              const gate = SkillPolicy.admissionGate(policy, { explicitlySelected: selection.selected })
              if (gate === "deny")
                return yield* new ToolFailure({
                  message: `Skill ${skill.name} is blocked by configuration (invocation: deny)`,
                })
              if (gate === "manual") {
                const renewable =
                  events !== undefined &&
                  !selection.selected &&
                  (selection.reason === "expired_time" || selection.reason === "expired_messages") &&
                  selection.row !== undefined &&
                  permission.assertSingleUse !== undefined
                if (renewable && memory.enabled) {
                  const row = selection.row!
                  const claim = `${context.sessionID}:${skill.name}:${row.generation}`
                  const renewed = yield* sharedRenewal(
                    claim,
                    Effect.gen(function* () {
                      // Exactly one host-bound, single-use question per claim.
                      // An Allow shortcut or delegated automatic answer can
                      // never mint a human selection receipt.
                      const receipt = yield* permission.assertSingleUse!({
                        action: "skill_selection_renew",
                        resources: [skill.name],
                        sessionID: context.sessionID,
                        agent: context.agent,
                        source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                        metadata: {
                          skill: skill.name,
                          generation: row.generation,
                          reason: selection.reason,
                          minutes: memoryNow.minutes,
                          messages: memoryNow.messages,
                        },
                      })
                      // Revalidate policy, freshness and the exact generation
                      // after the awaited host answer before recording anything.
                      const entriesAfter = config ? yield* config.entries() : []
                      const invocationAfter = Config.globalLatest(entriesAfter, "skill_invocation")
                      const policyAfter = SkillPolicy.resolveForSkill({ skill, global: invocationAfter, agentSkills: agent?.skills })
                      if (policyAfter.invocation.value === "deny") return false
                      const limitsAfter = ConfigSkillInvocation.resolveSelectionMemory(invocationAfter)
                      if (!limitsAfter.enabled) return false
                      const still = yield* SessionSkillSelection.row(database.db, context.sessionID, skill.name)
                      if (still?.generation !== row.generation) return false
                      return yield* SessionSkillSelection.recordReceipt(database.db, events!, {
                        sessionID: context.sessionID,
                        name: skill.name,
                        kind: "renewal",
                        receiptID: receipt,
                        limits: { minutes: limitsAfter.minutes, messages: limitsAfter.messages },
                        boundMessageID: context.assistantMessageID,
                        expectedGeneration: row.generation,
                      })
                    }),
                  )
                  if (!renewed) {
                    // Decline and dismissal grant nothing and stay suppressed
                    // for this generation until a new genuine selection exists.
                    if (events !== undefined)
                      yield* SessionSkillSelection.recordRenewalDeclined(database.db, events, {
                        sessionID: context.sessionID,
                        name: skill.name,
                        generation: row.generation,
                      }).pipe(Effect.ignore)
                    return yield* new ToolFailure({
                      message: `Skill ${skill.name} requires an explicit /${skill.name} invocation (the previous selection expired and the renewal was declined)`,
                    })
                  }
                  const fence = yield* SessionHistory.entryForMessage(database.db, context.sessionID, context.assistantMessageID).pipe(Effect.orDie)
                  const again = yield* SessionSkillSelection.resolveForGate({
                    db: database.db,
                    events: events!,
                    sessionID: context.sessionID,
                    skill,
                    fenceSeq: fence?.seq ?? 0,
                    assistantMessageID: context.assistantMessageID,
                    limits: { minutes: memoryNow.minutes, messages: memoryNow.messages },
                    now: Date.now(),
                  })
                  if (!again.selected)
                    return yield* new ToolFailure({
                      message: `Skill ${skill.name} requires an explicit /${skill.name} invocation`,
                    })
                  return yield* proceed
                }
                return yield* new ToolFailure({
                  message: `Skill ${skill.name} requires an explicit /${skill.name} invocation`,
                })
              }
              return yield* proceed
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
