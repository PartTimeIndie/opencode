// Offline source audit only: no provider request, skill execution, remote download or app mutation.
import { LLM, Model, ToolDefinition } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { providerFacingRequestTools } from "../src/session/runner/tool-compatibility"
import { catalogTrace } from "./context-budget-traces"
import { auditSource } from "./source-tool-definition"
import { Shell } from "../src/shell"
import path from "node:path"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../src/agent"
import { Config } from "../src/config"
import { SkillPolicy } from "../src/skill/policy"
import { ConfigAgentPlugin } from "../src/config/plugin/agent"
import { ConfigSkillPlugin } from "../src/config/plugin/skill"
import { ConfigSkillGroups } from "../src/config/skill-groups"
import { FSUtil } from "../src/fs-util"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { AgentPlugin } from "../src/plugin/agent"
import { SkillPlugin } from "../src/plugin/skill"
import { Project } from "../src/project"
import { AbsolutePath } from "../src/schema"
import { SkillV2 } from "../src/skill"
import { SkillCatalog } from "../src/skill/catalog"
import { SkillDiscovery } from "../src/skill/discovery"
import { Tool } from "../src/tool/tool"
import { ContextBudget } from "../src/util/context-budget"

const args = process.argv.slice(2)
const option = (key: string) => (args.includes(key) ? args[args.indexOf(key) + 1] : undefined)
const project = option("--project")
const output = option("--output")
const groupsPath = option("--groups")
if (!project || !output || !groupsPath)
  throw new Error("Usage: --project <directory> --groups <candidate.json> --output <directory>")
const groups = Schema.decodeUnknownSync(ConfigSkillGroups.Info)(await Bun.file(groupsPath).json())
const location = Layer.succeed(
  Location.Service,
  Location.Service.of({
    directory: AbsolutePath.make(project),
    project: { id: Project.ID.global, directory: AbsolutePath.make(project) },
  }),
)
const base = Layer.mergeAll(location, Global.defaultLayer, FSUtil.defaultLayer)
const config = Config.locationLayer.pipe(Layer.provide(base))
const services = Layer.mergeAll(
  config,
  AgentV2.locationLayer,
  SkillV2.layer.pipe(
    Layer.provide(config),
    Layer.provide(base),
    Layer.provide(
      Layer.succeed(
        SkillDiscovery.Service,
        SkillDiscovery.Service.of({ pull: () => Effect.die("Offline audit does not download URL skills") }),
      ),
    ),
  ),
)
const data = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      yield* AgentPlugin.Plugin.effect
      yield* ConfigAgentPlugin.Plugin.effect
      yield* ConfigSkillPlugin.Plugin.effect
      yield* SkillPlugin.Plugin.effect
      const skills = yield* (yield* SkillV2.Service).list({ refresh: true })
      const agents = yield* AgentV2.Service
      const root = Global.Path.config
      const instructions = awaitText([path.join(root, "AGENTS.md"), path.join(project, "AGENTS.md")])
      const components = yield* Effect.promise(() => instructions)
      const rows = yield* Effect.forEach(["plan", "build"], (name) =>
        Effect.gen(function* () {
          const agent = yield* agents.get(AgentV2.ID.make(name))
          if (!agent) throw new Error(`Missing agent ${name}`)
          const permitted = SkillV2.available(skills, agent)
          const entries = yield* (yield* Config.Service).entries()
          const invocation = Config.globalLatest(entries, "skill_invocation")
          const policies = SkillPolicy.policiesFor(permitted, invocation, agent.skills)
          const grouped = SkillCatalog.project(permitted, groups, policies)
          const flat = SkillCatalog.project(permitted, { ...groups, enabled: false }, policies)
          const descriptors = permitted
            .filter((skill) => policies.get(skill.name)?.visible.value ?? !skill.disableModelInvocation)
            .filter((skill) => skill.description !== undefined)
            .map((skill) => ({ name: skill.name, description: skill.description!, groups: skill.groups }))
          return {
            name,
            agent,
            grouped,
            flat,
            descriptors,
            components: [...components, { id: "agent-system", text: agent.system ?? "" }],
            shell: Shell.acceptable(Config.latest(entries, "shell")),
          }
        }),
      )
      return rows
    }),
  ).pipe(Effect.provide(services), Effect.provide(base)),
)

async function awaitText(paths: string[]) {
  return Promise.all(paths.map(async (file) => ({ id: file, text: await Bun.file(file).text() })))
}

