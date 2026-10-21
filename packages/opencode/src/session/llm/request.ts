import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ConfigOptimization } from "@opencode-ai/core/config/optimization"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { Auth } from "@/auth"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "../message-v2"
import type { Provider } from "@/provider/provider"
import { ProviderTransform, type RawProviderOptions } from "@/provider/transform"
import { SystemPrompt } from "../system"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { AgentSwitchTool } from "@opencode-ai/core/tool/agent-switch"
import { Effect, Record } from "effect"
import { jsonSchema, tool as aiTool, type ModelMessage, type Tool } from "ai"
import type { Plugin } from "@/plugin"
import { mergeDeep } from "remeda"
import { Token } from "@/util/token"

const USER_AGENT = `opencode/${InstallationVersion}`
const TOOL_CATALOG_SEARCH = "tool_catalog_search"
const TOOL_CATALOG_RUN = "tool_catalog_run"
const PATCH_VERIFY_TOOL = "apply_patch_and_verify"
const BATCH_READ_TOOL = "batch_read"
const BATCH_GLOB_TOOL = "batch_glob"
const BATCH_GREP_TOOL = "batch_grep"
const SURFACE_TOOL = "surface"
const REQUEST_OPTIMIZATION_FEATURES = [
  "deferred_tool_discovery",
  "compact_tool_schemas",
  "patch_verify_tool",
  "batch_core_tools",
] as const
const SYNTHETIC_TOOL_IDS = [TOOL_CATALOG_SEARCH, TOOL_CATALOG_RUN, PATCH_VERIFY_TOOL, BATCH_READ_TOOL, BATCH_GLOB_TOOL, BATCH_GREP_TOOL]
const DIRECT_TOOL_IDS = new Set([
  "invalid",
  "bash",
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "apply_patch",
  PATCH_VERIFY_TOOL,
  BATCH_READ_TOOL,
  BATCH_GLOB_TOOL,
  BATCH_GREP_TOOL,
  SURFACE_TOOL,
  "attach",
  "task",
  "spawn_agent",
])
const MAX_BATCH_TOOL_REQUESTS = 20
const COMPACT_TOOL_DESCRIPTIONS: Record<string, string> = {
  bash: "Run terminal commands for builds, tests, git, package managers, and other shell operations. Use file tools for reading, searching, and editing files.",
  read: "Read a file or directory. Use absolute filePath, and offset/limit for ranges.",
  glob: "Find files by glob pattern. Omit path to search the current workspace.",
  grep: "Search file contents with a regex. Use include to restrict file globs.",
  edit: "Replace exact text in an existing file. Read first; oldString must be unique unless replaceAll is true.",
  write: "Write content to an absolute file path. Prefer edit for existing files.",
  apply_patch: "Edit files with the apply_patch envelope using Add, Update, Delete, or Move sections.",
  [PATCH_VERIFY_TOOL]: "Apply a patch, then run a verifier command after the patch is applied. Use when the next step is to verify the edit.",
  [BATCH_READ_TOOL]: "Read multiple files or directories in one tool call. Prefer for related reads you already know you need.",
  [BATCH_GLOB_TOOL]: "Run multiple glob file searches in one tool call. Prefer for related path discovery across patterns or folders.",
  [BATCH_GREP_TOOL]: "Run multiple regex content searches in one tool call. Prefer for related content searches across patterns or folders.",
  attach: "Attach an image, video, or file to your chat reply so the user can view it inline.",
}
const COMPACT_PARAMETER_DESCRIPTIONS: Record<string, Record<string, string>> = {
  bash: {
    command: "Command to execute.",
    timeout: "Optional timeout in milliseconds.",
    workdir: "Working directory. Prefer this over cd.",
    description: "5-10 word command summary.",
  },
  read: {
    filePath: "Absolute file or directory path.",
    offset: "1-indexed start line.",
    limit: "Maximum lines to return.",
  },
  glob: { pattern: "Glob pattern to match.", path: "Directory to search; omit for current workspace." },
  grep: { pattern: "Regex pattern to search.", path: "Directory to search.", include: "File glob filter." },
  edit: {
    filePath: "Absolute file path.",
    oldString: "Exact text to replace.",
    newString: "Replacement text.",
    replaceAll: "Replace every match.",
  },
  write: { filePath: "Absolute file path.", content: "File content." },
  apply_patch: { patchText: "Full apply_patch patch text." },
  [PATCH_VERIFY_TOOL]: {
    patchText: "Full apply_patch patch text.",
    command: "Verifier command to run after patching.",
    timeout: "Optional timeout in milliseconds.",
    workdir: "Verifier working directory.",
    description: "5-10 word verifier summary.",
  },
  [BATCH_READ_TOOL]: { requests: "Read requests to run, max 20.", filePath: "Absolute file or directory path.", offset: "1-indexed start line.", limit: "Maximum lines to return." },
  [BATCH_GLOB_TOOL]: { requests: "Glob requests to run, max 20.", pattern: "Glob pattern to match.", path: "Directory to search; omit for current workspace." },
  [BATCH_GREP_TOOL]: { requests: "Grep requests to run, max 20.", pattern: "Regex pattern to search.", path: "Directory to search.", include: "File glob filter." },
}

