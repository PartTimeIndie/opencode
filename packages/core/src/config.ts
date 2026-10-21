export * as Config from "./config"

import path from "path"
import { type ParseError, parse } from "jsonc-parser"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Location } from "./location"
import { PermissionSchema } from "./permission/schema"
import { Policy } from "./policy"
import { AbsolutePath } from "./schema"
import { ConfigAgent } from "./config/agent"
import { ConfigAccessControl } from "./config/access-control"
import { ConfigAttachments } from "./config/attachments"
import { ConfigCapabilities } from "./config/capabilities"
import { ConfigCompaction } from "./config/compaction"
import { ConfigCommand } from "./config/command"
import { ConfigDAP } from "./config/dap"
import { ConfigExperimental } from "./config/experimental"
import { ConfigFormatter } from "./config/formatter"
import { ConfigLSP } from "./config/lsp"
import { ConfigLogging } from "./config/logging"
import { ConfigMaintenance } from "./config/maintenance"
import { ConfigMCP } from "./config/mcp"
import { ConfigModelChain } from "./config/model-chain"
import { ConfigMultiAgent } from "./config/multi-agent"
import { ConfigOptimization } from "./config/optimization"
import { ConfigPlugin } from "./config/plugin"
import { ConfigProvider } from "./config/provider"
import { ConfigReference } from "./config/reference"
import { ConfigToolOutput } from "./config/tool-output"
import { ConfigVision } from "./config/vision"
import { ConfigProjectIconGeneration } from "./config/project-icon-generation"
import { ConfigSkillCapabilities } from "./config/skill-capabilities"
import { ConfigSkillScope } from "./config/skill-scope"
import { ConfigSkillInvocation } from "./config/skill-invocation"
import { ConfigSkillGroups } from "./config/skill-groups"
import { ConfigStorageCleanup } from "./config/storage-cleanup"
import { ConfigWatcher } from "./config/watcher"
import { Flag } from "./flag/flag"
import { ConfigV1 } from "./v1/config/config"
import { ConfigMigrateV1 } from "./v1/config/migrate"

