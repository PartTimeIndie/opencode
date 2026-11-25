import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/layer-node-platform"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import { mergeDeep } from "remeda"
import { Global } from "@opencode-ai/core/global"
import fsNode from "fs/promises"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Auth } from "../auth"
import { Env } from "../env"
import { applyEdits, modify } from "jsonc-parser"
import { existsSync } from "fs"
import { Account } from "@/account/account"
import { isRecord } from "@opencode-ai/core/util/record"
import type { ConsoleState } from "@opencode-ai/core/v1/config/console-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Cause, Context, Duration, Effect, Exit, Fiber, Layer, Option, Schema, ScopedCache, Semaphore } from "effect"

import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { ConfigFileWriter } from "@opencode-ai/core/config/file-writer"
import { ConfigFileTarget } from "@opencode-ai/core/config/file-target"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { mergeTools, Tools } from "@opencode-ai/core/config/agent"
import { RemoteAuthError } from "@opencode-ai/core/v1/config/error"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { ConfigPluginV1 } from "@opencode-ai/core/v1/config/plugin"
import { ConfigAgent } from "./agent"
import { ConfigCommand } from "./command"
import { ConfigManaged } from "./managed"
import { ConfigParse } from "./parse"
import { ConfigPaths } from "./paths"
import { ConfigPlugin } from "./plugin"
import { ConfigVariable } from "./variable"
import { Npm } from "@opencode-ai/core/npm"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { pluginDependency } from "./dependency"

// Explicit lists replace; inheritance carries sparse overrides across config scopes.
// Keep remeda's deep conditional merge type out of hot config-loading paths; TS profiling showed it dominates here.
function mergeConfig(target: Info, source: Info): Info {
  const merged = mergeDeep(target, source) as Info
  for (const key of ["agent", "mode"] as const) {
    for (const [id, agent] of Object.entries(source[key] ?? {})) {
      const current = merged[key]?.[id]
      if (!agent || !current) continue
      const tools =
        isRecord(agent.tools) && "mode" in agent.tools
          ? agent.tools
          : agent.options?.__agentTools
            ? ConfigParse.schema(ConfigAgentV1.Info, { tools: agent.options.__agentTools }, `agent:${id}:tools`).tools
            : undefined
      if (!tools || !("mode" in tools)) continue
      const previous = target[key]?.[id]
      const inherited = previous?.tools && "mode" in previous.tools ? previous.tools : previous?.options?.__agentTools
      const policy = ConfigParse.schema(ConfigAgentV1.Info, { tools: mergeTools(
        inherited ? Schema.decodeUnknownSync(Tools)(inherited) : undefined,
        Schema.decodeUnknownSync(Tools)(tools),
      ) }, `agent:${id}:tools`).tools
      merged[key] = {
        ...merged[key],
        [id]: { ...current, tools: policy, options: { ...current.options, __agentTools: policy } },
      }
    }
  }
  return merged
}

function normalizeLegacyModes(info: Info): Info {
  // Remote patches are still raw here. Leave malformed modes for sourced schema
  // validation rather than hiding invalid input while migrating the alias.
  if (!isRecord(info.mode) || Object.values(info.mode).some((mode) => !isRecord(mode))) return info
  // Migrate each document before scope merging; replaying the accumulated mode
  // map at the end lets an older global definition overwrite a project agent.
  const next = mergeConfig(info, {
    agent: Object.fromEntries(
      Object.entries(info.mode).map(([id, mode]) => [id, { ...mode, mode: "primary" as const }]),
    ),
  })
  delete next.mode
  return next
}

function mergeConfigConcatArrays(target: Info, source: Info): Info {
  const merged = mergeConfig(target, source)
  if (target.instructions && source.instructions) {
    merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
  }
  return merged
}

function normalizeLoadedConfig(data: unknown) {
  if (!isRecord(data)) return data
  const copy = { ...data }
  const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy
  if (!hadLegacy) return copy
  delete copy.theme
  delete copy.keybinds
  delete copy.tui
  return copy
}

async function substituteWellKnownRemoteConfig(input: {
  value: unknown
  dir: string
  source: string
  env: Record<string, string>
}) {
  if (!isRecord(input.value) || typeof input.value.url !== "string") return undefined

  const url = await ConfigVariable.substitute({
    text: input.value.url,
    type: "virtual",
    dir: input.dir,
    source: input.source,
    env: input.env,
  })
  const headers = isRecord(input.value.headers)
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(input.value.headers)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .map(async ([key, value]) => [
              key,
              await ConfigVariable.substitute({
                text: value,
                type: "virtual",
                dir: input.dir,
                source: input.source,
                env: input.env,
              }),
            ]),
        ),
      )
    : undefined

  return { url, headers }
}

