export * as LocalTool from "./local"

import path from "path"
import { pathToFileURL } from "url"
import { ToolFailure } from "@opencode-ai/llm"
import { Effect, JsonSchema, Layer, Option, Schema } from "effect"
import { z, type ZodRawShape } from "zod"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { Npm } from "../npm"
import { PermissionV2 } from "../permission"
import { Surface } from "../surface"
import { SessionPlanDocument } from "../session/plan-document"
import { NativeJob } from "../session/native-job"
import { Tool } from "./tool"
import { Tools } from "./tools"

type LocalToolContext = {
  readonly sessionID: string
  readonly messageID: string
  readonly callID: string
  readonly agent: string
  readonly directory: string
  readonly worktree: string
  readonly abort: AbortSignal
  readonly explicitInvocation?: Tool.Context["explicitInvocation"]
  readonly metadata: (input: { readonly title?: string; readonly metadata?: Record<string, unknown> }) => void
  readonly ask: (input: unknown) => Promise<void>
  readonly customPart: (input: unknown) => Promise<void>
  readonly sessionContext: {
    readonly planDocument: () => Promise<SessionPlanDocument.Info | undefined>
    readonly actionInvocations: () => Promise<Surface.SessionActionInvocation[]>
  }
  /** Host bridge into another physical checkout's native task runtime. Absent
   * where the host owns no Location map; it never grants write consent. */
  readonly nativeJob?: NativeJob.NativeJobBridge
}

type LocalToolMetadata = {
  readonly title?: string
  readonly metadata?: Record<string, unknown>
}

type LocalToolDefinition = {
  readonly description: string
  readonly alwaysVisible?: boolean
  /** Contract marker that scopes the advertised tool to matching current-prompt turns. */
  readonly contractMarker?: string
  readonly explicitInvocation?: string | ReadonlyArray<string>
  readonly budgetCategory?: "read" | "poll" | "other"
  readonly args: ZodRawShape
  readonly execute: (args: Record<string, unknown>, context: LocalToolContext) => Promise<LocalToolResult>
}

type LocalToolAttachment = {
  readonly type: "file"
  readonly mime: string
  readonly url: string
  readonly filename?: string
}

type LocalToolResult =
  | string
  | {
      readonly title?: string
      readonly output: string
      readonly metadata?: Record<string, unknown>
      readonly attachments?: ReadonlyArray<LocalToolAttachment>
    }

const EXTENSIONS = new Set([".ts", ".js", ".mjs", ".mts", ".cjs"])
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const npm = yield* Npm.Service
    const tools = yield* Tools.Service
    const projectConfig = path.join(location.project.directory, ".opencode")
    if (yield* fs.existsSafe(path.join(projectConfig, "package.json"))) {
      yield* npm.install(projectConfig).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Project local tool dependency install failed", {
            directory: projectConfig,
            error: error.message,
          }),
        ),
      )
    }
    const entries = yield* discover(fs, global.config, location.project.directory)
    const loaded = yield* Effect.forEach(entries, (entry) => load(entry, location), { concurrency: "unbounded" })
    const valid = loaded.filter((item): item is readonly [string, Tool.AnyTool] => item !== undefined)
    yield* Effect.forEach(
      valid,
      ([name, tool]) =>
        tools.register({ [name]: tool }).pipe(
          Effect.catchTag("Tool.RegistrationError", (error) =>
            Effect.logError("Blocking colliding local tool without failing the Location", {
              tool: name,
              error: error.message,
            }),
          ),
        ),
      { discard: true },
    )
  }),
)

type Entry = {
  readonly name: string
  readonly file: string
  readonly placement: "global" | "project"
  readonly project?: string
  readonly version?: string
  readonly description?: string
}