export class Info extends Schema.Class<Info>("Config.Info")({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  shell: Schema.String.pipe(Schema.optional).annotate({
    description: "Default shell to use for terminal and shell tool execution",
  }),
  model: Schema.String.pipe(Schema.optional).annotate({
    description: "Default model to use when no session or agent model is selected",
  }),
  model_chains: ConfigModelChain.Info.pipe(Schema.optional).annotate({
    description: "Named model fallback chains available to new sessions",
  }),
  default_model_chain: Schema.String.pipe(Schema.optional).annotate({
    description: "Default model fallback chain for new sessions",
  }),
  default_agent: Schema.String.pipe(Schema.optional).annotate({
    description: "Default primary agent to use when no session agent is selected",
  }),
  autoupdate: Schema.Union([Schema.Boolean, Schema.Literal("notify")])
    .pipe(Schema.optional)
    .annotate({
      description: "Automatically update or notify when a new version is available",
    }),
  share: Schema.Literals(["manual", "auto", "disabled"]).pipe(Schema.optional).annotate({
    description: "Control whether sessions may be shared manually, automatically, or not at all",
  }),
  enterprise: Schema.Struct({
    url: Schema.String.pipe(Schema.optional),
  })
    .pipe(Schema.optional)
    .annotate({
      description: "Enterprise sharing service configuration",
    }),
  username: Schema.String.pipe(Schema.optional).annotate({
    description: "Username displayed in conversations and used for telemetry identity",
  }),
  access_control: ConfigAccessControl.Config.pipe(Schema.optional).annotate({
    description: "Default access-control mode shown in the chat composer",
  }),
  permissions: PermissionSchema.Ruleset.pipe(Schema.optional).annotate({
    description: "Ordered tool permission rules applied to agent tool use",
  }),
  agents: Schema.Record(Schema.String, ConfigAgent.Info).pipe(Schema.optional).annotate({
    description: "Named built-in agent overrides and custom agent definitions",
  }),
  snapshots: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Enable snapshots used for undo and revert behavior",
  }),
  watcher: ConfigWatcher.Info.pipe(Schema.optional).annotate({
    description: "Filesystem watcher configuration",
  }),
  formatter: ConfigFormatter.Info.pipe(Schema.optional).annotate({
    description: "Enable built-in formatters or configure formatter overrides",
  }),
  lsp: ConfigLSP.Info.pipe(Schema.optional).annotate({
    description: "Enable built-in language servers or configure server overrides",
  }),
  attachments: ConfigAttachments.Info.pipe(Schema.optional).annotate({
    description: "Attachment processing configuration",
  }),
  vision: ConfigVision.Info.pipe(Schema.optional).annotate({
    description:
      "Automatic vision model delegation for image attachments on models without image support",
  }),
  project_icon_generation: ConfigProjectIconGeneration.Info.pipe(Schema.optional).annotate({
    description: "Automatic generated project icon behavior",
  }),
  tool_output: ConfigToolOutput.Info.pipe(Schema.optional).annotate({
    description: "Tool output thresholds; set unlimited to disable local truncation",
  }),
  mcp: ConfigMCP.Info.pipe(Schema.optional).annotate({
    description: "MCP server configuration",
  }),
  compaction: ConfigCompaction.Info.pipe(Schema.optional).annotate({
    description: "Conversation compaction behavior; set unlimited to remove local size ceilings",
  }),
  storage_cleanup: ConfigStorageCleanup.Info.pipe(Schema.optional).annotate({
    description: "Automatic cleanup of expired snapshots and completed compaction backups",
  }),
  dap: ConfigDAP.Info.pipe(Schema.optional).annotate({
    description: "Debug Adapter Protocol commands keyed by adapter ID",
  }),
  capabilities: ConfigCapabilities.Info.pipe(Schema.optional).annotate({
    description: "Reversible product capability controls; all new roadmap capabilities default to disabled",
  }),
  skill_capabilities: ConfigSkillCapabilities.Info.pipe(Schema.optional).annotate({
    description: "Host-owned capability grants keyed by exact skill name",
  }),
  skill_scopes: ConfigSkillScope.Info.pipe(Schema.optional).annotate({
    description: "Availability keyed by original skill directory",
  }),
  skill_groups: ConfigSkillGroups.Info.pipe(Schema.optional).annotate({
    description: "Optional description-only skill hierarchy; disabled by default",
  }),
  skill_invocation: ConfigSkillInvocation.Info.pipe(Schema.optional).annotate({
    description: "Exact canonical skill names requiring manual invocation; unlisted skills keep their modes and project overrides are ignored",
  }),
  optimization: ConfigOptimization.Info.pipe(Schema.optional).annotate({
    description: "Measured performance and token optimization controls",
  }),
  logging: ConfigLogging.Info.pipe(Schema.optional).annotate({
    description: "Structured logging, performance tracing, and UI observability controls",
  }),
  maintenance: ConfigMaintenance.Info.pipe(Schema.optional).annotate({
    description: "Settlement watchdog and bounded growth maintenance controls",
  }),
  multi_agent: ConfigMultiAgent.Info.pipe(Schema.optional).annotate({
    description: "Multi-agent skill reviewer configuration; set unlimited to remove local workflow caps",
  }),
  skills: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional paths or URLs to discover skills from",
  }),
  commands: Schema.Record(Schema.String, ConfigCommand.Info).pipe(Schema.optional).annotate({
    description: "Named slash command definitions",
  }),
  instructions: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional paths or URLs supplying ambient instructions",
  }),
  references: ConfigReference.Info.pipe(Schema.optional).annotate({
    description: "Named local directories or Git repositories available as external context",
  }),
  plugins: ConfigPlugin.Plugins.pipe(Schema.optional).annotate({
    description: "Ordered external plugin packages to load",
  }),
  experimental: ConfigExperimental.Experimental.pipe(Schema.optional),
  providers: Schema.Record(Schema.String, ConfigProvider.Info).pipe(Schema.optional),
}) {}

export class Document extends Schema.Class<Document>("Config.Document")({
  type: Schema.Literal("document"),
  path: Schema.String.pipe(Schema.optional),
  info: Info,
}) {}

export class Directory extends Schema.Class<Directory>("Config.Directory")({
  type: Schema.Literal("directory"),
  path: AbsolutePath,
}) {}

export type Entry = Document | Directory

export function latest<K extends keyof Info>(entries: readonly Entry[], key: K): Info[K] | undefined {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .findLast((entry) => entry.info[key] !== undefined)?.info[key]
}

export function globalLatest<K extends keyof Info>(entries: readonly Entry[], key: K): Info[K] | undefined {
  const boundary = entries.findIndex((entry) => entry.type === "directory")
  return latest(boundary === -1 ? entries : entries.slice(0, boundary), key)
}