async function resolveLoadedPlugins<T extends { plugin?: ConfigPluginV1.Spec[] }>(config: T, filepath: string) {
  if (!config.plugin) return config
  for (let i = 0; i < config.plugin.length; i++) {
    // Normalize path-like plugin specs while we still know which config file declared them.
    // This prevents `./plugin.ts` from being reinterpreted relative to some later merge location.
    config.plugin[i] = await ConfigPlugin.resolvePluginSpec(config.plugin[i], filepath)
  }
  return config
}

type Info = ConfigV1.Info & {
  // plugin_origins is derived state, not a persisted config field. It keeps each winning plugin spec together
  // with the file and scope it came from so later runtime code can make location-sensitive decisions.
  plugin_origins?: ConfigPlugin.Origin[]
}

// Global update input: same shape as the stored config, but default_model_chain
// also accepts null as an explicit clear (JSON bodies cannot carry undefined).
type UpdateInfo = ConfigV1.UpdateInfo

type State = {
  config: Info
  directories: string[]
  deps: Fiber.Fiber<void>[]
  token: ConfigEntryToken
  consoleState: ConsoleState
}

// Identity of one cached config entry; the entry scope's finalizer marks it
// retired when invalidation closes the scope (attribution without secrets).
interface ConfigEntryToken {
  readonly directory: string
}

// Narrow lifecycle observability for the still-needed bootstrap contract:
// notified after waitForDependencies snapshots the current entry and before
// it joins that entry's dependency fibers. Production wires no probe
// (serviceOption skips), so runtime semantics are unchanged; tests provide a
// probe to order deterministically (snapshot taken, join not yet finished)
// before invalidating. The probe alone only proves the snapshot point was
// reached; the join being actually parked is proven by the join-blocked gate
// below (waiter still unfinished when invalidate fires).
export class WaitJoinProbe extends Context.Service<WaitJoinProbe, {
  readonly snapshot: (info: { directory: string }) => Effect.Effect<void>
}>()("@opencode/ConfigWaitJoinProbe") {}

// Default-neutral seam: production resolves to 2 retirement retries when no
// override is wired. The isolated discriminator RED wires { retries: 0 }.
export class MaxDependencyRetireRetries extends Context.Service<MaxDependencyRetireRetries, {
  readonly retries: number
}>()("@opencode/ConfigMaxDependencyRetireRetries") {}

export function requiresInstanceReload(config: ConfigV1.Info | ConfigV1.UpdateInfo) {
  // Agent/mode remain reload-required for the global route; project PATCHes
  // must check requiresAgentRefresh before using this broader classification.
  return Object.keys(config).some((key) => requiresInstanceReloadKey(config, key))
}

export function requiresAgentRefresh(config: ConfigV1.Info | ConfigV1.UpdateInfo) {
  return (
    (config.agent !== undefined || config.mode !== undefined) &&
    !Object.keys(config).some((key) => key !== "agent" && key !== "mode" && requiresInstanceReloadKey(config, key))
  )
}

function requiresInstanceReloadKey(config: ConfigV1.Info | ConfigV1.UpdateInfo, key: string) {
  return (
    key !== "$schema" &&
    key !== "optimization" &&
    key !== "logging" &&
    key !== "project_icon_generation" &&
    (key !== "access_control" || config.access_control?.safety_review !== undefined) &&
    key !== "multi_agent"
  )
}

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly getConsoleState: () => Effect.Effect<ConsoleState>
  readonly update: (config: Info) => Effect.Effect<void>
  readonly updateGlobal: (config: UpdateInfo) => Effect.Effect<{ info: Info; changed: boolean }>
  readonly invalidate: () => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Config") {}

export const use = serviceUse(Service)

function globalConfigFile() {
  return ConfigFileTarget.global(Global.Path.config)
}

function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
  if (
    !isRecord(patch) ||
    (path.length === 1 && path[0] === "vision") ||
    (path.length === 2 && path[0] === "access_control" && path[1] === "safety_review") ||
    (path.length === 3 && path[0] === "agent" && path[2] === "tools")
  ) {
    const edits = modify(input, path, patch, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    return applyEdits(input, edits)
  }

  return Object.entries(patch).reduce((result, [key, value]) => patchJsonc(result, value, [...path, key]), input)
}

function writable(info: Info) {
  const { plugin_origins: _plugin_origins, ...next } = info
  if (next.agent) {
    next.agent = Object.fromEntries(
      Object.entries(next.agent).map(([id, value]) => [id, value ? (ConfigAgentV1.persisted(value) as typeof value) : value]),
    )
  }
  return next
}

