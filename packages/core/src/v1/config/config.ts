export * as ConfigV1 from "./config"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt, type DeepMutable } from "../../schema"
import { ConfigExperimental } from "../../config/experimental"
import { ConfigReference } from "../../config/reference"
import { ConfigAccessControl } from "../../config/access-control"
import { ConfigCommit } from "../../config/commit"
import { ConfigCapabilities } from "../../config/capabilities"
import { ConfigSkillCapabilities } from "../../config/skill-capabilities"
import { ConfigSkillScope } from "../../config/skill-scope"
import { ConfigSkillInvocation } from "../../config/skill-invocation"
import { ConfigSkillGroups } from "../../config/skill-groups"
import { ConfigOptimization } from "../../config/optimization"
import { ConfigMaintenance } from "../../config/maintenance"
import { ConfigVision } from "../../config/vision"
import { ConfigProjectIconGeneration } from "../../config/project-icon-generation"
import { ConfigStorageCleanup } from "../../config/storage-cleanup"
import { ConfigAgentV1 } from "./agent"
import { ConfigAttachmentV1 } from "./attachment"
import { ConfigCommandV1 } from "./command"
import { ConfigFormatterV1 } from "./formatter"
import { ConfigLayoutV1 } from "./layout"
import { ConfigLSPV1 } from "./lsp"
import { ConfigLogging } from "../../config/logging"
import { ConfigMCPV1 } from "./mcp"
import { ConfigMultiAgent } from "../../config/multi-agent"
import { ConfigModelChain } from "../../config/model-chain"
import { ConfigPermissionV1 } from "./permission"
import { ConfigPluginV1 } from "./plugin"
import { ConfigProviderV1 } from "./provider"
import { ConfigServerV1 } from "./server"
import { ConfigSkillsV1 } from "./skills"

export type Layout = ConfigLayoutV1.Layout

export const WellKnown = Schema.Struct({
  config: Schema.optional(Schema.Json),
  remote_config: Schema.optional(Schema.Json),
})

const LogLevelRef = Schema.Literals(["TRACE", "DEBUG", "INFO", "WARN", "ERROR"]).annotate({
  identifier: "LogLevel",
  description: "Log level",
})