const discover = Effect.fn("LocalTool.discover")(function* (
  fs: FSUtil.Interface,
  configDirectory: string,
  projectDirectory: string,
) {
  const directories = [
    { directory: path.join(configDirectory, "tool"), placement: "global" as const },
    { directory: path.join(configDirectory, "tools"), placement: "global" as const },
    { directory: path.join(projectDirectory, ".opencode", "tool"), placement: "project" as const },
    { directory: path.join(projectDirectory, ".opencode", "tools"), placement: "project" as const },
  ]
  const nested = yield* Effect.forEach(
    directories,
    (source) =>
      fs.readDirectoryEntries(source.directory).pipe(
        Effect.catch(() => Effect.succeed([])),
        Effect.map((entries) =>
          entries
            .filter(
              (entry) =>
                entry.type === "file" && EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith(".d.ts"),
            )
            .toSorted((left, right) => left.name.localeCompare(right.name))
            .map((entry) => ({
              name: path.basename(entry.name, path.extname(entry.name)),
              file: path.join(source.directory, entry.name),
              placement: source.placement,
            })),
        ),
      ),
    { concurrency: "unbounded" },
  )
  const discovered = nested.flat()
  const manifestPath = path.join(projectDirectory, ".opencode", "tools", "manifest.json")
  const manifestText = yield* fs.readFileStringSafe(manifestPath).pipe(Effect.catch(() => Effect.succeed(undefined)))
  let project = discovered.filter((entry) => entry.placement === "project")
  if (manifestText !== undefined) {
    const manifest = parseManifest(manifestText, path.dirname(manifestPath))
    if (!manifest) {
      yield* Effect.logError("Blocking project local tools because manifest.json is invalid", { manifest: manifestPath })
      project = []
    } else {
      const canonicalDirectory = yield* fs.realPath(path.dirname(manifestPath)).pipe(Effect.catch(() => Effect.void))
      if (!canonicalDirectory) {
        yield* Effect.logError("Blocking project local tools because the manifest directory cannot be resolved", {
          manifest: manifestPath,
        })
        project = []
      } else {
        const canonical = yield* Effect.forEach(
          manifest.tools,
          (tool) =>
            fs.realPath(tool.file).pipe(
              Effect.map((file) => ({ ...tool, file })),
              Effect.catch(() => Effect.succeed(undefined)),
            ),
          { concurrency: "unbounded" },
        )
        if (
          canonical.some(
            (tool) =>
              !tool ||
              (() => {
                const child = path.relative(canonicalDirectory, tool.file)
                return child === ".." || child.startsWith(`..${path.sep}`) || path.isAbsolute(child)
              })(),
          )
        ) {
          yield* Effect.logError("Blocking project local tools because a manifest entry is missing or escapes through a symlink", {
            manifest: manifestPath,
          })
          project = []
        } else {
          project = canonical.map((tool) => ({
            name: tool!.id,
            file: tool!.file,
            placement: "project" as const,
            project: manifest.project,
            version: tool!.version,
            description: tool!.description,
          }))
        }
      }
    }
  }
  const global = discovered.filter((entry) => entry.placement === "global")
  const globalNames = new Set(global.map((entry) => entry.name))
  const accepted: Entry[] = []
  const seen = new Set<string>()
  for (const entry of project) {
    if (globalNames.has(entry.name)) {
      yield* Effect.logError("Blocking project local tool because its ID collides with a global local tool", {
        tool: entry.name,
        file: entry.file,
      })
      continue
    }
    if (seen.has(entry.name)) {
      yield* Effect.logError("Blocking duplicate project local tool ID", { tool: entry.name, file: entry.file })
      continue
    }
    seen.add(entry.name)
    accepted.push(entry)
  }
  return [...global, ...accepted]
})