type PrepareInput = {
  readonly user: SessionV1.User
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly model: Provider.Model
  readonly agent: Agent.Info
  readonly permission?: PermissionV1.Ruleset
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly small?: boolean
  readonly tools: Record<string, Tool>
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly plugin: Plugin.Interface
  readonly flags: RuntimeFlags.Info
  readonly isWorkflow: boolean
  readonly optimization: ConfigOptimization.Resolved
}

type OptimizationDiagnostics = {
  readonly skipped: string[]
}

export type Prepared = {
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly params: {
    readonly temperature?: number
    readonly topP?: number
    readonly topK?: number
    readonly maxOutputTokens?: number
    readonly options: RawProviderOptions
  }
  readonly messageTransformOptions: RawProviderOptions
  readonly headers: Record<string, string>
}

export function summarizeRequestFootprint(input: {
  readonly system: readonly string[]
  readonly messages: readonly ModelMessage[]
  readonly tools: Record<string, Tool>
}) {
  const activeToolNames = Object.keys(input.tools).filter((name) => name !== "invalid")
  const toolFootprint = Object.fromEntries(
    activeToolNames.flatMap((name) => {
      const tool = input.tools[name]
      return tool ? [[name, { description: tool.description, inputSchema: tool.inputSchema }] as const] : []
    }),
  )
  const systemText = input.system.join("\n")
  return {
    activeToolNames,
    messageCount: input.messages.length,
    systemPromptChars: systemText.length,
    systemPromptEstimateTokens: Token.estimate(systemText),
    toolSchemaBytes: Buffer.byteLength(JSON.stringify(toolFootprint), "utf8"),
    contextEstimateTokens: Token.estimateFootprint({
      system: input.system,
      messages: input.messages,
      tools: toolFootprint,
    }),
  }
}

const mergeOptions = (target: RawProviderOptions, source: RawProviderOptions | undefined): RawProviderOptions =>
  mergeDeep(target, source ?? {}) as RawProviderOptions