export interface Interface {
  /** Returns location config documents and supplemental directories from lowest to highest priority. */
  readonly entries: (input?: { readonly refresh?: boolean }) => Effect.Effect<Entry[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Config") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const policy = yield* Policy.Service
    const names = ["config.json", "opencode.json", "opencode.jsonc"]
    const decodeOptions = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
    const decodeInfo = Schema.decodeUnknownOption(Info, decodeOptions)
    const decodeV1Info = Schema.decodeUnknownOption(ConfigV1.Info, decodeOptions)

    const loadText = Effect.fnUntraced(function* (filepath: string, text: string) {
      const errors: ParseError[] = []
      const input: unknown = parse(text, errors, { allowTrailingComma: true })
      if (errors.length) return

      const info = Option.getOrUndefined(
        ConfigMigrateV1.isV1(input)
          ? decodeV1Info(input).pipe(
              Option.map((info) => mergeHybridConfig(input, ConfigMigrateV1.migrate(info))),
              Option.flatMap(decodeInfo),
            )
          : decodeInfo(input),
      )
      if (!info) return
      return new Document({ type: "document", path: filepath, info })
    })

    const loadFile = Effect.fnUntraced(function* (filepath: string) {
      const text = yield* fs.readFileStringSafe(filepath)
      if (!text) return
      return yield* loadText(filepath, text)
    })

    const loadDirectory = Effect.fnUntraced(function* (directory: AbsolutePath) {
      return [
        ...(yield* Effect.forEach(names, (file) => loadFile(path.join(directory, file))).pipe(
          Effect.map((configs) => configs.filter((config): config is Document => config !== undefined)),
        )),
        new Directory({ type: "directory", path: directory }),
      ]
    })

    const globalDirectory = AbsolutePath.make(global.config)
    const locationIsGlobal = path.resolve(location.directory) === path.resolve(global.config)
    const testRoot = process.env.OPENCODE_TEST_CONFIG_ROOT
    // Resolve config locations when this location opens. Refresh rereads these
    // same sources so saved settings can affect the next task without reopening.
    const discovered = locationIsGlobal || Flag.OPENCODE_DISABLE_PROJECT_CONFIG
      ? []
      : yield* fs
          .up({
            targets: [".opencode", ...names.toReversed()],
            start: location.directory,
            // Match the sidecar's opt-in fixture boundary for non-git locations.
            stop:
              testRoot &&
              FSUtil.contains(testRoot, location.directory) &&
              !FSUtil.contains(testRoot, location.project.directory)
                ? testRoot
                : location.project.directory,
          })
          .pipe(Effect.orDie)
    const directories = [
      globalDirectory,
      ...discovered
        .filter((item) => path.basename(item) === ".opencode")
        .toReversed()
        .map((directory) => AbsolutePath.make(directory)),
    ]
    // A config closer to the opened directory should win over one higher up.
    // Search starts nearby, so reverse the results before applying them.
    const directPaths = discovered.filter((item) => path.basename(item) !== ".opencode").toReversed()
    const loadEntries = Effect.fnUntraced(function* () {
      const direct = yield* Effect.forEach(directPaths, loadFile).pipe(
        Effect.orDie,
        Effect.map((configs) => configs.filter((config): config is Document => config !== undefined)),
      )
      const supplementary = yield* Effect.forEach(directories, loadDirectory).pipe(Effect.orDie)
      const envConfig = process.env.OPENCODE_CONFIG_CONTENT
        ? yield* loadText("OPENCODE_CONFIG_CONTENT", process.env.OPENCODE_CONFIG_CONTENT)
        : undefined
      // Apply general settings first and more specific settings last:
      // global config, project files, then `.opencode` files.
      return [
        ...(supplementary[0] ?? []),
        ...direct,
        ...supplementary.slice(1).flat(),
        ...(envConfig ? [envConfig] : []),
      ]
    })
    const configs = yield* loadEntries()
    // Rules use the opposite order so a user-global rule can override a
    // repository rule. Statement order inside each file stays unchanged.
    yield* policy.load(
      configs
        .filter((config): config is Document => config.type === "document")
        .toReversed()
        .flatMap((config) => config.info.experimental?.policies ?? []),
    )

    // Publish the maintenance block for process-global consumers (the
    // settlement watchdog loop) that cannot depend on a per-location service.
    ConfigMaintenance.publishRuntime(
      configs.filter((config): config is Document => config.type === "document")
        .findLast((config) => config.info.maintenance !== undefined)?.info.maintenance,
    )

    return Service.of({
      entries: Effect.fn("Config.entries")(function* (input?: { readonly refresh?: boolean }) {
        if (input?.refresh) return yield* loadEntries()
        return configs
      }),
    })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(Policy.locationLayer))

function mergeHybridConfig(input: unknown, migrated: ReturnType<typeof ConfigMigrateV1.migrate>) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return migrated
  return {
    ...input,
    ...Object.fromEntries(Object.entries(migrated).filter((entry) => entry[1] !== undefined)),
  }
}