function writableGlobal(info: Info): Info {
  const result = writable(info)
  // When a user changes config from a value back to default in the Desktop app, we don't want to leave a blank `"shell": "",` key
  if ("shell" in result && result.shell === "") return { ...result, shell: undefined }
  return result
}

function mergeGlobalConfig(target: Info, source: Info) {
  const merged = mergeConfig(target, source)
  if (source.vision !== undefined) merged.vision = source.vision
  if (source.access_control?.safety_review !== undefined) {
    merged.access_control = { ...merged.access_control, safety_review: source.access_control.safety_review }
  }
  for (const [id, agent] of Object.entries(source.agent ?? {})) {
    const current = merged.agent?.[id]
    const previous = target.agent?.[id]
    if (!current || !agent) continue
    if (previous?.permission) current.permission = { ...previous.permission, ...(agent.permission ?? {}) }
  }
  return merged
}

type SkillPolicyPatch = NonNullable<ConfigV1.UpdateInfo["skill_policy"]>

type SkillEntryStored = { visible?: boolean; invocation?: "allow" | "ask" | "manual" | "deny" }

function cleanSkillPolicyEntries(
  stored: Record<string, SkillEntryStored> | undefined,
  patch: Record<string, { visible?: boolean | null; invocation?: "allow" | "ask" | "manual" | "deny" | null }>,
): Record<string, SkillEntryStored> {
  const entries: Record<string, SkillEntryStored> = { ...(stored ?? {}) }
  for (const [name, entry] of Object.entries(patch)) {
    if (!isRecord(entry)) continue
    const current: SkillEntryStored = { ...entries[name] }
    const visible = entry.visible
    if (visible === null) delete current.visible
    else if (visible !== undefined) current.visible = visible
    const invocation = entry.invocation
    if (invocation === null) delete current.invocation
    else if (invocation !== undefined) current.invocation = invocation
    if ("visible" in current || "invocation" in current) entries[name] = current
    else delete entries[name]
  }
  return entries
}

/**
 * Apply a skill_policy update patch. Null deletes exactly that stored field;
 * empty entries are removed. The result never contains null.
 */
export function applySkillPolicyPatch(existing: Info, patch: SkillPolicyPatch | undefined): Info {
  if (!patch) return existing
  let next = existing
  if (patch.global) {
    const stored = next.skill_invocation ?? {}
    const entries = cleanSkillPolicyEntries(stored.entries, patch.global)
    const skillInvocation = { ...stored }
    if (Object.keys(entries).length === 0) delete skillInvocation.entries
    else skillInvocation.entries = entries
    next = { ...next, skill_invocation: skillInvocation }
  }
  if (patch.agents) {
    const agents = { ...(next.agent ?? {}) }
    for (const [id, skills] of Object.entries(patch.agents)) {
      const storedAgent = agents[id]
      if (!isRecord(storedAgent)) continue
      const agent = { ...storedAgent }
      const cleaned = cleanSkillPolicyEntries(agent.skills, skills)
      if (Object.keys(cleaned).length === 0) delete agent.skills
      else agent.skills = cleaned
      agents[id] = agent
    }
    next = { ...next, agent: agents }
  }
  return next
}