export const prepare = Effect.fn("LLMRequestPrep.prepare")(function* (input: PrepareInput) {
  const isOpenaiOauth = input.provider.id === "openai" && input.auth?.type === "oauth"
  const inheritedSystem = SystemPrompt.provider(input.model)
  const agentSystem =
    input.agent.systemMode === "replace"
      ? input.agent.prompt
        ? [input.agent.prompt]
        : []
      : input.agent.systemMode === "append"
        ? [...inheritedSystem, ...(input.agent.prompt ? [input.agent.prompt] : [])]
        : input.agent.systemMode === "inherit"
          ? inheritedSystem
          : input.agent.prompt
            ? [input.agent.prompt]
            : inheritedSystem
  const system = [
    [
      ...agentSystem,
      ...(input.agent.instructionPrompt ? [input.agent.instructionPrompt] : []),
      ...input.system,
      ...(input.user.system ? [input.user.system] : []),
    ]
      .filter((x) => x)
      .join("\n"),
  ]

  const header = system[0]
  yield* input.plugin.trigger(
    "experimental.chat.system.transform",
    { sessionID: input.sessionID, model: input.model },
    { system },
  )
  if (system.length > 2 && system[0] === header) {
    const rest = system.slice(1)
    system.length = 0
    system.push(header, rest.join("\n"))
  }

  const variant =
    !input.small && input.model.variants && input.user.model.variant
      ? input.model.variants[input.user.model.variant]
      : {}
  const base = input.small
    ? ProviderTransform.smallOptions(input.model)
    : ProviderTransform.options({
        model: input.model,
        sessionID: input.sessionID,
        providerOptions: input.provider.options,
      })
  const options = mergeOptions(mergeOptions(mergeOptions(base, input.model.options), input.agent.options), variant)
  if (input.parentSessionID && input.model.providerID === "cursor") options.ephemeral = true
  if (
    input.model.api.npm === "@ai-sdk/azure" &&
    (input.provider.options.useCompletionUrls || input.model.options.useCompletionUrls || options.useCompletionUrls)
  ) {
    delete options.reasoning
    delete options.reasoningMode
    delete options.reasoningSummary
    delete options.include
  }
  if (isOpenaiOauth) options.instructions = system.join("\n")

  const messages =
    isOpenaiOauth || input.isWorkflow
      ? input.messages
      : [
          ...system.map(
            (x): ModelMessage => ({
              role: "system",
              content: x,
            }),
          ),
          ...input.messages,
        ]

  const params = yield* input.plugin.trigger(
    "chat.params",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      temperature: input.model.capabilities.temperature
        ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
        : undefined,
      topP: input.agent.topP ?? ProviderTransform.topP(input.model),
      topK: ProviderTransform.topK(input.model),
      maxOutputTokens: ProviderTransform.chatMaxOutputTokens(input.model, input.flags.outputTokenMax),
      options,
    },
  )

  const { headers } = yield* input.plugin.trigger(
    "chat.headers",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      headers: {},
    },
  )

  const tools = resolveTools(input)
  if (
    input.model.api.npm === "@ai-sdk/openai" ||
    input.model.api.npm === "@ai-sdk/azure" ||
    input.model.api.npm === "@ai-sdk/amazon-bedrock/mantle"
  ) {
    Object.values(tools).forEach((item) => {
      item.strict = false
    })
  }
  if (
    input.model.providerID.includes("github-copilot") &&
    Object.keys(tools).length === 0 &&
    hasToolCalls(input.messages)
  ) {
    // Copilot needs a tools field when replaying prior tool calls, even if no tools are currently enabled.
    tools["_noop"] = aiTool({
      description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          reason: { type: "string", description: "Unused" },
        },
      }),
      execute: async () => ({ output: "", title: "", metadata: {} }),
    })
  }

  const opencodeProjectID = input.model.providerID.startsWith("opencode")
    ? (yield* InstanceState.context).project.id
    : undefined

  return {
    system,
    messages,
    tools: Object.fromEntries(Object.entries(tools).toSorted(([a], [b]) => a.localeCompare(b))),
    params,
    messageTransformOptions: options,
    headers: {
      ...(input.model.providerID.startsWith("opencode")
        ? {
            ...(opencodeProjectID ? { "x-opencode-project": opencodeProjectID } : {}),
            "x-opencode-session": input.sessionID,
            "x-opencode-request": input.user.id,
            "x-opencode-client": input.flags.client,
            "User-Agent": USER_AGENT,
          }
        : {
            "x-session-affinity": input.sessionID,
            "X-Session-Id": input.sessionID,
            ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
            "User-Agent": USER_AGENT,
          }),
      ...input.model.headers,
      ...headers,
    },
  }
})

export function resolveTools(
  input: Pick<PrepareInput, "tools" | "agent" | "permission" | "user" | "optimization"> &
    Partial<Pick<PrepareInput, "sessionID">>,
) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  const features = input.optimization.features
  const tools = Record.filter(input.tools, (_, k) => {
    if (input.agent.tools?.mode === "explicit") {
      const entry = input.agent.tools.entries[k]
      if (!entry || entry.visible === false || entry.permission === "deny") return false
    }
    return input.user.tools?.[k] !== false && !disabled.has(k)
  })
  const diagnostics: OptimizationDiagnostics = { skipped: [] }
  const batched = features.batch_core_tools ? addBatchCoreTools(tools, diagnostics) : tools
  const patchVerify = features.patch_verify_tool ? addPatchVerifyTool(batched, diagnostics) : batched
  const deferred = features.deferred_tool_discovery ? deferTools(patchVerify, diagnostics) : patchVerify
  const resolved = features.compact_tool_schemas ? compactToolSchemas(deferred) : deferred
  logOptimizationDiagnostics(features, input.tools, tools, resolved, disabled, diagnostics)
  return resolved
}

