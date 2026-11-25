export * as ConfigAgentPlugin from "./agent"

import path from "path"
import { existsSync, watch, type FSWatcher } from "fs"
import { Effect, Option, Schema, Scope } from "effect"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { ConfigAgent } from "../agent"
import { ConfigModelChain } from "../model-chain"
import { ConfigMarkdown } from "../markdown"
import { FSUtil } from "../../fs-util"
import { ModelV2 } from "../../model"
import { PluginV2 } from "../../plugin"
import { ConfigAgentV1 } from "../../v1/config/agent"
import { ConfigMigrateV1 } from "../../v1/config/migrate"
import { BUILD_SYSTEM } from "../../plugin/agent"
import { Location } from "../../location"
import { Wildcard } from "../../util/wildcard"

const legacySources = [
  { pattern: "{agent,agents}/**/*.md", primary: false },
  { pattern: "{mode,modes}/*.md", primary: true },
] as const
const decodeAgent = Schema.decodeUnknownOption(ConfigAgent.Info)
const decodeLegacyAgent = Schema.decodeUnknownOption(ConfigAgentV1.Info)
const decodeConfig = Schema.decodeUnknownOption(Config.Info)
const configFileNames = new Set(["config.json", "opencode.json", "opencode.jsonc"])
const agentDirectoryNames = new Set(["agent", "agents", "mode", "modes"])
const agentKeys = new Set([
  "model",
  "variant",
  "request",
  "system",
  "instructions",
  "tools",
  "skills",
  "completion",
  "description",
  "mode",
  "hidden",
  "color",
  "steps",
  "tool_budget",
  "disabled",
  "permissions",
])
export const Plugin = PluginV2.define({
  id: PluginV2.ID.make("config-agent"),
  effect: Effect.gen(function* () {
    const agent = yield* AgentV2.Service
    const config = yield* Config.Service
    const location = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
    const fs = yield* FSUtil.Service
    const scope = yield* Scope.Scope
    const watchers = new Map<string, { watcher: FSWatcher; recursive: boolean }>()
    let configFiles = new Set<string>()
    let configDirectories = new Set<string>()
    let agentDirectories = new Set<string>()
    let promptFiles = new Set<string>()
    const watchDirectory = (directory: string, recursive = false) => {
      const resolved = path.resolve(directory)
      const key = pathKey(resolved)
      const previous = watchers.get(key)
      if (previous?.recursive || (previous && !recursive) || !existsSync(resolved)) return
      previous?.watcher.close()
      const watcher = watch(resolved, { recursive }, (_event, filename) => {
        if (
          shouldInvalidateAgent({
            directory: resolved,
            filename,
            configFiles,
            configDirectories,
            agentDirectories,
            promptFiles,
          })
        ) agent.invalidate?.()
      })
      watchers.set(key, { watcher, recursive })
    }
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        for (const entry of watchers.values()) entry.watcher.close()
        watchers.clear()
      }),
    )
    const initialEntries = yield* config.entries()
    const baseSystems = new Map((yield* agent.all()).map((item) => [item.id, item.system]))
    const apply = yield* agent.transform()
    const applyConfig = Effect.fn("ConfigAgentPlugin.applyConfig")(function* (configEntries: Config.Entry[]) {
      const centralAgents = Config.globalLatest(configEntries, "agents") ?? {}
      const documents = yield* Effect.forEach(configEntries, (entry) => {
        if (entry.type === "document") return Effect.succeed([entry])
        return Effect.gen(function* () {
          const files = yield* discover(fs, entry.path)
          return yield* Effect.forEach(files, (file) =>
            fs.readFileStringSafe(file.filepath).pipe(
              Effect.map((content) => content && decode(file, content)),
              Effect.catch(() => Effect.succeed(undefined)),
            ),
          ).pipe(
            Effect.map((documents) =>
              documents.filter((document): document is Config.Document => document !== undefined),
            ),
          )
        })
      }).pipe(Effect.map((documents) => documents.flat()))
      syncWatchers(configEntries, documents)
      const promptSources = yield* Effect.forEach(documents, (document) =>
        Effect.forEach(
          Object.entries(document.info.agents ?? {}),
          ([id, item]) =>
            Effect.all({
              system:
                item.system && typeof item.system !== "string"
                  ? readPromptFiles(fs, document.path, item.system.files ?? [])
                  : Effect.succeed([]),
              completion: item.completion
                ? readPromptFiles(fs, document.path, item.completion.files ?? [])
                : Effect.succeed([]),
            }).pipe(Effect.map((sources) => [id, sources] as const)),
          { concurrency: "unbounded" },
        ).pipe(Effect.map((entries) => Object.fromEntries(entries))),
      )

      yield* apply((editor) => {
        const global = ConfigAgent.normalizeSwitchPermissions(
          documents.flatMap((document) => document.info.permissions ?? []),
        )
        const configuredDefault = Config.latest(documents, "default_agent")
        if (configuredDefault !== undefined) editor.default(AgentV2.ID.make(configuredDefault))
        for (const current of editor.list()) {
          editor.update(current.id, (agent) => agent.permissions.push(...global))
        }

        for (const [documentIndex, document] of documents.entries()) {
          for (const [id, item] of Object.entries(document.info.agents ?? {})) {
            const sources = promptSources[documentIndex]?.[id] ?? { system: [], completion: [] }
            const agentID = AgentV2.ID.make(id)
            const switches = ConfigAgent.normalizeSwitchConfig(item.tools, item.permissions ?? [])
            if (item.disabled) {
              editor.remove(agentID)
              continue
            }

            const exists = editor.get(agentID) !== undefined
            editor.update(agentID, (agent) => {
              if (!exists) agent.permissions.push(...global)
              if (item.model !== undefined) {
                const model = ConfigModelChain.agentTarget(item.model, Config.latest(documents, "model_chains"))
                agent.model = {
                  id: model.id,
                  providerID: model.providerID,
                  ...(model.chain
                    ? { chain: { ...model.chain, steps: model.chain.steps.map((step) => ({ ...step })) } }
                    : { variant: model.variant ?? agent.model?.variant }),
                }
              }
              if (item.variant !== undefined && agent.model !== undefined && !agent.model.chain) {
                agent.model.variant = ModelV2.VariantID.make(item.variant)
              }
              if (item.request !== undefined) {
                Object.assign(agent.request.headers, item.request.headers ?? {})
                Object.assign(agent.request.body, item.request.body ?? {})
              }
              if (item.system !== undefined) {
                if (typeof item.system === "string") {
                  agent.system = item.system
                  agent.systemMode = "replace"
                } else {
                  const prompt = [item.system.prompt, ...sources.system].filter(Boolean).join("\n\n")
                  const baseSystem = baseSystems.get(agentID) ?? BUILD_SYSTEM
                  if (item.system.mode === "inherit") {
                    agent.system = baseSystem
                    agent.systemMode = "inherit"
                  } else if (item.system.mode === "append") {
                    agent.system = [baseSystem, prompt].filter(Boolean).join("\n\n")
                    agent.systemMode = "append"
                  } else {
                    agent.system = prompt
                    agent.systemMode = "replace"
                  }
                }
              }
              if (item.instructions !== undefined) {
                agent.instructions = { mode: item.instructions.mode, files: [...(item.instructions.files ?? [])] }
              }
              if (item.skills !== undefined) {
                // Per-agent skill policy overrides. Sparse by field; an absent
                // entry or field inherits the global skill policy.
                agent.skills = Object.fromEntries(
                  Object.entries(item.skills).map(([skillName, entry]) => [
                    skillName,
                    {
                      ...(entry.visible === undefined ? {} : { visible: entry.visible }),
                      ...(entry.invocation === undefined ? {} : { invocation: entry.invocation }),
                    },
                  ]),
                )
              }
              if (switches.tools !== undefined) {
                const tools = ConfigAgent.mergeTools(agent.tools, switches.tools)
                const entries = Object.fromEntries(
                  Object.entries(tools.entries ?? {}).map(([name, value]) => [
                    name,
                    {
                      visible: value.visible ?? true,
                      ...(value.delegable === undefined ? {} : { delegable: value.delegable }),
                      permission: value.permission ?? "allow",
                      ...(value.scope ? { scope: { mode: value.scope.mode, ...(value.scope.projects ? { projects: [...value.scope.projects] } : {}) } } : {}),
                      ...(value.projectPermissions ? { projectPermissions: { ...value.projectPermissions } } : {}),
                    },
                  ]),
                )
                agent.tools = { mode: tools.mode, entries }
                for (const [name, value] of Object.entries(entries)) {
                  if (name === ConfigAgent.SWITCH_TOOL && value.visible && value.permission !== "deny") continue
                  agent.permissions.push({
                    action: ConfigAgent.toolPermissionAction(name),
                    resource: "*",
                    effect: value.visible ? value.permission : "deny",
                  })
                }
              }
              if (item.completion !== undefined) {
                agent.completion = {
                  mode: item.completion.mode,
                  prompt: [item.completion.prompt, ...sources.completion].filter(Boolean).join("\n\n") || undefined,
                }
              }
              if (item.description !== undefined) agent.description = item.description
              if (item.mode !== undefined) agent.mode = item.mode
              if (item.hidden !== undefined) agent.hidden = item.hidden
              if (item.color !== undefined) agent.color = item.color
              if (item.steps !== undefined) agent.steps = item.steps
              if (item.tool_budget !== undefined) {
                agent.toolBudget = { ...agent.toolBudget, ...item.tool_budget }
              }
              if (switches.permissions.length > 0) agent.permissions.push(...switches.permissions)
            })
          }
        }

        // A project agent can narrow its tool list, but cannot override central project availability.
        for (const [id, central] of Object.entries(centralAgents)) {
          if (!central?.tools?.entries) continue
          editor.update(AgentV2.ID.make(id), (current) => {
            const entries = { ...(current.tools?.entries ?? {}) }
            const mode = current.tools?.mode ?? "inherit"
            for (const [name, configured] of Object.entries(central.tools?.entries ?? {})) {
              if (!configured.scope && !configured.projectPermissions) continue
              const local = Wildcard.all(name, entries)
              if (mode === "explicit" && !local) continue
              const visible = (local?.visible ?? configured.visible ?? true) && ConfigAgent.projectScopeAllows(configured.scope, location?.project.directory ?? "")
              entries[name] = {
                ...(local ?? { visible: true, permission: configured.permission ?? "allow" }),
                visible,
                permission: visible ? (local?.permission ?? configured.permission ?? "allow") : "deny",
                ...(configured.scope ? { scope: { mode: configured.scope.mode, ...(configured.scope.projects ? { projects: [...configured.scope.projects] } : {}) } } : {}),
                ...(configured.projectPermissions ? { projectPermissions: { ...configured.projectPermissions } } : {}),
              }
              if (!visible) {
                current.permissions.push({ action: ConfigAgent.toolPermissionAction(name), resource: "*", effect: "deny" })
                continue
              }
              const override = location && ConfigAgent.projectPermissionForPath(configured.projectPermissions, location.project.directory)
              if (override) current.permissions.push({ action: ConfigAgent.toolPermissionAction(name), resource: "*", effect: override })
            }
            current.tools = { mode, entries }
          })
        }
      })
    })

    function syncWatchers(configEntries: Config.Entry[], documents: Config.Document[]) {
      configFiles = new Set(
        configEntries.flatMap((entry) =>
          entry.type === "document" && entry.path && path.isAbsolute(entry.path) ? [pathKey(entry.path)] : [],
        ),
      )
      configDirectories = new Set([
        ...configEntries.flatMap((entry) => {
          if (entry.type === "directory") return [pathKey(entry.path)]
          if (entry.path && path.isAbsolute(entry.path)) return [pathKey(path.dirname(entry.path))]
          return []
        }),
      ])
      agentDirectories = new Set(
        configEntries.flatMap((entry) => (entry.type === "directory" ? [pathKey(entry.path)] : [])),
      )
      promptFiles = new Set(
        documents.flatMap((document) => {
          const root = promptRoot(document.path)
          return Object.values(document.info.agents ?? {}).flatMap((item) => {
            const files = [
              ...(item.system && typeof item.system !== "string" ? (item.system.files ?? []) : []),
              ...(item.completion?.files ?? []),
            ]
            return files.flatMap((file) => {
              const target = path.isAbsolute(file) ? file : root ? path.resolve(root, file) : undefined
              return target && promptExtensions.has(path.extname(target).toLowerCase()) ? [pathKey(target)] : []
            })
          })
        }),
      )

      const targets = new Map<string, { directory: string; recursive: boolean }>()
      const addTarget = (directory: string, recursive = false) => {
        const resolved = path.resolve(directory)
        const key = pathKey(resolved)
        targets.set(key, { directory: resolved, recursive: recursive || targets.get(key)?.recursive === true })
      }
      for (const directory of configDirectories) addTarget(directory)
      for (const directory of agentDirectories) {
        addTarget(directory)
        for (const name of agentDirectoryNames) {
          const nested = path.join(directory, name)
          if (existsSync(nested)) addTarget(nested, name === "agent" || name === "agents")
        }
      }
      for (const prompt of promptFiles) addTarget(path.dirname(prompt))

      for (const [key, entry] of watchers) {
        if (targets.has(key)) continue
        entry.watcher.close()
        watchers.delete(key)
      }
      for (const target of targets.values()) watchDirectory(target.directory, target.recursive)
    }

    const refresh = Effect.fn("ConfigAgentPlugin.refresh")(function* () {
      yield* applyConfig(yield* config.entries({ refresh: true }))
    })
    yield* applyConfig(initialEntries)
    if (agent.registerRefresh) yield* agent.registerRefresh(refresh)
  }),
})