function jsonEquals(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

/**
 * Rewrite only the skill-policy subtrees in JSONC text via atomic subtree
 * replacement, preserving comments and formatting everywhere else. The parent
 * object is always written as a cleaned (null-free) value, so field-level
 * deletions take effect without storing null.
 */
function applySkillPolicyJsonc(input: string, before: Info, final: Info): string {
  let result = input
  if (!jsonEquals(before.skill_invocation, final.skill_invocation)) {
    const edits = modify(result, ["skill_invocation"], final.skill_invocation ?? {}, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    })
    result = applyEdits(result, edits)
  }
  for (const [id, agent] of Object.entries(final.agent ?? {})) {
    const beforeAgent = before.agent?.[id]
    if (jsonEquals(beforeAgent?.skills, agent.skills)) continue
    const edits = modify(result, ["agent", id], agent, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    })
    result = applyEdits(result, edits)
  }
  return result
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const writer = yield* ConfigFileWriter.Service.pipe(Effect.provide(ConfigFileWriter.layer))
    const authSvc = yield* Auth.Service
    const accountSvc = yield* Account.Service
    const env = yield* Env.Service
    const npmSvc = yield* Npm.Service
    const http = yield* HttpClient.HttpClient
    // Global and project config writes are read-merge-write on a shared file.
    // Concurrent writers (several app windows against one server) must not
    // interleave, or a writer that read an older base silently reverts newer
    // keys; the semaphore serializes every write in arrival order.
    const configWriteLock = yield* Semaphore.make(1)

    const readConfigFile = (filepath: string) => fs.readFileStringSafe(filepath).pipe(Effect.orDie)

    const fetchRemoteJson = Effect.fnUntraced(function* <S extends Schema.Top>(
      url: string,
      headers: Record<string, string> | undefined,
      schema: S,
      loginOrigin: string,
    ) {
      const response = yield* HttpClient.filterStatusOk(withTransientReadRetry(http))
        .execute(
          HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.setHeaders(headers ?? {})),
        )
        .pipe(
          Effect.catch((error) => Effect.die(new Error(`failed to fetch remote config from ${url}: ${String(error)}`))),
        )
      const body = yield* response.text.pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to read remote config from ${url}: ${String(error)}`))),
      )
      // An auth proxy can answer with an HTML login page at HTTP 200 (passes filterStatusOk); treat it as a re-auth error, not a decode failure.
      const contentType = (response.headers["content-type"] ?? "").toLowerCase()
      if (contentType.includes("html") || /^\s*<!doctype|^\s*<html/i.test(body)) {
        return yield* Effect.die(new RemoteAuthError({ url: loginOrigin, remote: url }))
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to decode remote config from ${url}: ${String(error)}`))),
      )
    })

    const loadConfig = Effect.fnUntraced(function* (
      text: string,
      options: { path: string } | { dir: string; source: string },
      env?: Record<string, string>,
    ) {
      const source = "path" in options ? options.path : options.source
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute(
          "path" in options
            ? { text, type: "path", path: options.path, env }
            : { text, type: "virtual", ...options, env },
        ),
      )
      const parsed = ConfigParse.jsonc(expanded, source)
      const data = normalizeLegacyModes(ConfigParse.schema(ConfigV1.Info, normalizeLoadedConfig(parsed), source))
      if (!("path" in options)) return data

      yield* Effect.promise(() => resolveLoadedPlugins(data, options.path))
      if (!data.$schema) {
        data.$schema = "https://opencode.ai/config.json"
        const updated = text.replace(/^\s*\{/, '{\n  "$schema": "https://opencode.ai/config.json",')
        yield* fs.writeFileString(options.path, updated).pipe(Effect.catch(() => Effect.void))
      }
      return data
    })

    const loadFile = Effect.fnUntraced(function* (filepath: string, env?: Record<string, string>) {
      yield* Effect.logInfo("loading", { path: filepath })
      const text = yield* readConfigFile(filepath)
      if (!text) return {} as Info
      return yield* loadConfig(text, { path: filepath }, env)
    })

    const loadGlobal = Effect.fnUntraced(function* (env?: Record<string, string>) {
      let result: Info = {}
      // Seed the default global config with the schema for editor completion, but avoid writing when the user
      // explicitly routes config through env-provided paths or content.
      if (!Flag.OPENCODE_CONFIG && !Flag.OPENCODE_CONFIG_DIR && !Flag.OPENCODE_CONFIG_CONTENT) {
        const file = globalConfigFile()
        if (!existsSync(file)) {
          yield* fs
            .writeWithDirs(file, JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2))
            .pipe(Effect.catch(() => Effect.void))
        }
      }
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "config.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "opencode.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "opencode.jsonc"), env))

      const legacy = path.join(Global.Path.config, "config")
      if (existsSync(legacy)) {
        yield* Effect.promise(() =>
          import(pathToFileURL(legacy).href, { with: { type: "toml" } })
            .then(async (mod) => {
              const { provider, model, ...rest } = mod.default
              if (provider && model) result.model = `${provider}/${model}`
              result["$schema"] = "https://opencode.ai/config.json"
              result = mergeConfig(result, normalizeLegacyModes(ConfigParse.schema(ConfigV1.Info, rest, legacy)))
              await fsNode.writeFile(path.join(Global.Path.config, "config.json"), JSON.stringify(result, null, 2))
              await fsNode.unlink(legacy)
            })
            .catch(() => {}),
        )
      }

      return result
    })

    const globalState = yield* ScopedCache.makeWith({
      capacity: 1,
      // Request cancellation must not poison every later config/provider read.
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
      lookup: (_key: string) =>
        loadGlobal().pipe(
          Effect.tapError((error) =>
            Effect.logError("failed to load global config, using defaults", { error: String(error) }),
          ),
          Effect.orElseSucceed((): Info => ({})),
        ),
    })

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      return yield* ScopedCache.get(globalState, "global")
    })

    const ensureGitignore = Effect.fn("Config.ensureGitignore")(function* (dir: string) {
      yield* fs.ensureDir(dir)
      const gitignore = path.join(dir, ".gitignore")
      const hasIgnore = yield* fs.existsSafe(gitignore)
      if (!hasIgnore) {
        yield* fs
          .writeFileString(
            gitignore,
            ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n"),
          )
          .pipe(
            Effect.catchIf(
              (e) => e.reason._tag === "PermissionDenied",
              () => Effect.void,
            ),
          )
      }
    })

    const loadInstanceState = Effect.fn("Config.loadInstanceState")(
      function* (ctx: InstanceContext) {
        const auth = yield* authSvc.all().pipe(Effect.orDie)

        let result: Info = {}
        const authEnv: Record<string, string> = {}
        const consoleManagedProviders = new Set<string>()
        let activeOrgName: string | undefined

        const pluginScopeForSource = Effect.fnUntraced(function* (source: string) {
          if (source.startsWith("http://") || source.startsWith("https://")) return "global"
          if (source === "OPENCODE_CONFIG_CONTENT") return "local"
          if (containsPath(source, ctx)) return "local"
          return "global"
        })

        const mergePluginOrigins = Effect.fnUntraced(function* (
          source: string,
          // mergePluginOrigins receives raw Specs from one config source, before provenance for this merge step
          // is attached.
          list: ConfigPluginV1.Spec[] | undefined,
          // Scope can be inferred from the source path, but some callers already know whether the config should
          // behave as global or local and can pass that explicitly.
          kind?: ConfigPlugin.Scope,
        ) {
          if (!list?.length) return
          const hit = kind ?? (yield* pluginScopeForSource(source))
          // Merge newly seen plugin origins with previously collected ones, then dedupe by plugin identity while
          // keeping the winning source/scope metadata for downstream installs, writes, and diagnostics.
          const plugins = ConfigPlugin.deduplicatePluginOrigins([
            ...(result.plugin_origins ?? []),
            ...list.map((spec) => ({ spec, source, scope: hit })),
          ])
          result.plugin = plugins.map((item) => item.spec)
          result.plugin_origins = plugins
        })

        const merge = (source: string, next: Info, kind?: ConfigPlugin.Scope) => {
          result = mergeConfigConcatArrays(result, next)
          return mergePluginOrigins(source, next.plugin, kind)
        }

        for (const [key, value] of Object.entries(auth)) {
          if (value.type === "wellknown") {
            const url = key.replace(/\/+$/, "")
            authEnv[value.key] = value.token
            const wellknownURL = `${url}/.well-known/opencode`
            yield* Effect.logDebug("fetching remote config", { url: wellknownURL })
            const wellknown = yield* fetchRemoteJson(wellknownURL, undefined, ConfigV1.WellKnown, url)
            const remote = yield* Effect.promise(() =>
              substituteWellKnownRemoteConfig({
                value: wellknown.remote_config,
                dir: url,
                source: wellknownURL,
                env: authEnv,
              }),
            )
            const fetchedConfig = remote
              ? yield* Effect.gen(function* () {
                  yield* Effect.logDebug("fetching remote config", { url: remote.url })
                  const data = yield* fetchRemoteJson(remote.url, remote.headers, Schema.Json, url)
                  if (isRecord(data) && isRecord(data.config)) return data.config
                  if (isRecord(data)) return data
                  return yield* Effect.die(
                    new Error(`failed to decode remote config from ${remote.url}: expected object`),
                  )
                })
              : {}
            // Remote config can be a partial patch. Migrate aliases per source,
            // but validate known fields only after combining both documents.
            const remoteConfig = mergeConfig(
              normalizeLegacyModes(isRecord(wellknown.config) ? wellknown.config : {}),
              normalizeLegacyModes(fetchedConfig),
            )
            if (!remoteConfig.$schema) remoteConfig.$schema = "https://opencode.ai/config.json"
            const source = wellknownURL
            const next = yield* loadConfig(
              JSON.stringify(remoteConfig),
              { dir: path.dirname(source), source },
              authEnv,
            )
            yield* merge(source, next, "global")
            yield* Effect.logDebug("loaded remote config from well-known", { url })
          }
        }

        const global = Object.keys(authEnv).length ? yield* loadGlobal(authEnv) : yield* getGlobal()
        yield* merge(Global.Path.config, global, "global")

        if (Flag.OPENCODE_CONFIG) {
          yield* merge(Flag.OPENCODE_CONFIG, yield* loadFile(Flag.OPENCODE_CONFIG, authEnv))
          yield* Effect.logDebug("loaded custom config", { path: Flag.OPENCODE_CONFIG })
        }

        if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
          for (const file of yield* ConfigPaths.files("opencode", ctx.directory, ctx.worktree).pipe(Effect.orDie)) {
            yield* merge(file, yield* loadFile(file, authEnv), "local")
          }
        }

        result.agent = result.agent || {}
        result.mode = result.mode || {}
        result.plugin = result.plugin || []

        const directories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree)

        if (Flag.OPENCODE_CONFIG_DIR) {
          yield* Effect.logDebug("loading config from OPENCODE_CONFIG_DIR", { path: Flag.OPENCODE_CONFIG_DIR })
        }

        const deps: Fiber.Fiber<void>[] = []

        for (const dir of directories) {
          if (dir.endsWith(".opencode") || dir === Flag.OPENCODE_CONFIG_DIR) {
            for (const file of ["opencode.json", "opencode.jsonc"]) {
              const source = path.join(dir, file)
              yield* Effect.logDebug(`loading config from ${source}`)
              yield* merge(source, yield* loadFile(source, authEnv))
              result.agent ??= {}
              result.mode ??= {}
              result.plugin ??= []
            }
          }

          yield* ensureGitignore(dir).pipe(Effect.orDie)

          if (!Flag.OPENCODE_PURE) {
            const dep = yield* npmSvc
              .install(dir, pluginDependency())
              .pipe(
                Effect.exit,
                Effect.tap((exit) =>
                  Exit.isFailure(exit)
                    ? Effect.logWarning("background dependency install failed", { dir, error: String(exit.cause) })
                    : Effect.void,
                ),
                Effect.asVoid,
                // Config invalidation must cancel installs before a replacement
                // instance waits for the same dependency lock.
                Effect.forkScoped,
              )
            deps.push(dep)
          }

          result.command = mergeDeep(result.command ?? {}, yield* Effect.promise(() => ConfigCommand.load(dir)))
          result = mergeConfig(result, { agent: yield* Effect.promise(() => ConfigAgent.load(dir)) })
          result = mergeConfig(result, { agent: yield* Effect.promise(() => ConfigAgent.loadMode(dir)) })
          // Auto-discovered plugins under `.opencode/plugin(s)` are already local files, so ConfigPlugin.load
          // returns normalized Specs and we only need to attach origin metadata here.
          const list = yield* Effect.promise(() => ConfigPlugin.load(dir))
          yield* mergePluginOrigins(dir, list)
        }

        if (process.env.OPENCODE_CONFIG_CONTENT) {
          const source = "OPENCODE_CONFIG_CONTENT"
          const next = yield* loadConfig(process.env.OPENCODE_CONFIG_CONTENT, {
            dir: ctx.directory,
            source,
          })
          yield* merge(source, next, "local")
          yield* Effect.logDebug("loaded custom config from OPENCODE_CONFIG_CONTENT")
        }

        const activeAccount = Option.getOrUndefined(
          yield* accountSvc.active().pipe(Effect.catch(() => Effect.succeed(Option.none()))),
        )
        if (activeAccount?.active_org_id) {
          const accountID = activeAccount.id
          const orgID = activeAccount.active_org_id
          const url = activeAccount.url
          yield* Effect.gen(function* () {
            const [configOpt, tokenOpt] = yield* Effect.all(
              [accountSvc.config(accountID, orgID), accountSvc.token(accountID)],
              { concurrency: 2 },
            )
            if (Option.isSome(tokenOpt)) {
              process.env["OPENCODE_CONSOLE_TOKEN"] = tokenOpt.value
              yield* env.set("OPENCODE_CONSOLE_TOKEN", tokenOpt.value)
            }

            if (Option.isSome(configOpt)) {
              const source = `${url}/api/config`
              const next = yield* loadConfig(JSON.stringify(configOpt.value), {
                dir: path.dirname(source),
                source,
              })
              for (const providerID of Object.keys(next.provider ?? {})) {
                consoleManagedProviders.add(providerID)
              }
              yield* merge(source, next, "global")
            }
          }).pipe(
            Effect.withSpan("Config.loadActiveOrgConfig"),
            Effect.catch((err) =>
              Effect.logDebug("failed to fetch remote account config", {
                error: err instanceof Error ? err.message : String(err),
              }),
            ),
          )
        }

        const managedDir = ConfigManaged.managedConfigDir()
        if (existsSync(managedDir)) {
          for (const file of ["opencode.json", "opencode.jsonc"]) {
            const source = path.join(managedDir, file)
            yield* merge(source, yield* loadFile(source), "global")
          }
        }

        // macOS managed preferences (.mobileconfig deployed via MDM) override everything
        const managed = yield* Effect.promise(() => ConfigManaged.readManagedPreferences())
        if (managed) {
          result = mergeConfigConcatArrays(
            result,
            yield* loadConfig(managed.text, {
              dir: path.dirname(managed.source),
              source: managed.source,
            }),
          )
        }

        if (Flag.OPENCODE_PERMISSION) {
          try {
            result.permission = mergeDeep(result.permission ?? {}, JSON.parse(Flag.OPENCODE_PERMISSION))
          } catch (err) {
            yield* Effect.logWarning("OPENCODE_PERMISSION contains invalid JSON, skipping", { err })
          }
        }

        if (result.tools) {
          const perms: Record<string, ConfigPermissionV1.Action> = {}
          for (const [tool, enabled] of Object.entries(result.tools)) {
            const action: ConfigPermissionV1.Action = enabled ? "allow" : "deny"
            if (tool === "write" || tool === "edit" || tool === "patch") {
              perms.edit = action
              continue
            }
            perms[tool] = action
          }
          result.permission = mergeDeep(perms, result.permission ?? {})
        }

        if (!result.username) {
          try {
            result.username = os.userInfo().username || "user"
          } catch (err) {
            yield* Effect.logWarning("failed to read system username, using fallback", { err })
            result.username = "user"
          }
        }

        if (result.autoshare === true && !result.share) {
          result.share = "auto"
        }

        if (Flag.OPENCODE_DISABLE_AUTOCOMPACT) {
          result.compaction = { ...result.compaction, auto: false }
        }
        if (Flag.OPENCODE_DISABLE_PRUNE) {
          result.compaction = { ...result.compaction, prune: false }
        }

        const entryToken: ConfigEntryToken = { directory: ctx.directory }
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            retiredEntryTokens.add(entryToken)
            yield* Effect.logInfo("config entry scope retired", { directory: ctx.directory })
          }),
        )

        return {
          config: result,
          directories,
          deps,
          token: entryToken,
          consoleState: {
            consoleManagedProviders: Array.from(consoleManagedProviders),
            activeOrgName,
            switchableOrgCount: 0,
          },
        }
      },
      Effect.provideService(FSUtil.Service, fs),
    )

    const state = yield* InstanceState.make<State>(
      Effect.fn("Config.state")(function* (ctx) {
        return yield* loadInstanceState(ctx).pipe(Effect.orDie)
      }),
    )

    const get = Effect.fn("Config.get")(function* () {
      return yield* InstanceState.use(state, (s) => s.config)
    })

    const directories = Effect.fn("Config.directories")(function* () {
      return yield* InstanceState.use(state, (s) => s.directories)
    })

    const getConsoleState = Effect.fn("Config.getConsoleState")(function* () {
      return yield* InstanceState.use(state, (s) => s.consoleState)
    })

    // Retirement is bound to the actual cache entry: invalidation closes the
    // entry scope, whose finalizer marks the entry token retired and cancels
    // its dependency installs. A bootstrap that still needs dependencies
    // retries only when its OWN token was retired; a pure parent cancellation
    // terminates the waiting fiber before any retry can run, so an aborted
    // boot is never revived by a foreign invalidation. Real dependency
    // failures are never retried or swallowed.
    // NOTE: regular Npm.InstallFailedError from the background installs above
    // is already tolerated there (exit-log + asVoid): the dep fiber succeeds
    // and this join never sees it. Only a genuinely escaping failure or an
    // interrupt reaches the branches below; the "no-retry on real failure"
    // policy is pinned by the tolerated-failure gate in config.test.ts.
    // Weak membership: a retired token stays provable for as long as any
    // waiting bootstrap holds its snapshot, and is garbage-collected once
    // neither the cache nor a waiter references it — no arbitrary eviction
    // can drop provenance from a slow boot.
    const retiredEntryTokens = new WeakSet<ConfigEntryToken>()
    // Default-neutral seam for the discriminator RED: production keeps 2
    // retirement retries; an isolated RED copy wires 0 via this service to
    // prove the same snapshot-before-invalidate sequence fails without retry.
    // No live-source TEMP deactivation; production default is unchanged.
    const maxDependencyRetireRetries = yield* Effect.serviceOption(MaxDependencyRetireRetries).pipe(
      Effect.map((option) => (Option.isSome(option) ? option.value.retries : 2)),
    )
    const waitForDependencies = Effect.fn("Config.waitForDependencies")(function* () {
      for (let attempt = 0; ; attempt++) {
        const snapshot = yield* InstanceState.useEffect(state, (s) =>
          Effect.succeed({ deps: s.deps, token: s.token }),
        )
        const probe = yield* Effect.serviceOption(WaitJoinProbe)
        // Test-only ordering point: fires after the snapshot, before the
        // Fiber.join below. It orders snapshot-before-invalidate; it does not
        // by itself prove the waiter already registered the join.
        if (Option.isSome(probe)) {
          yield* probe.value.snapshot({ directory: snapshot.token.directory })
        }
        const exit = yield* Effect.forEach(snapshot.deps, (fiber) => Fiber.join(fiber), {
          concurrency: "unbounded",
        }).pipe(Effect.exit)
        if (Exit.isSuccess(exit)) return
        const retired =
          Exit.isFailure(exit) &&
          exit.cause.reasons.every((reason) => Cause.isInterruptReason(reason)) &&
          retiredEntryTokens.has(snapshot.token)
        if (retired && attempt < maxDependencyRetireRetries) {
          yield* Effect.logWarning("config entry retired while waiting for dependencies; retrying fresh generation", {
            directory: snapshot.token.directory,
          })
          yield* get()
          continue
        }
        return yield* Effect.failCause(exit.cause)
      }
    })

    const updateBody = Effect.fn("Config.update.write")(function* (config: Info) {
      const dir = yield* InstanceState.directory
      const file = ConfigFileTarget.project(dir)
      yield* writer.update({ file }, (current) => Effect.gen(function* () {
        const existing = yield* loadFile(file)
        const text = patchJsonc(current.text ?? "{}", writable(mergeConfig(existing, normalizeLegacyModes(config))))
        ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(text, file), file)
        return { text, value: undefined }
      })).pipe(Effect.orDie)
      yield* ScopedCache.invalidate(state.cache, dir)
    })

    const update = Effect.fn("Config.update")(function* (config: Info) {
      return yield* configWriteLock.withPermits(1)(updateBody(config))
    })

    const invalidate = Effect.fn("Config.invalidate")(function* () {
      yield* ScopedCache.invalidate(globalState, "global")
      yield* ScopedCache.invalidateAll(state.cache)
    })

    const updateGlobalBody = Effect.fn("Config.updateGlobal.write")(function* (config: UpdateInfo) {
      const file = globalConfigFile()
      const saved = yield* writer.update({ file }, (current) => Effect.sync(() => {
        const before = current.text ?? "{}"
        // JSON bodies cannot carry undefined, so clients unset the default with
        // null; the stored key must be deleted, not merged, or the old default
        // would survive every clear.
        const { default_model_chain: requestedDefault, skill_policy: skillPolicy, ...rest } = config
        const clearDefault = requestedDefault === null
        // An absent key must not touch the stored default on unrelated saves.
        const patch = writableGlobal({
          ...rest,
          ...(requestedDefault === undefined ? {} : { default_model_chain: clearDefault ? undefined : requestedDefault }),
        })

        if (!file.endsWith(".jsonc")) {
          const document = ConfigParse.jsonc(before, file)
          const existing = writableGlobal(ConfigParse.schema(ConfigV1.Info, document, file))
          const merged = writableGlobal(applySkillPolicyPatch(mergeGlobalConfig(existing, patch), skillPolicy))
          if (clearDefault) delete merged.default_model_chain
          // Older loaders ignore newer keys, but a settings save must not erase
          // them. Known keys still follow their normal clear/migration rules.
          const unknown = isRecord(document) ? Object.fromEntries(Object.entries(document).filter(([key]) => !(key in ConfigV1.Info.fields))) : {}
          return { text: JSON.stringify({ ...unknown, ...merged }, null, 2), value: merged }
        }
        const updated = patchJsonc(before, patch)
        const parsedUpdated = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(updated, file), file)
        const final = applySkillPolicyPatch(parsedUpdated, skillPolicy)
        const withPolicy = skillPolicy ? applySkillPolicyJsonc(updated, parsedUpdated, final) : updated
        return { text: withPolicy, value: ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(withPolicy, file), file) }
      })).pipe(Effect.orDie)

      if (saved.changed) {
        yield* invalidate()
      }
      return { info: saved.value, changed: saved.changed }
    })

    const updateGlobal = Effect.fn("Config.updateGlobal")(function* (config: UpdateInfo) {
      return yield* configWriteLock.withPermits(1)(updateGlobalBody(config))
    })

    return Service.of({
      get,
      getGlobal,
      getConsoleState,
      update,
      updateGlobal,
      invalidate,
      directories,
      waitForDependencies,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Account.defaultLayer),
  Layer.provide(Npm.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
)

export const node = LayerNode.make(layer, [FSUtil.node, Auth.node, Account.node, Env.node, Npm.node, httpClient, EffectFlock.node])

export * as Config from "./config"