function addBatchCoreTools(tools: Record<string, Tool>, diagnostics: OptimizationDiagnostics): Record<string, Tool> {
  const additions: Record<string, Tool> = {}

  if (tools[BATCH_READ_TOOL]) {
    diagnostics.skipped.push("batch_core_tools:batch_read_name_conflict")
  } else if (!tools.read?.execute) {
    diagnostics.skipped.push("batch_core_tools:read_unavailable")
  } else {
    const readExecute = tools.read.execute
    additions[BATCH_READ_TOOL] = aiTool({
      description:
        "Read multiple files or directories in one tool call. Use when you already know several paths must be read; keep each request focused.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          requests: {
            type: "array",
            description: `Read requests to run in order. Maximum ${MAX_BATCH_TOOL_REQUESTS}.`,
            items: {
              type: "object",
              properties: {
                filePath: { type: "string", description: "Absolute file or directory path." },
                offset: { type: "number", description: "1-indexed start line." },
                limit: { type: "number", description: "Maximum lines to return." },
              },
              required: ["filePath"],
            },
          },
        },
        required: ["requests"],
      }),
      execute: async (input, options) =>
        runBatch(input, (request) => readExecute(request, options), (request) => stringValue(request.filePath)),
    })
  }

  if (tools[BATCH_GLOB_TOOL]) {
    diagnostics.skipped.push("batch_core_tools:batch_glob_name_conflict")
  } else if (!tools.glob?.execute) {
    diagnostics.skipped.push("batch_core_tools:glob_unavailable")
  } else {
    const globExecute = tools.glob.execute
    additions[BATCH_GLOB_TOOL] = aiTool({
      description:
        "Run multiple glob file searches in one tool call. Use when checking several patterns or directories at once.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          requests: {
            type: "array",
            description: `Glob requests to run in order. Maximum ${MAX_BATCH_TOOL_REQUESTS}.`,
            items: {
              type: "object",
              properties: {
                pattern: { type: "string", description: "Glob pattern to match." },
                path: { type: "string", description: "Directory to search; omit for current workspace." },
              },
              required: ["pattern"],
            },
          },
        },
        required: ["requests"],
      }),
      execute: async (input, options) =>
        runBatch(input, (request) => globExecute(request, options), (request) => stringValue(request.pattern)),
    })
  }

  if (tools[BATCH_GREP_TOOL]) {
    diagnostics.skipped.push("batch_core_tools:batch_grep_name_conflict")
  } else if (!tools.grep?.execute) {
    diagnostics.skipped.push("batch_core_tools:grep_unavailable")
  } else {
    const grepExecute = tools.grep.execute
    additions[BATCH_GREP_TOOL] = aiTool({
      description:
        "Run multiple regex content searches in one tool call. Use when checking several patterns or directories at once.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          requests: {
            type: "array",
            description: `Grep requests to run in order. Maximum ${MAX_BATCH_TOOL_REQUESTS}.`,
            items: {
              type: "object",
              properties: {
                pattern: { type: "string", description: "Regex pattern to search." },
                path: { type: "string", description: "Directory to search." },
                include: { type: "string", description: "File glob filter." },
              },
              required: ["pattern"],
            },
          },
        },
        required: ["requests"],
      }),
      execute: async (input, options) =>
        runBatch(input, (request) => grepExecute(request, options), (request) => stringValue(request.pattern)),
    })
  }

  return Object.keys(additions).length ? { ...tools, ...additions } : tools
}

function addPatchVerifyTool(tools: Record<string, Tool>, diagnostics: OptimizationDiagnostics): Record<string, Tool> {
  if (tools[PATCH_VERIFY_TOOL]) {
    diagnostics.skipped.push("patch_verify_tool:name_conflict")
    return tools
  }
  const applyPatch = tools.apply_patch
  const bash = tools.bash
  if (!applyPatch?.execute || !bash?.execute) {
    diagnostics.skipped.push("patch_verify_tool:base_tools_unavailable")
    return tools
  }
  const applyPatchExecute = applyPatch.execute
  const bashExecute = bash.execute

  return {
    ...tools,
    [PATCH_VERIFY_TOOL]: aiTool({
      description:
        "Apply one apply_patch patch, then run a verifier command after the patch is applied. Use instead of separate apply_patch and bash calls when verification is the immediate next step.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          patchText: { type: "string", description: "Full apply_patch patch text." },
          command: { type: "string", description: "Verifier command to run after patching." },
          timeout: { type: "number", description: "Optional timeout in milliseconds." },
          workdir: { type: "string", description: "Working directory for the verifier command." },
          description: { type: "string", description: "5-10 word verifier summary." },
        },
        required: ["patchText", "command"],
      }),
      execute: async (input, options) => {
        const params = isRecord(input) ? input : {}
        if (typeof params.patchText !== "string" || params.patchText.trim() === "") {
          throw new Error("patchText is required")
        }
        if (typeof params.command !== "string" || params.command.trim() === "") {
          throw new Error("command is required")
        }

        const patchResult = await applyPatchExecute({ patchText: params.patchText }, options)
        const verifyResult = await bashExecute(
          {
            command: params.command,
            ...(typeof params.timeout === "number" ? { timeout: params.timeout } : {}),
            ...(typeof params.workdir === "string" ? { workdir: params.workdir } : {}),
            description: typeof params.description === "string" ? params.description : "Run verifier after patch",
          },
          options,
        )
        return [`Patch result:\n${toolResultText(patchResult)}`, `Verifier result:\n${toolResultText(verifyResult)}`].join(
          "\n\n",
        )
      },
    }),
  }
}