export function shouldInvalidateAgent(input: {
  directory: string
  filename: string | Buffer | null
  configFiles: ReadonlySet<string>
  configDirectories: ReadonlySet<string>
  agentDirectories: ReadonlySet<string>
  promptFiles: ReadonlySet<string>
}) {
  if (input.filename === null) return false
  const changedPath = path.resolve(input.directory, input.filename.toString().replaceAll("\\", "/"))
  const changed = pathKey(changedPath)
  if (input.configFiles.has(changed) || input.promptFiles.has(changed)) return true
  if (
    configFileNames.has(path.basename(changedPath).toLowerCase()) &&
    input.configDirectories.has(pathKey(path.dirname(changedPath)))
  ) return true

  for (const directory of input.agentDirectories) {
    const relative = path.relative(directory, changedPath)
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue
    const parts = relative.split(path.sep)
    const category = parts[0]?.toLowerCase()
    if (!category || !agentDirectoryNames.has(category)) continue
    if (parts.length === 1) return true
    if (path.extname(parts.at(-1)!).toLowerCase() !== ".md") continue
    if ((category === "mode" || category === "modes") && parts.length !== 2) continue
    return true
  }
  return false
}

function pathKey(value: string) {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

const promptExtensions = new Set([".md", ".txt", ".prompt"])

function promptRoot(documentPath?: string) {
  if (!documentPath) return
  const directory = path.dirname(documentPath)
  return path.basename(directory).toLowerCase() === ".opencode" ? path.dirname(directory) : directory
}

function readPromptFiles(fs: FSUtil.Interface, documentPath: string | undefined, files: readonly string[]) {
  const root = promptRoot(documentPath)
  return Effect.forEach(
    files,
    (file) =>
      Effect.gen(function* () {
        const explicitlyAbsolute = path.isAbsolute(file)
        if (!explicitlyAbsolute && !root) {
          yield* Effect.logWarning("Skipping relative agent prompt file without a configuration root", { file })
          return
        }
        const requested = FSUtil.resolve(explicitlyAbsolute ? file : path.join(root!, file))
        if (!explicitlyAbsolute && !FSUtil.contains(FSUtil.resolve(root!), requested)) {
          yield* Effect.logWarning("Skipping agent prompt file outside the project", { file })
          return
        }
        const canonical = yield* fs.realPath(requested).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (
          !canonical ||
          !promptExtensions.has(path.extname(requested).toLowerCase()) ||
          !promptExtensions.has(path.extname(canonical).toLowerCase())
        ) {
          yield* Effect.logWarning("Skipping missing or unsupported agent prompt file", { file })
          return
        }
        const content = yield* fs.readFileStringSafe(canonical).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!content) {
          yield* Effect.logWarning("Skipping empty or unreadable agent prompt file", { file })
          return
        }
        return content
      }),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((contents) => contents.filter((content): content is string => content !== undefined)))
}