const load = Effect.fn("LocalTool.load")(function* (entry: Entry, location: Location.Interface) {
  if (!TOOL_NAME.test(entry.name)) {
    yield* Effect.logWarning("Skipping local tool with invalid name", { name: entry.name, file: entry.file })
    return undefined
  }
  const imported = yield* Effect.tryPromise({
    try: () => import(pathToFileURL(entry.file).href),
    catch: (cause) => new ToolFailure({ message: describeCause(cause) }),
  }).pipe(
    Effect.catchTag("LLM.ToolFailure", (error) =>
      Effect.logWarning("Skipping local tool that failed to import", { file: entry.file, error: error.message }).pipe(
        Effect.as(undefined),
      ),
    ),
  )
  if (!imported) return undefined
  const definition = isLocalToolDefinition(imported.default) ? imported.default : undefined
  if (!definition) {
    yield* Effect.logWarning("Skipping local tool with invalid default export", { file: entry.file })
    return undefined
  }
  const permission = yield* Effect.serviceOption(PermissionV2.Service)
  const documents = yield* Effect.serviceOption(SessionPlanDocument.Service)
  const surface = yield* Effect.serviceOption(Surface.Service)
  const nativeJob = yield* Effect.serviceOption(NativeJob.Bridge)
  return [entry.name, adapt(definition, location, { permission, documents, surface, nativeJob }, entry)] as const
})

function parseManifest(input: string, directory: string) {
  try {
    const value = JSON.parse(input) as unknown
    if (
      !isRecord(value) ||
      value.schema !== "opencode.tools/v1" ||
      value.version !== 1 ||
      typeof value.project !== "string" ||
      !value.project.trim()
    )
      return
    if (!Array.isArray(value.tools)) return
    const tools: Array<{ id: string; file: string; version: string; description: string }> = []
    const seen = new Set<string>()
    for (const item of value.tools) {
      if (
        !isRecord(item) ||
        typeof item.id !== "string" ||
        typeof item.entry !== "string" ||
        typeof item.version !== "string" ||
        !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(item.version) ||
        typeof item.description !== "string" ||
        !item.description.trim()
      )
        return
      if (!TOOL_NAME.test(item.id) || seen.has(item.id) || !EXTENSIONS.has(path.extname(item.entry))) return
      seen.add(item.id)
      const file = path.resolve(directory, item.entry)
      const relative = path.relative(directory, file)
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return
      tools.push({ id: item.id, file, version: item.version, description: item.description.trim() })
    }
    return { project: value.project, tools }
  } catch {
    return undefined
  }
}

export function adapt(
  definition: LocalToolDefinition,
  location: Location.Interface,
  services: {
    readonly permission: Option.Option<PermissionV2.Interface>
    readonly documents: Option.Option<SessionPlanDocument.Interface>
    readonly surface: Option.Option<Surface.Interface>
    readonly nativeJob?: Option.Option<NativeJob.NativeJobBridge>
  },
  entry?: Entry,
) {
  const input = z.object(definition.args)
  const nativeJob = services.nativeJob?._tag === "Some" ? services.nativeJob.value : undefined
  const tool = Tool.make({
    description: entry?.description ?? definition.description,
    ...(definition.budgetCategory ? { budgetCategory: () => definition.budgetCategory! } : {}),
    input: Schema.Unknown,
    output: Schema.Unknown,
    inputSchema: z.toJSONSchema(input) as JsonSchema.JsonSchema,
    validateInput: (value) => {
      const result = input.safeParse(value)
      if (result.success) return undefined
      return result.error.message
    },
    execute: (value, context) =>
      Effect.tryPromise({
        try: async (abort) => {
          const metadata: LocalToolMetadata[] = []
          const result = await definition.execute(input.parse(value), {
            sessionID: String(context.sessionID),
            messageID: String(context.assistantMessageID),
            callID: context.toolCallID,
            agent: String(context.agent),
            directory: location.directory,
            worktree: location.project.directory,
            abort,
            ...(context.explicitInvocation ? { explicitInvocation: context.explicitInvocation } : {}),
            metadata: (input) => metadata.push(input),
            ask: (input) => {
              if (!isAskInput(input) || services.permission._tag === "None") return unsupported("ask")()
              return Effect.runPromise(
                services.permission.value.assert({
                  action: input.permission,
                  resources: input.patterns,
                  save: input.always,
                  metadata: input.metadata,
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                }),
              )
            },
            customPart: unsupported("customPart"),
            sessionContext: {
              planDocument: () =>
                services.documents._tag === "Some"
                  ? Effect.runPromise(services.documents.value.read(context.sessionID))
                  : Promise.resolve(undefined),
              actionInvocations: () =>
                services.surface._tag === "Some"
                  ? Effect.runPromise(services.surface.value.actionInvocations(context.sessionID)).then((items) => [...items])
                  : Promise.resolve([]),
            },
            ...(nativeJob ? { nativeJob } : {}),
          })
          return normalizeResult(result, metadata)
        },
        catch: (cause) => new ToolFailure({ message: describeCause(cause) }),
      }),
    toModelOutput: ({ output }) => content(output),
  })
  const scoped = definition.contractMarker
    ? Tool.withContractMarker(definition.alwaysVisible ? Tool.withAlwaysVisible(tool) : tool, definition.contractMarker)
    : definition.alwaysVisible
      ? Tool.withAlwaysVisible(tool)
      : tool
  return Tool.withCatalog(
    definition.explicitInvocation !== undefined
      ? Tool.withExplicitInvocation(scoped, definition.explicitInvocation)
      : scoped,
    {
      scope: "location",
      project:
        entry?.placement === "project" ? (entry.project ?? path.basename(location.project.directory)) : undefined,
      source: entry?.file,
      version: entry?.version,
    },
  )
}