function deferTools(tools: Record<string, Tool>, diagnostics: OptimizationDiagnostics): Record<string, Tool> {
  if (tools[TOOL_CATALOG_SEARCH] || tools[TOOL_CATALOG_RUN]) {
    diagnostics.skipped.push("deferred_tool_discovery:catalog_name_conflict")
    return tools
  }

  const direct = Object.fromEntries(
    Object.entries(tools).filter(([name]) => DIRECT_TOOL_IDS.has(name) || AgentSwitchTool.isSwitchTool(name)),
  )
  const deferred = Object.fromEntries(
    Object.entries(tools).filter(([name]) => !DIRECT_TOOL_IDS.has(name) && !AgentSwitchTool.isSwitchTool(name)),
  )
  if (Object.keys(deferred).length === 0) {
    diagnostics.skipped.push("deferred_tool_discovery:no_deferred_tools")
    return tools
  }

  return {
    ...direct,
    [TOOL_CATALOG_SEARCH]: aiTool({
      description:
        "Search tools that are available for this request but not advertised directly. Use this before tool_catalog_run when you need a non-core capability.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          query: { type: "string", description: "Search text to match against deferred tool names and descriptions." },
          limit: { type: "number", description: "Maximum matching tools to return. Defaults to 8." },
        },
        required: ["query"],
      }),
      execute: async (input) => {
        const params = isRecord(input) ? input : {}
        const query = typeof params.query === "string" ? params.query.toLowerCase() : ""
        const limit = typeof params.limit === "number" && params.limit > 0 ? Math.floor(params.limit) : 8
        const matches = Object.entries(deferred)
          .filter(([name, item]) => matchesDeferredToolSearch(query, name, item))
          .slice(0, limit)
        if (matches.length === 0) return "No deferred tools matched the query."
        return [
          "Deferred tools matched. Call tool_catalog_run with the selected tool name and JSON input.",
          ...matches.map(([name, item]) =>
            [
              `tool: ${name}`,
              `description: ${item.description ?? ""}`,
              `input_schema: ${JSON.stringify(inputSchemaJson(item.inputSchema))}`,
            ].join("\n"),
          ),
        ].join("\n\n")
      },
    }),
    [TOOL_CATALOG_RUN]: aiTool({
      description:
        "Run one deferred tool discovered with tool_catalog_search. Prefer directly advertised core tools when available.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          tool: { type: "string", description: "Deferred tool name to run." },
          input: { type: "object", description: "JSON input for the selected deferred tool." },
        },
        required: ["tool", "input"],
      }),
      execute: async (input, options) => {
        const params = isRecord(input) ? input : {}
        const name = typeof params.tool === "string" ? params.tool : ""
        const item = deferred[name]
        if (!item?.execute) return `Deferred tool not found or not executable: ${name}`
        return item.execute(params.input, options)
      },
    }),
  }
}