function discover(fs: FSUtil.Interface, directory: string) {
  return Effect.forEach(legacySources, (source) =>
    fs
      .glob(source.pattern, { cwd: directory, absolute: true, dot: true, symlink: true })
      .pipe(
        Effect.map((files) => files.toSorted().map((filepath) => ({ directory, filepath, primary: source.primary }))),
      ),
  ).pipe(
    Effect.map((files) => files.flat()),
    Effect.catch(() => Effect.succeed([])),
  )
}

function decode(file: { directory: string; filepath: string; primary: boolean }, content: string) {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return
  const name = path
    .relative(file.directory, file.filepath)
    .replaceAll("\\", "/")
    .replace(/^(agent|agents|mode|modes)\//, "")
    .replace(/\.md$/, "")
  const body = markdown.content.trim()
  const configuredTools = markdown.data.tools
  const configuredPermissions = markdown.data.permissions
  const legacy =
    Object.keys(markdown.data).some((key) => !agentKeys.has(key)) ||
    (configuredTools !== undefined &&
      typeof configuredTools === "object" &&
      !Array.isArray(configuredTools) &&
      !("mode" in configuredTools)) ||
    (configuredPermissions !== undefined &&
      typeof configuredPermissions === "object" &&
      !Array.isArray(configuredPermissions))
  const configuredSystem = markdown.data.system
  const system =
    configuredSystem && typeof configuredSystem === "object" && !Array.isArray(configuredSystem)
      ? {
          ...configuredSystem,
          prompt: [typeof configuredSystem.prompt === "string" ? configuredSystem.prompt.trim() : "", body]
            .filter(Boolean)
            .join("\n\n"),
        }
      : [typeof configuredSystem === "string" ? configuredSystem.trim() : "", body].filter(Boolean).join("\n\n") ||
        undefined
  const agent = Option.getOrUndefined(
    legacy
      ? Option.map(
          decodeLegacyAgent({ name, ...markdown.data, prompt: body }, { errors: "all", propertyOrder: "original" }),
          ConfigMigrateV1.migrateAgent,
        )
      : decodeAgent({ ...markdown.data, system }, { errors: "all", propertyOrder: "original" }),
  )
  if (!agent) return
  const info = Option.getOrUndefined(
    decodeConfig({
      agents: { [name]: file.primary ? { ...agent, mode: "primary" } : agent },
    }),
  )
  if (!info) return
  return new Config.Document({ type: "document", path: file.filepath, info })
}