function isAskInput(input: unknown): input is {
  permission: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
} {
  return (
    isRecord(input) &&
    typeof input.permission === "string" &&
    Array.isArray(input.patterns) &&
    input.patterns.every((item) => typeof item === "string") &&
    Array.isArray(input.always) &&
    input.always.every((item) => typeof item === "string") &&
    isRecord(input.metadata)
  )
}

function normalizeResult(result: LocalToolResult, metadata: ReadonlyArray<LocalToolMetadata>): LocalToolResult {
  const merged = Object.assign({}, ...metadata.flatMap((item) => (item.metadata ? [item.metadata] : [])))
  const title = metadata.findLast((item) => item.title)?.title
  if (typeof result === "string") {
    if (!title && Object.keys(merged).length === 0) return result
    return { output: result, ...(title ? { title } : {}), ...(Object.keys(merged).length ? { metadata: merged } : {}) }
  }
  return {
    ...result,
    ...(title && !result.title ? { title } : {}),
    ...(Object.keys(merged).length > 0 || result.metadata ? { metadata: { ...merged, ...result.metadata } } : {}),
  }
}

function unsupported(name: string) {
  return async () => {
    throw new Error(`Local tool context.${name} is not supported by the Core tool adapter yet`)
  }
}

function content(output: unknown): Tool.Content[] {
  if (typeof output === "string") return [{ type: "text", text: output }]
  if (!isRecord(output) || typeof output.output !== "string") return [{ type: "text", text: String(output) }]
  return [
    { type: "text", text: output.output },
    ...list(output.attachments).flatMap((attachment) => attachmentContent(attachment)),
  ]
}

function attachmentContent(input: unknown): Tool.Content[] {
  if (!isRecord(input) || input.type !== "file" || typeof input.mime !== "string" || typeof input.url !== "string")
    return []
  const data = dataUrl(input.url)
  if (!data)
    return [{ type: "text", text: `Attachment: ${typeof input.filename === "string" ? input.filename : input.url}` }]
  return [{ type: "file", data, mime: input.mime, name: text(input.filename) }]
}

function dataUrl(url: string) {
  const match = url.match(/^data:[^,]*?(;base64)?,(.*)$/s)
  if (!match) return undefined
  if (match[1]) return match[2]
  return Buffer.from(decodeURIComponent(match[2]), "utf8").toString("base64")
}

function isLocalToolDefinition(input: unknown): input is LocalToolDefinition {
  return (
    isRecord(input) &&
    typeof input.description === "string" &&
    isRecord(input.args) &&
    typeof input.execute === "function"
  )
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input)
}

function list(input: unknown): unknown[] {
  return Array.isArray(input) ? input : []
}

function text(input: unknown) {
  return typeof input === "string" ? input : undefined
}

function describeCause(cause: unknown) {
  if (cause instanceof Error) return cause.message
  return String(cause)
}