function matchesDeferredToolSearch(query: string, name: string, item: Tool) {
  if (!query) return true
  const target = `${name}\n${item.description ?? ""}`.toLowerCase()
  if (target.includes(query)) return true
  const tokens = query.split(/[^a-z0-9]+/i).filter((token) => token)
  return tokens.length > 0 && tokens.every((token) => target.includes(token))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function logOptimizationDiagnostics(
  features: ConfigOptimization.FeatureSettings,
  originalTools: Record<string, Tool>,
  filteredTools: Record<string, Tool>,
  resolvedTools: Record<string, Tool>,
  permissionDisabled: Set<string>,
  diagnostics: OptimizationDiagnostics,
) {
  if (!features.runner_request_metrics) return
  const active = REQUEST_OPTIMIZATION_FEATURES.flatMap((name) => (features[name] ? [name] : []))
  if (active.length === 0) return
  console.error(
    [
      "optimization diagnostics",
      `active=${active.join(",")}`,
      `tools=${Object.keys(originalTools).length}->${Object.keys(filteredTools).length}->${Object.keys(resolvedTools).length}`,
      `permission_disabled=${permissionDisabled.size}`,
      `synthetic=${SYNTHETIC_TOOL_IDS.filter((name) => resolvedTools[name]).join(",") || "none"}`,
      ...diagnostics.skipped.map((reason) => `skip=${reason}`),
    ].join(" "),
  )
}

async function runBatch(
  input: unknown,
  execute: (request: Record<string, unknown>) => Promise<unknown>,
  label: (request: Record<string, unknown>) => string,
) {
  const params = isRecord(input) ? input : {}
  if (!Array.isArray(params.requests)) throw new Error("requests must be an array")
  if (params.requests.length === 0) throw new Error("requests must not be empty")
  if (params.requests.length > MAX_BATCH_TOOL_REQUESTS) {
    throw new Error(`requests must include at most ${MAX_BATCH_TOOL_REQUESTS} items`)
  }

  const sections: string[] = []
  for (const [index, request] of params.requests.entries()) {
    if (!isRecord(request)) {
      sections.push(batchSection(index, "invalid", "ERROR: request must be an object"))
      continue
    }
    try {
      sections.push(batchSection(index, label(request), toolResultText(await execute(request))))
    } catch (error) {
      sections.push(batchSection(index, label(request), `ERROR: ${errorMessage(error)}`))
    }
  }
  return sections.join("\n\n")
}

function batchSection(index: number, label: string, text: string) {
  return [`## request ${index + 1}: ${label || "unnamed"}`, text].join("\n")
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : ""
}

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : String(value)
}

function inputSchemaJson(value: unknown): JSONSchema7 | undefined {
  if (isRecord(value) && isJsonSchema(value.jsonSchema)) return value.jsonSchema
  if (isJsonSchema(value)) return value
}

function toolResultText(value: unknown) {
  if (typeof value === "string") return value
  if (isRecord(value) && typeof value.output === "string") return value.output
  return JSON.stringify(value)
}

function compactToolSchemas(tools: Record<string, Tool>): Record<string, Tool> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, item]): [string, Tool] => [
      name,
      COMPACT_TOOL_DESCRIPTIONS[name]
        ? {
            ...item,
            description: COMPACT_TOOL_DESCRIPTIONS[name],
            inputSchema: compactInputSchema(name, item.inputSchema),
          }
        : item,
    ]),
  )
}

function compactInputSchema(name: string, value: Tool["inputSchema"]): Tool["inputSchema"] {
  const schema = inputSchemaJson(value)
  if (!schema || typeof schema === "boolean") return value
  return jsonSchema(compactJsonSchema(schema, COMPACT_PARAMETER_DESCRIPTIONS[name] ?? {}))
}

function compactJsonSchema(value: JSONSchema7, descriptions: Record<string, string>, property?: string): JSONSchema7 {
  if (typeof value === "boolean") return value
  return compactJsonSchemaRecord(value, descriptions, property)
}

function compactJsonSchemaValue(value: unknown, descriptions: Record<string, string>, property?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => compactJsonSchemaValue(item, descriptions))
  if (!isRecord(value)) return value
  return compactJsonSchemaRecord(value, descriptions, property)
}

function compactJsonSchemaRecord(value: object, descriptions: Record<string, string>, property?: string): JSONSchema7 {
  const compacted = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "description")
      .map(([key, item]) => [
        key,
        key === "properties" && isRecord(item)
          ? Object.fromEntries(
              Object.entries(item).map(([propertyName, propertyValue]) => [
                propertyName,
                compactJsonSchemaValue(propertyValue, descriptions, propertyName),
              ]),
            )
          : compactJsonSchemaValue(item, descriptions),
      ]),
  )
  return property && descriptions[property] ? { ...compacted, description: descriptions[property] } : compacted
}

function isJsonSchema(value: unknown): value is JSONSchema7 {
  return typeof value === "boolean" || isRecord(value)
}

export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

export * as LLMRequestPrep from "./request"