await mkdir(output, { recursive: true })
const reports = []
for (const row of data) {
  const definitions: ToolDefinition[] = []
  const missingDefinitions: string[] = []
  for (const [name, entry] of Object.entries(row.agent.tools?.entries ?? {})) {
    if (entry.visible === false || entry.permission === "deny" || !/^[a-z][a-z0-9_]*$/.test(name)) continue
    const file = path.resolve(import.meta.dir, "../src/tool", name.replaceAll("_", "-") + ".ts")
    if (!(await Bun.file(file).exists())) {
      missingDefinitions.push(name)
      continue
    }
    const rewritten = auditSource(await Bun.file(file).text(), file)
    const temporary = rewritten ? await mkdtemp(path.join(output, "static-contract-")) : undefined
    const moduleFile = temporary ? path.join(temporary, "tool.ts") : file
    if (rewritten) await Bun.write(moduleFile, rewritten)
    const module = await import(pathToFileURL(moduleFile).href).finally(() =>
      temporary ? rm(temporary, { recursive: true }) : undefined,
    )
    const contract = module.__contextAudit
    const input = contract?.input ?? module.Input
    const description =
      contract?.description ?? module.description ?? (name === "bash" ? module.modelDescription(row.shell) : undefined)
    if (!input || !description) {
      missingDefinitions.push(name)
      continue
    }
    const tool = Tool.make({
      description,
      input,
      inputSchema: contract?.inputSchema ?? module.InputSchema,
      output: contract?.output ?? module.Output ?? Schema.Unknown,
      execute: () => Effect.die("Audit-only tool cannot execute"),
    })
    definitions.push(Tool.definition(name, tool))
  }
  const expansions = Object.keys(row.grouped.groups)
    .sort()
    .map((id) => ({ id, output: SkillCatalog.expand(row.grouped, id)! }))
  const ids = expansions.map((entry) => entry.id)
  const traces = [[], ids.slice(0, 1), ids.slice(0, 2), ids, [...ids, ...ids.slice(0, 1)]].map((trace) =>
    catalogTrace(row.flat, row.grouped, trace),
  )
  const fixture: ContextBudget.Fixture = {
    agents: ["F", "G"].map((variant) => ({
      name: row.name + "/" + variant,
      boundary: "materialized-definitions",
      components: [
        ...row.components,
        { id: "skill-catalog", text: SkillCatalog.render(variant === "F" ? row.flat : row.grouped) },
      ],
      tools: definitions,
    })),
  }
  const model = Model.make({ provider: "zhipuai-coding-plan", id: "glm-5.3-flash", route: OpenAIChat.route })
  const projectedTools = providerFacingRequestTools(model, definitions)
  const calculatedBodies = await Promise.all(
    fixture.agents.map(async (agent) => {
      const body = await Effect.runPromise(
        OpenAIChat.protocol.body.from(
          LLM.request({
            model,
            system: agent.components.map((component) => component.text).join("\n\n"),
            prompt: "Controlled offline context audit.",
            tools: projectedTools,
          }),
        ),
      )
      return {
        variant: agent.name,
        kind: "calculated-protocol-body-not-captured-traffic",
        completeTools: missingDefinitions.length === 0,
        ...ContextBudget.measure(JSON.stringify(body)),
      }
    }),
  )
  reports.push({
    name: row.name,
    boundary: "offline-source-registry-not-installed-runner",
    toolsPolicyMode: row.agent.tools?.mode,
    missingDefinitions,
    audit: ContextBudget.audit(fixture),
    providerProjectedTools: ContextBudget.tools(projectedTools),
    calculatedBodies,
    catalogs: { F: SkillCatalog.render(row.flat), G: SkillCatalog.render(row.grouped) },
    groupChildren: row.grouped.groups,
    groupOutputs: Object.fromEntries(expansions.map((entry) => [entry.id, entry.output])),
    diagnostics: row.grouped.issues,
    traces,
    descriptors: row.descriptors,
  })
  await Bun.write(path.join(output, `${row.name}-fixture.json`), JSON.stringify(fixture, null, 2) + "\n")
}
await Bun.write(path.join(output, "source-snapshot.json"), JSON.stringify(reports, null, 2) + "\n")
console.log(
  JSON.stringify(
    reports.map((row) => ({
      agent: row.name,
      flatChars: row.catalogs.F.length,
      groupedChars: row.catalogs.G.length,
      groups: Object.keys(row.groupChildren),
      descriptors: row.descriptors.length,
      tools: row.audit.agents[0].tools.length,
      missingDefinitions: row.missingDefinitions,
    })),
    null,
    2,
  ),
)