export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  shell: Schema.optional(Schema.String).annotate({ description: "Default shell to use for terminal and bash tool" }),
  model_chains: Schema.optional(ConfigModelChain.Info).annotate({
    description: "Named model fallback chains available to new sessions",
  }),
  default_model_chain: Schema.optional(Schema.String).annotate({
    description: "Default model fallback chain for new sessions",
  }),
  logLevel: Schema.optional(LogLevelRef).annotate({ description: "Log level" }),
  server: Schema.optional(ConfigServerV1.Server).annotate({
    description: "Server configuration for opencode serve and web commands",
  }),
  command: Schema.optional(Schema.Record(Schema.String, ConfigCommandV1.Info)).annotate({
    description: "Command configuration, see https://opencode.ai/docs/commands",
  }),
  skills: Schema.optional(ConfigSkillsV1.Info).annotate({ description: "Additional skill folder paths" }),
  references: Schema.optional(ConfigReference.Info).annotate({
    description: "Named git or local directory references",
  }),
  reference: Schema.optional(ConfigReference.Info).annotate({
    description: "@deprecated Use 'references' field instead. Named git or local directory references",
  }),
  watcher: Schema.optional(Schema.Struct({ ignore: Schema.optional(Schema.mutable(Schema.Array(Schema.String))) })),
  snapshot: Schema.optional(Schema.Boolean).annotate({
    description:
      "Enable or disable snapshot tracking. When false, filesystem snapshots are not recorded and undoing or reverting will not undo/redo file changes. Defaults to true.",
  }),
  plugin: Schema.optional(Schema.mutable(Schema.Array(ConfigPluginV1.Spec))),
  share: Schema.optional(Schema.Literals(["manual", "auto", "disabled"])).annotate({
    description:
      "Control sharing behavior:'manual' allows manual sharing via commands, 'auto' enables automatic sharing, 'disabled' disables all sharing",
  }),
  autoshare: Schema.optional(Schema.Boolean).annotate({
    description: "@deprecated Use 'share' field instead. Share newly created sessions automatically",
  }),
  autoupdate: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("notify")])).annotate({
    description:
      "Automatically update to the latest version. Set to true to auto-update, false to disable, or 'notify' to show update notifications",
  }),
  disabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Disable providers that are loaded automatically",
  }),
  enabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "When set, ONLY these providers will be enabled. All other providers will be ignored",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Model to use in the format of provider/model, eg anthropic/claude-2",
  }),
  small_model: Schema.optional(Schema.String).annotate({
    description: "Small model to use for tasks like title generation in the format of provider/model",
  }),
  default_agent: Schema.optional(Schema.String).annotate({
    description:
      "Default agent to use when none is specified. Must be a primary agent. Falls back to 'build' if not set or if the specified agent is invalid.",
  }),
  username: Schema.optional(Schema.String).annotate({
    description: "Custom username to display in conversations instead of system username",
  }),
  access_control: Schema.optional(ConfigAccessControl.Config).annotate({
    description: "Default access-control mode shown in the chat composer",
  }),
  commit: Schema.optional(ConfigCommit.Commit).annotate({
    description: "AI commit message generation configuration for the Git Workbench auto-commit action",
  }),
  optimization: Schema.optional(ConfigOptimization.Info).annotate({
    description: "Measured performance and token optimization controls",
  }),
  capabilities: Schema.optional(ConfigCapabilities.Info).annotate({
    description: "Opt-in capability gates for experimental core services",
  }),
  skill_capabilities: Schema.optional(ConfigSkillCapabilities.Info).annotate({
    description: "Host-owned capability grants keyed by exact skill name",
  }),
  skill_scopes: Schema.optional(ConfigSkillScope.Info).annotate({
    description: "Availability keyed by original skill directory",
  }),
  skill_groups: ConfigSkillGroups.Info.pipe(Schema.optional).annotate({
    description: "Optional description-only skill hierarchy; disabled by default",
  }),
  skill_invocation: Schema.optional(ConfigSkillInvocation.Info).annotate({
    description: "Exact canonical skill names requiring manual invocation; unlisted skills keep their modes and project overrides are ignored",
  }),
  logging: Schema.optional(ConfigLogging.Info).annotate({
    description: "Structured logging, performance tracing, and UI observability controls",
  }),
  maintenance: Schema.optional(ConfigMaintenance.Info).annotate({
    description: "Settlement watchdog and bounded growth maintenance controls",
  }),
  vision: Schema.optional(ConfigVision.Info).annotate({
    description: "Automatic vision model delegation for image attachments on models without image support",
  }),
  project_icon_generation: Schema.optional(ConfigProjectIconGeneration.Info).annotate({
    description: "Automatic generated project icon behavior",
  }),
  multi_agent: Schema.optional(ConfigMultiAgent.Info).annotate({
    description: "Multi-agent skill reviewer configuration",
  }),
  mode: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({ build: Schema.optional(ConfigAgentV1.Info), plan: Schema.optional(ConfigAgentV1.Info) }),
      [Schema.Record(Schema.String, ConfigAgentV1.Info)],
    ),
  ).annotate({ description: "@deprecated Use `agent` field instead." }),
  agent: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        plan: Schema.optional(ConfigAgentV1.Info),
        build: Schema.optional(ConfigAgentV1.Info),
        general: Schema.optional(ConfigAgentV1.Info),
        explore: Schema.optional(ConfigAgentV1.Info),
        title: Schema.optional(ConfigAgentV1.Info),
        summary: Schema.optional(ConfigAgentV1.Info),
        compaction: Schema.optional(ConfigAgentV1.Info),
      }),
      [Schema.Record(Schema.String, ConfigAgentV1.Info)],
    ),
  ).annotate({ description: "Agent configuration, see https://opencode.ai/docs/agents" }),
  provider: Schema.optional(Schema.Record(Schema.String, ConfigProviderV1.Info)).annotate({
    description: "Custom provider configurations and model overrides",
  }),
  mcp: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([ConfigMCPV1.Info, Schema.Struct({ enabled: Schema.Boolean })])),
  ).annotate({ description: "MCP (Model Context Protocol) server configurations" }),
  formatter: Schema.optional(ConfigFormatterV1.Info).annotate({
    description:
      "Enable or configure formatters. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.",
  }),
  lsp: Schema.optional(ConfigLSPV1.Info).annotate({
    description:
      "Enable or configure LSP servers. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.",
  }),
  instructions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Additional instruction files or patterns to include",
  }),
  layout: Schema.optional(ConfigLayoutV1.Layout).annotate({ description: "@deprecated Always uses stretch layout." }),
  permission: Schema.optional(ConfigPermissionV1.Info),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  attachment: Schema.optional(ConfigAttachmentV1.Info).annotate({
    description: "Attachment processing configuration, including image size limits and resizing behavior",
  }),
  enterprise: Schema.optional(
    Schema.Struct({ url: Schema.optional(Schema.String).annotate({ description: "Enterprise URL" }) }),
  ),
  tool_output: Schema.optional(
    Schema.Struct({
      unlimited: Schema.optional(Schema.Boolean).annotate({
        description: "Keep complete tool output instead of applying local truncation thresholds",
      }),
      max_lines: Schema.optional(PositiveInt).annotate({
        description: "Maximum lines of tool output before it is truncated and saved to disk (default: 2000)",
      }),
      max_bytes: Schema.optional(PositiveInt).annotate({
        description: "Maximum bytes of tool output before it is truncated and saved to disk (default: 51200)",
      }),
    }),
  ).annotate({
    description:
      "Thresholds for truncating tool output. Set unlimited to keep complete local output; provider context limits still apply.",
  }),
  compaction: Schema.optional(
    Schema.Struct({
      unlimited: Schema.optional(Schema.Boolean).annotate({
        description: "Disable local compaction size ceilings; provider context limits still apply",
      }),
      auto: Schema.optional(Schema.Boolean).annotate({
        description: "Enable automatic compaction when context is full (default: true)",
      }),
      prune: Schema.optional(Schema.Boolean).annotate({
        description: "Enable pruning of old tool outputs (default: false)",
      }),
      tail_turns: Schema.optional(NonNegativeInt).annotate({
        description:
          "Number of recent user turns, including their following assistant/tool responses, to keep verbatim during compaction (default: 2)",
      }),
      preserve_recent_tokens: Schema.optional(NonNegativeInt).annotate({
        description: "Maximum number of tokens from recent turns to preserve verbatim after compaction",
      }),
      reserved: Schema.optional(NonNegativeInt).annotate({
        description: "Token buffer for compaction. Leaves enough window to avoid overflow during compaction.",
      }),
    }),
  ),
  storage_cleanup: Schema.optional(ConfigStorageCleanup.Info).annotate({
    description: "Automatic cleanup of expired snapshots and completed compaction backups",
  }),
  session: Schema.optional(
    Schema.Struct({
      turn_completion: Schema.optional(
        Schema.Struct({
          enabled: Schema.optional(Schema.Boolean).annotate({
            description: "Enable LLM-based turn completion evaluation after agent turns (default: false)",
          }),
          prompt: Schema.optional(Schema.String).annotate({
            description: "Custom prompt for the LLM turn completion check. {todos} and {lastMessage} are substituted.",
          }),
          target: Schema.optional(Schema.String).annotate({
            description:
              "Completion target reference: 'model:<provider>/<model>' or 'chain:<id>'. Takes precedence over model/variant.",
          }),
          model: Schema.optional(Schema.String).annotate({
            description:
              "Deprecated model ID for the completion check (e.g. 'anthropic/claude-3-5-haiku'). Prefer target; still read when target is unset. Leave empty for small_model hook.",
          }),
          variant: Schema.optional(Schema.String).annotate({
            description: "Optional model variant for the completion check (e.g. 'high').",
          }),
        }),
      ),
      retention: Schema.optional(
        Schema.Struct({
          enabled: Schema.optional(Schema.Boolean).annotate({
            description: "Permanently delete inactive OpenCode sessions automatically (default: false)",
          }),
          inactivity_days: Schema.optional(PositiveInt).annotate({
            description: "Days since the last session activity before permanent deletion (default: 21)",
          }),
        }),
      ),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      session_orchestrator: Schema.optional(Schema.Boolean).annotate({
        description: "Allow session orchestrator admission when supported by the host; disabled by default",
      }),
      disable_paste_summary: Schema.optional(Schema.Boolean),
      batch_tool: Schema.optional(Schema.Boolean).annotate({ description: "Enable the batch tool" }),
      openTelemetry: Schema.optional(Schema.Boolean).annotate({
        description: "Enable OpenTelemetry spans for AI SDK calls (using the 'experimental_telemetry' flag)",
      }),
      primary_tools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
        description: "Tools that should only be available to primary agents.",
      }),
      continue_loop_on_deny: Schema.optional(Schema.Boolean).annotate({
        description: "Continue the agent loop when a tool call is denied",
      }),
      mcp_timeout: Schema.optional(PositiveInt).annotate({
        description: "Timeout in milliseconds for model context protocol (MCP) requests",
      }),
      policies: Schema.optional(Schema.mutable(Schema.Array(ConfigExperimental.Policy))).annotate({
        description: "Policy statements applied to supported resources, such as provider access",
      }),
    }),
  ),
}).annotate({ identifier: "Config" })

export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

/**
 * Update payload for global config writes. Identical to the stored config except
 * that `default_model_chain` also accepts `null` as an explicit clear: a JSON
 * body cannot express "remove this key" with `undefined`, so clients unset the
 * default by sending null and the server deletes the stored key.
 */
export const UpdateInfo = Schema.Struct({
  ...Info.fields,
  default_model_chain: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description: "Default model fallback chain for new sessions; null clears the stored default",
  }),
}).annotate({ identifier: "ConfigUpdate" })

export type UpdateInfo = DeepMutable<Schema.Schema.Type<typeof UpdateInfo>>
