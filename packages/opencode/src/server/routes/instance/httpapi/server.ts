import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { setTimeout } from "node:timers/promises"
import type { ModelMessage } from "ai"
import { Cause, Config as EffectConfig, Context, Effect, Layer, Stream } from "effect"
import { Option } from "effect"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import {
  HttpClient,
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
  Multipart,
} from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { existsSync, readFileSync } from "fs"
import { basename, extname, isAbsolute, join, resolve } from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AIChain } from "@opencode-ai/core/ai-chain"
import { Global } from "@opencode-ai/core/global"
import { ConfigStorageCleanup } from "@opencode-ai/core/config/storage-cleanup"
import { ModelRequest } from "@opencode-ai/core/model-request"
import { Control } from "@opencode-ai/core/control"
import { readOwnedMailView } from "@opencode-ai/core/mail/manager-view"
import { managerSelection, applyMailView, wishMailView } from "@opencode-ai/core/mail/manager-execution"
import { gmxAccount, gmxApply } from "@opencode-ai/core/mail/manager-gmx"
import { gmailApply } from "@opencode-ai/core/mail/manager-gmail"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { Hash } from "@opencode-ai/core/util/hash"
import { ProviderV2 } from "@opencode-ai/core/provider"
import * as Observability from "@opencode-ai/core/observability"
import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { Workspace } from "@/control-plane/workspace"
import { Env } from "@/env"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { Git } from "@/git"
import { HeadlessAI } from "@/headless-ai"
import { Installation } from "@/installation"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { PluginPtyEnvironment } from "@/plugin/pty-environment"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { ProjectIconGeneration } from "@/project/icon-generation"
import { Vcs } from "@/project/vcs"
import { ProviderAuth } from "@/provider/auth"
import { Provider } from "@/provider/provider"
import { executeGmailFormAction, GmailActionError, suggestGmailRecipients } from "@/email/gmail"
import { executeGmxFormAction } from "@/email/gmx"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { STT } from "@/stt"
import { anonymizeModelRef, sttAttemptDiagnostic, sttJobDiagnostic } from "@/stt/diagnostics"
import { TTS } from "@/tts"
import { TurnCompletion } from "@/session/turn-completion"
import { TurnCompletionV2 } from "@/session/turn-completion-v2"
import { SessionShare } from "@/share/session"
import { ShareNext } from "@/share/share-next"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { Worktree } from "@/worktree"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/layer-node-platform"
import { EventV2 } from "@opencode-ai/core/event"
import { ContentStore } from "@opencode-ai/core/content-store"
import { SessionArchive } from "@opencode-ai/core/session-archive"
import { SessionArchiveMaintenance } from "@opencode-ai/core/session-archive-maintenance"
import { StorageMaintenance } from "@opencode-ai/core/storage-maintenance"
import { StorageCleanup } from "@opencode-ai/core/storage-cleanup"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { StorageMigrationRuntime } from "@/storage-migration-runtime"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Npm } from "@opencode-ai/core/npm"
import { ProjectV2 } from "@opencode-ai/core/project"
import { PtyTicket } from "@opencode-ai/core/pty/ticket"
import { QuestionV2 } from "@opencode-ai/core/question"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { lazy } from "@/util/lazy"
import { AppPluginAssets } from "@/plugin/app/assets"
import { AppPluginHostImages } from "@/plugin/app/host-images"
import { absolutePluginDirectory, hostRouteDirectory } from "@/plugin/directory"
import {
  installLocalPlugin,
  installLocalSkill,
  listLocalExtensions,
  uninstallLocalPlugin,
  uninstallLocalSkill,
} from "@/plugin/local-manager"
import { isRecord } from "@opencode-ai/core/util/record"
import { CorsConfig, isAllowedCorsOrigin, type CorsOptions } from "@opencode-ai/server/cors"
import { serveUIEffect } from "@/server/shared/ui"
import { ServerAuth } from "@/server/auth"
import { AppState } from "@/server/app-state"
import { windowsPowerShellExecutable } from "@/util/windows-powershell"
import { InstanceHttpApi, RootHttpApi } from "./api"
import { Api } from "@opencode-ai/server/api"
import { PublicApi } from "./public"
import {
  authorizationLayer,
  authorizationRouterMiddleware,
  ptyConnectAuthorizationLayer,
  serverAuthorizationLayer,
} from "./middleware/authorization"
import { EventApi } from "./groups/event"
import { PtyConnectApi } from "./groups/pty"
import { eventHandlers } from "./handlers/event"
import { configHandlers } from "./handlers/config"
import { controlHandlers } from "./handlers/control"
import { controlPlaneHandlers } from "./handlers/control-plane"
import { experimentalHandlers } from "./handlers/experimental"
import { fileHandlers } from "./handlers/file"
import { globalHandlers } from "./handlers/global"
import { instanceHandlers } from "./handlers/instance"
import { mcpHandlers } from "./handlers/mcp"
import { permissionHandlers } from "./handlers/permission"
import { perfHandlers } from "./handlers/perf"
import { projectHandlers } from "./handlers/project"
import { projectCopyHandlers } from "./handlers/project-copy"
import { providerHandlers } from "./handlers/provider"
import { ptyConnectHandlers, ptyHandlers } from "./handlers/pty"
import { sessionHandlers } from "./handlers/session"
import { pluginServicesHandlers } from "./handlers/plugin-services"
import { syncHandlers } from "./handlers/sync"
import { tuiHandlers } from "./handlers/tui"
import { handlerLayer, sessionArchiveServerLayer, sessionRuntimeLayer } from "@opencode-ai/server/handlers"
import { CommandPlugin } from "@opencode-ai/server/command-plugin"
import { schemaErrorLayer as v2SchemaErrorLayer } from "@opencode-ai/server/middleware/schema-error"
import { workspaceHandlers } from "./handlers/workspace"
import { instanceContextLayer } from "./middleware/instance-context"
import { v2WorkspaceRoutingLayer, workspaceRoutingLayer } from "./middleware/workspace-routing"
import { disposeMiddleware } from "./lifecycle"
import { measureServerStartLayer } from "./server-start-diagnostics"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { compressionLayer } from "./middleware/compression"
import { corsVaryFix } from "./middleware/cors-vary"
import { mutationOriginGuard } from "./middleware/origin-guard"
import { errorLayer } from "./middleware/error"
import { fenceLayer } from "./middleware/fence"
import { schemaErrorLayer } from "./middleware/schema-error"
import { ProofAttachment } from "@/attachment/proof"
import { locateSessionAttachment } from "@/attachment/content"
import { AttachmentPreview } from "@/attachment/preview"

export const context = Context.makeUnsafe<unknown>(new Map())

const cors = (corsOptions?: CorsOptions) =>
  HttpRouter.middleware(
    HttpMiddleware.cors({
      allowedOrigins: (origin) => isAllowedCorsOrigin(origin, corsOptions),
      maxAge: 86_400,
    }),
    { global: true },
  )

// Route tree:
// - rootApiRoutes: typed /global/* and control routes; auth is declared by RootHttpApi.
// - eventApiRoutes: typed SSE route with instance routing context and its existing API contract.
// - ptyConnectApiRoutes: typed WebSocket upgrade route with ticket-aware auth.
// - instanceApiRoutes: remaining typed instance routes.
// - uiRoute: raw catch-all fallback; auth is router middleware so public static assets can bypass it.
const authOnlyRouterLayer = authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const httpApiAuthLayer = authorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const ptyConnectHttpApiAuthLayer = ptyConnectAuthorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const serverHttpApiAuthLayer = serverAuthorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const workspaceRoutingLive = workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))
const v2WorkspaceRoutingLive = v2WorkspaceRoutingLayer.layer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))
const rootApiRoutes = HttpApiBuilder.layer(RootHttpApi).pipe(
  Layer.provide([controlHandlers, controlPlaneHandlers, perfHandlers, globalHandlers]),
  Layer.provide(schemaErrorLayer),
  Layer.provide(httpApiAuthLayer),
)
const eventApiRoutes = HttpApiBuilder.layer(EventApi).pipe(
  Layer.provide(eventHandlers),
  Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer]),
)
const ptyConnectApiRoutes = HttpApiBuilder.layer(PtyConnectApi).pipe(
  Layer.provide(ptyConnectHandlers),
  Layer.provide([ptyConnectHttpApiAuthLayer, workspaceRoutingLive, instanceContextLayer]),
)
const instanceApiRoutes = HttpApiBuilder.layer(InstanceHttpApi).pipe(
  Layer.provide([
    configHandlers,
    experimentalHandlers,
    fileHandlers,
    instanceHandlers,
    mcpHandlers,
    projectHandlers,
    projectCopyHandlers,
    ptyHandlers,
    permissionHandlers,
    providerHandlers,
    sessionHandlers,
    pluginServicesHandlers,
    syncHandlers,
    tuiHandlers,
    workspaceHandlers,
  ]),
)

const instanceRoutes = instanceApiRoutes.pipe(
  Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer, schemaErrorLayer]),
)
const serverRoutes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(handlerLayer),
  Layer.provide(
    Layer.effect(
      CommandPlugin.Service,
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        return CommandPlugin.Service.of({
          transform: (input) =>
            Effect.gen(function* () {
              const output = { parts: [{ type: "text" as const, text: input.text }] }
              yield* plugin.trigger(
                "command.execute.before",
                {
                  command: input.command,
                  sessionID: input.sessionID,
                  arguments: input.arguments,
                },
                output,
              )
              return output.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
            }),
        })
      }),
    ),
  ),
  Layer.provide(PluginPtyEnvironment.layer),
  Layer.provide([serverHttpApiAuthLayer, v2SchemaErrorLayer, v2WorkspaceRoutingLive]),
)

// `OpenApi.fromApi` is non-trivial; defer until /doc is actually hit so
// processes that never serve it (CLI, scripts) don't pay at module load.
// `HttpServerResponse.jsonUnsafe` runs JSON.stringify eagerly, so caching
// the response also caches the serialized body â€” every /doc request reuses
// the same Uint8Array instead of re-stringifying the spec.
const docResponse = lazy(() => HttpServerResponse.jsonUnsafe(OpenApi.fromApi(PublicApi)))

const docRoute = HttpRouter.use((router) => router.add("GET", "/doc", () => Effect.succeed(docResponse()))).pipe(
  Layer.provide(authOnlyRouterLayer),
)

function jsonObject(text: string) {
  const data = JSON.parse(text) as unknown
  if (!isRecord(data)) throw new Error("Expected JSON object")
  return data
}

// A cross-site form can POST text/plain without a CORS preflight; refusing
// every explicit non-JSON content type removes that CSRF transport.
function jsonRequestBody(text: string, contentType: string | undefined) {
  const type = contentType?.split(";")[0]?.trim().toLowerCase()
  if (type && type !== "application/json") throw new Error("Expected application/json request body")
  return jsonObject(text)
}

function requiredString(data: Record<string, unknown>, key: string) {
  const value = data[key]
  if (typeof value !== "string" || !value.trim()) throw new Error(`Expected ${key}`)
  return value
}

function optionalString(data: Record<string, unknown>, key: string) {
  const value = data[key]
  return typeof value === "string" && value.trim() ? value : undefined
}

function appStateKeyFromUrl(url: URL) {
  const key = url.pathname.split("/").filter(Boolean)[2]
  if (!key || !/^[a-zA-Z0-9._-]+$/.test(key)) return
  return key
}

function localMediaPath(url: URL, headers: Record<string, string | undefined>) {
  const source = url.searchParams.get("path")?.trim()
  if (!source) return
  if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !source.startsWith("file://") && !/^[A-Za-z]:[\\/]/.test(source)) return
  const file = source.startsWith("file://") ? fileURLToPath(source) : source
  if (isAbsolute(file)) {
    // Absolute media paths are only served when they stay inside the
    // explicitly supplied directory; otherwise the route becomes a local file
    // existence oracle for any caller that can reach the server.
    const scopedDirectory = url.searchParams.get("directory") ?? headers["x-opencode-directory"]
    if (!scopedDirectory) return
    const scopedBase = resolve(scopedDirectory)
    const scopedFile = resolve(file)
    if (!FSUtil.contains(scopedBase, scopedFile)) return
    return scopedFile
  }
  const directory = url.searchParams.get("directory") ?? headers["x-opencode-directory"]
  if (!directory) return
  const base = resolve(directory)
  const resolved = resolve(base, file)
  if (!FSUtil.contains(base, resolved)) return
  return resolved
}

function localMediaType(file: string) {
  const extension = extname(file).toLowerCase()
  if (extension === ".png") return "image/png"
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg"
  if (extension === ".gif") return "image/gif"
  if (extension === ".webp") return "image/webp"
  if (extension === ".avif") return "image/avif"
  if (extension === ".bmp") return "image/bmp"
  if (extension === ".mp4" || extension === ".m4v") return "video/mp4"
  if (extension === ".webm") return "video/webm"
  if (extension === ".ogv" || extension === ".ogg") return "video/ogg"
  if (extension === ".mov") return "video/quicktime"
}

const questionAttachmentLimit = 20 * 1024 * 1024
const questionAttachmentTypes = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
])

function questionAttachmentMime(value: string | undefined) {
  return value?.split(";", 1)[0]?.trim().toLowerCase()
}

function questionAttachmentFilename(value: string | undefined, extension: string) {
  const name = basename(value?.trim() || `question-attachment${extension}`).replace(/[^a-zA-Z0-9._-]/g, "_")
  if (!name || name === "." || name === "..") return `question-attachment${extension}`
  return extname(name) ? name : `${name}${extension}`
}

function questionAttachmentDirectory(directory: string) {
  return join(Global.Path.state, "question-attachments", Hash.fast(directory))
}

function questionAttachmentBody(stream: Stream.Stream<Uint8Array, unknown>) {
  return Stream.runFoldEffect(
    stream,
    () => ({ chunks: [] as Uint8Array[], size: 0, tooLarge: false }),
    (body, chunk) =>
      Effect.succeed(
        body.tooLarge || body.size + chunk.byteLength > questionAttachmentLimit
          ? { chunks: [] as Uint8Array[], size: body.size + chunk.byteLength, tooLarge: true }
          : { chunks: [...body.chunks, chunk], size: body.size + chunk.byteLength, tooLarge: false },
      ),
  ).pipe(
    Effect.map((body) => {
      if (body.tooLarge) return { tooLarge: true as const }
      const bytes = new Uint8Array(body.size)
      body.chunks.reduce((offset, chunk) => {
        bytes.set(chunk, offset)
        return offset + chunk.byteLength
      }, 0)
      return { tooLarge: false as const, bytes }
    }),
  )
}

async function readAppState(key: string) {
  return AppState.read(key)
}

async function writeAppState(key: string, data: Record<string, unknown>) {
  await AppState.write(key, data)
}

function optionalBoolean(data: Record<string, unknown>, key: string) {
  return data[key] === true
}

function optionalStringArray(data: Record<string, unknown>, key: string) {
  const value = data[key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined
}

function formActionInput(data: Record<string, unknown>) {
  const values = data.values
  const action = data.action
  if (!isRecord(values)) throw new Error("Expected values")
  if (!isRecord(action)) throw new Error("Expected action")
  if (typeof data.revision !== "number" || !Number.isInteger(data.revision) || data.revision < 1)
    throw new Error("Expected revision")
  return {
    requestID: requiredString(data, "requestID"),
    revision: data.revision,
    invocationID: requiredString(data, "invocationID"),
    target:
      isRecord(data.target) &&
      (data.target.kind === "request" || data.target.kind === "tool") &&
      typeof data.target.id === "string" &&
      typeof data.target.revision === "number"
        ? { kind: data.target.kind as "request" | "tool", id: data.target.id, revision: data.target.revision }
        : { kind: "request" as const, id: requiredString(data, "requestID"), revision: data.revision },
    directory: requiredString(data, "directory"),
    formID: requiredString(data, "formID"),
    values,
    action: {
      id: requiredString(action, "id"),
      source: optionalString(action, "source"),
    },
  }
}

export function formActionProblem(
  requests: ReadonlyArray<QuestionV2.Request>,
  input: ReturnType<typeof formActionInput>,
  action: Control.SurfaceAction | undefined,
  tools: ReadonlyArray<QuestionV2.PersistentTool> = [],
) {
  const target = formActionTarget(requests, tools, input)
  if (!target) return "Form action Surface is no longer available"
  if (target.revision !== input.target.revision) return "Form action Surface revision changed"
  const form = requestForms(target).find((item) => item.id === input.formID)
  if (!form) return "Form action does not match the pending form"
  if (!action) return "Form action is not allowed by this form"
  const step = hostFormActionStep(action.steps)
  if (!step) return "Form action has no host step"
  if (action.trigger.event !== "submit" && action.trigger.event !== "click" && action.trigger.event !== "change")
    return "Form action is not a host action"
  if (action.trigger.event === "change" && step.type !== "command") return "Form change action must use a command step"
  if (
    (action.trigger.event === "click" || action.trigger.event === "change") &&
    action.trigger.source &&
    input.action.source !== action.trigger.source
  )
    return "Form action source does not match the triggering control"
  if (
    action.trigger.when &&
    String(input.values[action.trigger.when.field] ?? "") !== String(action.trigger.when.equals)
  ) {
    return "Form action does not match the selected value"
  }
  if (step.type === "gmail" || step.type === "gmx") return gmailFormValuesProblem(form, input.values)
  if (step.type === "command" && !step.command) return "Command form action is missing a command"
}

export function formActionProblemRetry(problem: string) {
  return problem === "Form action Surface is no longer available" ? ("reconcile" as const) : ("safe" as const)
}

export function formActionForInput(
  requests: ReadonlyArray<QuestionV2.Request>,
  input: ReturnType<typeof formActionInput>,
  tools: ReadonlyArray<QuestionV2.PersistentTool> = [],
) {
  return formActionTarget(requests, tools, input)
    ? requestForms(formActionTarget(requests, tools, input)!)
        .find((item) => item.id === input.formID)
        ?.actions?.find((item) => item.id === input.action.id)
    : undefined
}

function formActionTarget(
  requests: ReadonlyArray<QuestionV2.Request>,
  tools: ReadonlyArray<QuestionV2.PersistentTool>,
  input: ReturnType<typeof formActionInput>,
) {
  if (input.target.kind === "tool") return tools.find((item) => String(item.id) === input.target.id)
  return requests.find((item) => String(item.id) === input.target.id)
}

function gmailRecipientsInput(url: URL) {
  return {
    target: {
      kind: url.searchParams.get("targetKind") === "tool" ? ("tool" as const) : ("request" as const),
      id: url.searchParams.get("targetID") ?? "",
      revision: Number(url.searchParams.get("targetRevision") ?? 0),
    },
    directory: url.searchParams.get("directory") ?? "",
    formID: url.searchParams.get("formID") ?? "",
    fieldID: url.searchParams.get("fieldID") ?? "",
    query: url.searchParams.get("q") ?? "",
    refresh: url.searchParams.get("refresh") === "true",
  }
}

function gmailRecipientsProblem(
  requests: ReadonlyArray<QuestionV2.Request>,
  input: ReturnType<typeof gmailRecipientsInput>,
  tools: ReadonlyArray<QuestionV2.PersistentTool> = [],
) {
  if (!input.target.id.trim()) return "Expected targetID"
  if (!Number.isInteger(input.target.revision) || input.target.revision < 1) return "Expected targetRevision"
  if (!input.directory.trim()) return "Expected directory"
  if (!input.formID.trim()) return "Expected formID"
  if (!input.fieldID.trim()) return "Expected fieldID"
  const target =
    input.target.kind === "tool"
      ? tools.find((item) => String(item.id) === input.target.id)
      : requests.find((item) => String(item.id) === input.target.id)
  if (target?.revision !== input.target.revision) return "Gmail recipient Surface revision changed"
  const matched = target ? requestForms(target).find((item) => item.id === input.formID) : undefined
  if (!matched) return "Gmail recipient lookup does not match a pending form"
  const field = matched.fields.find((item) => item.id === input.fieldID)
  if (!field) return "Gmail recipient field is not allowed"
  if (field.type !== "recipient_list" || field.autocomplete?.provider !== "gmail-recipients")
    return "Gmail recipient field is not allowed"
  if (input.query.trim().length < (typeof field.autocomplete.minLength === "number" ? field.autocomplete.minLength : 2))
    return "Gmail recipient query is too short"
}

function requestForms(request: QuestionV2.Request | QuestionV2.PersistentTool) {
  if (!("surface" in request)) return request.questions.flatMap((item) => (item.form ? [item.form] : []))
  return request.surface.controls.flatMap((item) => (item.form ? [item.form] : []))
}

function hostFormActionStep(steps: ReadonlyArray<Control.SurfaceActionStep>) {
  return steps.find((step) => step.type === "gmail" || step.type === "gmx" || step.type === "mail_manager" || step.type === "command" || step.type === "dismiss")
}

function gmailFormValuesProblem(form: Control.FormDefinition, values: Record<string, unknown>) {
  const required = gmailFieldProblem(form, values, "to", ["recipient_list"], true)
  if (required) return required
  const subject = gmailFieldProblem(form, values, "subject", ["text"], true)
  if (subject) return subject
  const body = gmailFieldProblem(form, values, "body", ["rich_text", "textarea", "text"], true)
  if (body) return body
  const cc = gmailFieldProblem(form, values, "cc", ["recipient_list"], false)
  if (cc) return cc
  const bcc = gmailFieldProblem(form, values, "bcc", ["recipient_list"], false)
  if (bcc) return bcc
  return gmailFieldProblem(form, values, "attachments", ["attachment_list", "file_picker"], false)
}

function gmailFieldProblem(
  form: Control.FormDefinition,
  values: Record<string, unknown>,
  id: string,
  types: string[],
  required: boolean,
) {
  const field = form.fields.find((item) => item.id === id)
  if (!field) return required || hasFormValue(values[id]) ? `Gmail form field is not allowed: ${id}` : undefined
  if (!types.includes(field.type)) return `Gmail form field has unsupported type: ${id}`
  if (required && !hasFormValue(values[id])) return `Missing Gmail form field value: ${id}`
  return undefined
}

function hasFormValue(value: unknown) {
  if (Array.isArray(value)) return value.some(hasFormValue)
  if (typeof value === "string") return value.trim().length > 0
  return value !== undefined && value !== null && value !== false
}

export function questionPending(question: QuestionV2.Interface, requestID: string) {
  return question.list().pipe(Effect.map((requests) => requests.some((item) => String(item.id) === requestID)))
}

export function closeQuestion(question: QuestionV2.Interface, requestID: string) {
  return question
    .reject(QuestionV2.ID.make(requestID))
    .pipe(Effect.catchTag("QuestionV2.NotFoundError", () => Effect.void))
}

function installInput(data: Record<string, unknown>) {
  return {
    directory: requiredString(data, "directory"),
    source: requiredString(data, "source"),
    force: optionalBoolean(data, "force"),
  }
}

function pluginUninstallInput(data: Record<string, unknown>) {
  return {
    directory: requiredString(data, "directory"),
    spec: requiredString(data, "spec"),
    file: optionalString(data, "file"),
    deleteFiles: data.deleteFiles !== false,
  }
}

function skillUninstallInput(data: Record<string, unknown>) {
  return {
    directory: requiredString(data, "directory"),
    name: requiredString(data, "name"),
    path: optionalString(data, "path"),
  }
}

function hostCommandInput(data: Record<string, unknown>) {
  const argumentsValue = data.arguments
  const envValue = data.env
  return {
    pluginID: requiredString(data, "pluginID"),
    pluginVersion: requiredString(data, "pluginVersion"),
    pluginHash: requiredString(data, "pluginHash"),
    command: requiredString(data, "command"),
    arguments: Array.isArray(argumentsValue)
      ? argumentsValue.filter((item): item is string => typeof item === "string")
      : [],
    directory: optionalString(data, "directory"),
    env: isRecord(envValue)
      ? Object.fromEntries(
          Object.entries(envValue).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        )
      : undefined,
  }
}

function hostImageGenerateInput(data: Record<string, unknown>) {
  return {
    pluginID: requiredString(data, "pluginID"),
    pluginVersion: requiredString(data, "pluginVersion"),
    pluginHash: requiredString(data, "pluginHash"),
    prompt: typeof data.prompt === "string" ? data.prompt : "",
    size: optionalString(data, "size"),
    style: optionalString(data, "style"),
    format: optionalString(data, "format"),
    timeoutSeconds: typeof data.timeoutSeconds === "number" ? data.timeoutSeconds : undefined,
  }
}

// Host commands can be verbose; without a cap a single run could exhaust the
// server's memory. Keep at most 1 MiB per stream and stop the child beyond it.
const HOST_COMMAND_OUTPUT_LIMIT = 1024 * 1024

async function runHostCommand(
  input: { command: string; arguments: string[]; directory?: string; env?: Record<string, string> },
) {
  return new Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string; output: string }>((resolve) => {
    const child = spawn(input.command, input.arguments, {
      cwd: input.directory,
      env: input.env ? { ...process.env, ...input.env } : process.env,
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const sizes = { stdout: 0, stderr: 0 }
    const truncated = new Set<string>()
    const capture = (stream: "stdout" | "stderr", buffers: Buffer[]) => (chunk: Buffer) => {
      const room = HOST_COMMAND_OUTPUT_LIMIT - sizes[stream]
      if (room <= 0) {
        truncated.add(stream)
        child.kill()
        return
      }
      const slice = room >= chunk.length ? chunk : chunk.subarray(0, room)
      buffers.push(slice)
      sizes[stream] += slice.length
      if (sizes[stream] >= HOST_COMMAND_OUTPUT_LIMIT) {
        truncated.add(stream)
        child.kill()
      }
    }
    const result = (exitCode: number, extraError?: string) => {
      const out = Buffer.concat(stdout).toString("utf8")
      const errText = truncated.has("stderr")
        ? `${Buffer.concat(stderr).toString("utf8")}\n[stderr truncated at 1 MiB]`
        : Buffer.concat(stderr).toString("utf8")
      const err = [errText, extraError].filter(Boolean).join("\n")
      resolve({
        ok: exitCode === 0,
        exitCode,
        stdout: truncated.has("stdout") ? `${out}\n[stdout truncated at 1 MiB]` : out,
        stderr: err,
        output: [out, err].filter(Boolean).join("\n"),
      })
    }

    child.stdout.on("data", capture("stdout", stdout))
    child.stderr.on("data", capture("stderr", stderr))
    child.on("error", (error) => result(-1, error.message))
    child.on("close", (code, signal) =>
      result(code ?? -1, signal ? `Process terminated by signal ${signal}` : undefined),
    )
  })
}

function promptImproveInput(data: Record<string, unknown>) {
  return {
    directory: optionalString(data, "directory"),
    prompt: requiredString(data, "prompt"),
    model: optionalString(data, "model"),
    promptTemplate: optionalString(data, "promptTemplate"),
  }
}

function hostAIRunInput(data: Record<string, unknown>) {
  const messages = hostAIMessages(data.messages)
  const prompt = optionalString(data, "prompt")
  // A present chain must normalize to a bounded, valid step snapshot; an absent
  // chain keeps the legacy single-model behavior.
  const chain =
    data.chain === undefined
      ? undefined
      : AIChain.normalizeAIChainSteps(
          typeof data.chain === "object" && data.chain && !Array.isArray(data.chain)
            ? ((data.chain as { steps?: unknown }).steps ?? [])
            : data.chain,
        )
  return {
    pluginID: requiredString(data, "pluginID"),
    pluginVersion: optionalString(data, "pluginVersion"),
    pluginHash: optionalString(data, "pluginHash"),
    directory: optionalString(data, "directory"),
    model: optionalString(data, "model"),
    variant: optionalString(data, "variant"),
    chain,
    system: optionalString(data, "system"),
    generation: hostAIGeneration(data.generation),
    maxRetries: optionalNumber(data, "maxRetries"),
    tools: stringArray(data.tools) ?? [],
    returnAfter: data.returnAfter === "sentence" ? ("sentence" as const) : undefined,
    messages: messages.length ? messages : prompt ? ([{ role: "user", content: prompt }] satisfies ModelMessage[]) : [],
  }
}

function sttMultipart(request: HttpServerRequest.HttpServerRequest) {
  return request.multipartStream.pipe(
    Stream.runFoldEffect(
      () => ({
        fields: {} as Record<string, string>,
        audio: undefined as { bytes: Uint8Array; mimeType: string } | undefined,
      }),
      (form, part) => {
        if (part._tag === "Field") {
          if (Object.keys(form.fields).length >= 10) return Effect.fail(new Error("Too many transcription fields"))
          return Effect.succeed({ ...form, fields: { ...form.fields, [part.key]: part.value } })
        }
        if (part.key !== "audio" || form.audio) return Effect.fail(new Error("Expected exactly one audio file"))
        return part.contentEffect.pipe(
          Effect.flatMap((bytes) =>
            bytes.byteLength > 25 * 1024 * 1024
              ? Effect.fail(new Error("Audio exceeds 25 MiB"))
              : Effect.succeed({ ...form, audio: { bytes, mimeType: part.contentType } }),
          ),
        )
      },
    ),
    Effect.map((form) => ({ ...form, chain: sttChain(form.fields.chain) })),
    Effect.provideService(Multipart.MaxParts, 12),
    Effect.provideService(Multipart.MaxFileSize, 25 * 1024 * 1024),
  )
}

function sttJson(request: HttpServerRequest.HttpServerRequest) {
  return request.json.pipe(
    Effect.map((body) => {
      if (!isRecord(body)) throw new Error("Expected JSON object")
      const encoded = requiredString(body, "audio")
      const bytes = new Uint8Array(Buffer.from(encoded, "base64"))
      if (!bytes.byteLength) throw new Error("Expected audio")
      return {
        fields: {
          pluginID: requiredString(body, "pluginID"),
          pluginVersion: requiredString(body, "pluginVersion"),
          pluginHash: requiredString(body, "pluginHash"),
          model: optionalString(body, "model") ?? "",
          mimeType: requiredString(body, "mimeType"),
          language: optionalString(body, "language") ?? "",
          context: optionalString(body, "context") ?? "",
        },
        audio: { bytes, mimeType: requiredString(body, "mimeType") },
        chain: sttChain(body.chain),
      }
    }),
  )
}

const sttMimeTypes = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
])

function sttString(data: Record<string, string>, key: string, maxLength: number) {
  const value = optionalString(data, key)
  if (value && value.length > maxLength) throw new Error(`${key} exceeds ${maxLength} characters`)
  return value
}

function sttResponse(body: Record<string, unknown>, status = 200) {
  return HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: new Headers({ "cache-control": "no-store" }),
  })
}

// JSON bodies carry the chain snapshot as an object; multipart forms carry it
// as a JSON-encoded field. Both use the shared bounded chain contract.
function sttChain(value: unknown) {
  if (value === undefined) return AIChain.normalizeAIChainSteps(undefined)
  const present = typeof value === "string" ? value.trim() : value
  const raw = typeof present === "string" ? parseCommandJsonOutput(present) : present
  if (typeof present === "string" && raw === undefined) return { error: "chain must be a JSON object with steps" }
  return AIChain.normalizeAIChainSteps(
    raw !== undefined && typeof raw === "object" && !Array.isArray(raw)
      ? ((raw as { steps?: unknown }).steps ?? [])
      : raw,
  )
}

// Unsupported or temporarily unavailable steps may advance. Invalid audio and
// cancellation are request-wide failures and must stop the chain immediately.
const sttChainAdvanceCodes = new Set([
  "unsupported_provider",
  "unsupported_model",
  "missing_credentials",
  "rate_limited",
  "timeout",
  "provider_error",
])

function sttErrorStatus(code: string) {
  return code === "invalid_input" || code === "unsupported_model" || code === "unsupported_provider"
    ? 400
    : code === "missing_credentials"
      ? 409
      : code === "rate_limited"
        ? 429
        : code === "cancelled"
          ? 499
          : code === "timeout"
            ? 504
            : 502
}

function ttsErrorStatus(code: string) {
  if (code === "missing_voice") return 400
  return sttErrorStatus(code)
}

function ttsInput(value: string) {
  const data = jsonObject(value)
  const text = requiredString(data, "text")
  if (text.length > 4_000) throw new Error("text exceeds 4000 characters")
  const model = optionalString(data, "model") ?? ""
  if (model.length > 512) throw new Error("model exceeds 512 characters")
  const voice = optionalString(data, "voice") ?? ""
  if (voice.length > 256) throw new Error("voice exceeds 256 characters")
  const voices = isRecord(data.voices)
    ? Object.fromEntries(
        Object.entries(data.voices).map(([key, item]) => {
          if (key.length > 512 || typeof item !== "string" || !item.trim() || item.length > 256)
            throw new Error("voices must map model ids to voice names")
          return [key, item.trim()]
        }),
      )
    : {}
  const speed = optionalNumber(data, "speed") ?? 1
  if (speed < 0.5 || speed > 2) throw new Error("speed must be between 0.5 and 2")
  if (data.format !== undefined && data.format !== "auto" && data.format !== "pcm" && data.format !== "mp3")
    throw new Error("format must be auto, pcm, or mp3")
  return {
    pluginID: requiredString(data, "pluginID"),
    pluginVersion: requiredString(data, "pluginVersion"),
    pluginHash: requiredString(data, "pluginHash"),
    text,
    model,
    voice,
    voices,
    speed,
    format: data.format === "mp3" ? ("mp3" as const) : data.format === "pcm" ? ("pcm" as const) : undefined,
    chain: sttChain(data.chain),
  }
}

const ttsChainAdvanceCodes = new Set([
  "unsupported_provider",
  "unsupported_model",
  "missing_credentials",
  "missing_voice",
  "rate_limited",
  "timeout",
  "provider_error",
])

function lightweightInstance(directory: string): InstanceContext {
  // Host routes receive the app's "global" sentinel. Keep every plugin-facing
  // scope absolute so media adapter registration and lookup share one key.
  const scope = absolutePluginDirectory(directory)
  return {
    directory: scope,
    worktree: scope,
    project: {
      id: ProjectV2.ID.make("global"),
      worktree: scope,
      time: { created: 0, updated: 0 },
      sandboxes: [],
    },
  }
}

function hostAIMessages(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): ModelMessage[] => {
    if (!isRecord(item)) return []
    if (item.role !== "user" && item.role !== "assistant" && item.role !== "system") return []
    if (typeof item.content !== "string") return []
    return [{ role: item.role, content: item.content }]
  })
}

function commandFormActionResult(result: Awaited<ReturnType<typeof runHostCommand>>) {
  const parsed = parseCommandJsonOutput(result.stdout)
  return parsed ? { ...result, json: parsed } : result
}

function parseCommandJsonOutput(stdout: string) {
  const text = stdout.trim()
  if (!text) return undefined
  try {
    const parsed = JSON.parse(text) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function hostAIGeneration(value: unknown): ModelRequest.Generation | undefined {
  if (!isRecord(value)) return
  return {
    maxTokens: optionalNumber(value, "maxTokens"),
    temperature: optionalNumber(value, "temperature"),
    topP: optionalNumber(value, "topP"),
    topK: optionalNumber(value, "topK"),
    frequencyPenalty: optionalNumber(value, "frequencyPenalty"),
    presencePenalty: optionalNumber(value, "presencePenalty"),
    seed: optionalNumber(value, "seed"),
    stop: stringArray(value.stop),
  }
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
}

const defaultPromptImproveTemplate = [
  "Rewrite the user's draft prompt for an AI coding assistant.",
  "Return only the improved prompt text, with no preamble, no markdown fence, and no surrounding quotes.",
  "Keep the user's intent, language, constraints, and concrete details. Make it clearer, more specific, and actionable.",
  "Do not add requirements the user did not imply.",
  "",
  "Draft prompt:",
  "{prompt}",
].join("\n")

function promptImproveUserPrompt(prompt: string, template?: string) {
  const normalized = normalizePromptImproveTemplate(template)
  if (normalized.includes("{prompt}")) return normalized.replaceAll("{prompt}", prompt)
  return [normalized, "", "Draft prompt:", prompt].join("\n")
}

function normalizePromptImproveTemplate(value: string | undefined) {
  const template = value?.trim() ?? ""
  return template || defaultPromptImproveTemplate
}

function cleanImprovedPrompt(text: string) {
  const trimmed = unwrapMarkdownFence(text.trim())
  const prompt = stripPromptLabel(promptFromJson(trimmed) ?? trimmed)
  if ((prompt.startsWith('"') && prompt.endsWith('"')) || (prompt.startsWith("'") && prompt.endsWith("'"))) {
    return decodeQuotedPrompt(prompt).trim()
  }
  return prompt
}

function unwrapMarkdownFence(text: string) {
  const fenced = text.match(/^```(?:[\w-]+)?\s*([\s\S]*?)\s*```$/)
  return (fenced?.[1] ?? text).trim()
}

function promptFromJson(text: string) {
  if (!/^(?:\{|\[|")/.test(text)) return
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed === "string") return parsed.trim()
    if (Array.isArray(parsed)) return typeof parsed[0] === "string" && parsed[0].trim() ? parsed[0].trim() : undefined
    if (!isRecord(parsed)) return
    for (const key of [
      "prompt",
      "text",
      "improvedPrompt",
      "improved_prompt",
      "rewrittenPrompt",
      "rewritten_prompt",
      "content",
      "result",
      "output",
    ]) {
      if (typeof parsed[key] === "string" && parsed[key].trim()) return parsed[key].trim()
    }
  } catch {
    return
  }
}

function stripPromptLabel(text: string) {
  const stripped = text
    .replace(/^\s*(?:here(?:'s| is)\s+)?(?:the\s+)?(?:improved|rewritten|revised)\s+prompt\s*:\s*/i, "")
    .trim()
  if (stripped !== text.trim()) return stripped
  return (
    text.match(
      /(?:^|\n)\s*(?:here(?:'s| is)\s+)?(?:the\s+)?(?:improved|rewritten|revised)\s+prompt\s*:\s*([\s\S]*)$/i,
    )?.[1] ?? text
  ).trim()
}

function decodeQuotedPrompt(text: string) {
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (typeof parsed === "string") return parsed
    } catch {
      return decodeCommonEscapes(text.slice(1, -1))
    }
  }
  return decodeCommonEscapes(text.slice(1, -1))
}

function decodeCommonEscapes(text: string) {
  return text.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
}

function promptImproveMessage(cause: Cause.Cause<unknown>, modelRef?: string): string {
  const detail = Cause.pretty(cause).split("\n", 1)[0]?.trim() || "Prompt rewrite failed"
  return modelRef ? `${modelRef}: ${detail}` : detail
}

function installStatus(result: { ok: boolean; code?: string }) {
  if (result.ok) return 200
  if (result.code === "target_exists") return 409
  if (result.code === "invalid_source") return 400
  return 500
}

function optionalNumber(data: Record<string, unknown>, key: string) {
  const value = data[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function storageSettingsStatus(
  snapshot: StorageMaintenance.Snapshot,
  archiveMaintenance: SessionArchiveMaintenance.Status,
  cleanupSettings: StorageCleanup.Settings,
  cleanupStatus: StorageCleanup.Status,
) {
  const migration = snapshot.manifests
    .filter((manifest) => manifest.kind === "migration" || manifest.kind === "content")
    .sort((left, right) => manifestTimestamp(right) - manifestTimestamp(left))[0]
  return {
    activeDatabase: { bytes: snapshot.activeDatabase.bytes, path: snapshot.activeDatabase.path },
    archives: { bytes: snapshot.archives.bytes, path: snapshot.archives.path, shards: snapshot.archives.files },
    blobStore: { bytes: snapshot.blobs.bytes, path: snapshot.blobs.path, blobs: snapshot.blobs.files },
    localDatabase: { bytes: snapshot.localDatabase.bytes, path: snapshot.localDatabase.path },
    snapshots: snapshot.snapshots,
    compactionBackups: snapshot.compactionBackups,
    backups: snapshot.backups.items.map((backup) => ({
      id: backup.id,
      path: backup.path,
      bytes: backup.bytes,
      modifiedAt: backup.modifiedAt,
      retireAfter: backup.retireAfter,
      retirementEligible: backup.retirementEligible,
    })),
    sessions: {
      active: snapshot.activeDatabase.sessions ?? 0,
      archived: snapshot.archives.sessions,
    },
    retention: {
      enabled: archiveMaintenance.retention.enabled,
      inactivityDays: Math.max(1, Math.round(archiveMaintenance.retention.inactivityMs / (24 * 60 * 60 * 1_000))),
      defaultInactivityDays: SessionArchiveMaintenance.DEFAULT_RETENTION_DAYS,
    },
    cleanup: {
      settings: cleanupSettings,
      status: cleanupStatus,
    },
    deduplication: {
      attachments: snapshot.attachments.references,
      uniqueBlobs: snapshot.attachments.uniqueBlobs,
      savedBytes: snapshot.attachments.savedBytes,
    },
    manifest: !migration
      ? { state: "missing" as const }
      : !migration.valid
        ? { state: "invalid" as const, message: migration.error }
        : {
            state:
              migration.status === "complete" || migration.status === "completed" || migration.status === "ready"
                ? ("ready" as const)
                : ("migrating" as const),
            updatedAt: migration.updatedAt,
            message: migration.message ?? migration.phase,
          },
    maintenance: {
      state:
        archiveMaintenance.lastError || archiveMaintenance.candidateFailures.length > 0
          ? ("failed" as const)
          : archiveMaintenance.phase === "running"
            ? ("running" as const)
            : archiveMaintenance.schedulerActive
              ? ("idle" as const)
              : ("paused" as const),
      operation: archiveMaintenance.phase,
      completed: archiveMaintenance.archived,
      total: archiveMaintenance.runs,
      message: archiveMaintenance.lastError ?? archiveMaintenanceResult(archiveMaintenance.lastResult),
      schedulerActive: archiveMaintenance.schedulerActive,
      runs: archiveMaintenance.runs,
      archived: archiveMaintenance.archived,
      purged: archiveMaintenance.purged,
      idle: archiveMaintenance.idle,
      deferred: archiveMaintenance.deferred,
      failed: archiveMaintenance.failed,
      candidateFailures: archiveMaintenance.candidateFailures,
      backlog: archiveMaintenance.backlog,
      oldestEligibleAt: archiveMaintenance.oldestEligibleAt,
      deferredReason: archiveMaintenance.deferredReason,
      lastStartedAt: archiveMaintenance.lastStartedAt,
      lastFinishedAt: archiveMaintenance.lastFinishedAt,
      lastSucceededAt: archiveMaintenance.lastSucceededAt,
      lastFailedAt: archiveMaintenance.lastFailedAt,
      nextRunAt: archiveMaintenance.nextRunAt,
      lastFailure: archiveMaintenance.lastFailure,
    },
  }
}

function configuredSessionRetention(config: unknown) {
  const session = isRecord(config) && isRecord(config.session) ? config.session : undefined
  const retention = session && isRecord(session.retention) ? session.retention : undefined
  const inactivityDays = retention?.inactivity_days
  return SessionArchiveMaintenance.retentionFromDays(
    retention?.enabled === true,
    typeof inactivityDays === "number" ? inactivityDays : SessionArchiveMaintenance.DEFAULT_RETENTION_DAYS,
  )
}

function configuredStorageCleanup(config: { readonly storage_cleanup?: ConfigStorageCleanup.Info }) {
  return ConfigStorageCleanup.resolve(config.storage_cleanup)
}

export function runAutomaticStorageCleanup(
  cleanup: Pick<StorageCleanup.Interface, "runIfDue">,
  settings: StorageCleanup.Settings,
) {
  return Effect.promise(() => cleanup.runIfDue(settings)).pipe(
    Effect.tap((result) =>
      result.outcome === "completed"
        ? Effect.logInfo("automatic storage cleanup completed", {
            deletedArtifacts: result.deleted.length,
            deletedBytes: result.deletedBytes,
            skipped: result.skipped.length,
          })
        : Effect.void,
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("automatic storage cleanup failed without blocking startup", { cause: Cause.pretty(cause) }),
    ),
  )
}

function archiveMaintenanceResult(result?: SessionArchiveMaintenance.RunResult) {
  if (!result) return
  if (result.outcome === "archived") {
    const message = `Archived ${result.archives.length} ${result.archives.length === 1 ? "session" : "sessions"}`
    if (!result.deferredReason) return message
    return `${message}; ${archiveMaintenanceDeferral(result.deferredReason)}`
  }
  if (result.outcome === "deferred") return archiveMaintenanceDeferral(result.deferredReason)
  return "No eligible session was found"
}

function archiveMaintenanceDeferral(reason: SessionArchiveMaintenance.DeferredReason) {
  if (reason === "batch-limit") return "remaining work was deferred by the batch limit"
  if (reason === "time-budget") return "remaining work was deferred by the time budget"
  if (reason === "candidate-failed") return "one or more eligible sessions are in failure backoff"
  return "all eligible sessions were busy"
}

function manifestTimestamp(manifest: StorageMaintenance.ManifestStatus) {
  if (typeof manifest.updatedAt === "number") return manifest.updatedAt
  if (typeof manifest.updatedAt === "string") return Date.parse(manifest.updatedAt) || 0
  return 0
}

function storageIntegritySummary(result: StorageMaintenance.IntegrityDryRun) {
  const unhealthyDatabases = result.databases.filter((database) => !database.ok).length
  return [
    `${result.databases.length - unhealthyDatabases}/${result.databases.length} databases healthy`,
    `${result.blobs.checked} blobs checked`,
    `${result.blobs.missing} missing`,
    `${result.blobs.sizeMismatch} size mismatches`,
    `${result.blobs.hashMismatch} hash mismatches`,
    `${result.blobs.unsafePath} unsafe paths`,
  ].join(", ")
}

function storageRetirementConfirmation(backup: StorageMaintenance.BackupSummary) {
  return `RETIRE ${backup.id} ${backup.bytes} ${backup.modifiedAt}`
}

const appPluginAssetRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.addGlobalMiddleware(mutationOriginGuard)
    const headlessAI = yield* HeadlessAI.Service
    const auth = yield* Auth.Service
    const provider = yield* Provider.Service
    const plugins = yield* Plugin.Service
    const instanceStore = yield* InstanceStore.Service
    const locations = yield* LocationServiceMap
    const database = yield* Database.Service
    const contentStore = yield* ContentStore.Service
    const sessionArchive = yield* SessionArchive.Service
    const archiveMaintenance = yield* SessionArchiveMaintenance.Service
    const config = yield* Config.Service
    const globalConfig = yield* config.getGlobal()
    yield* archiveMaintenance.configureRetention(configuredSessionRetention(globalConfig))
    yield* archiveMaintenance.start
    const storageMaintenance = StorageMaintenance.make({ data: Global.Path.data })
    const storageMigration = StorageMigrationRuntime.make({ data: Global.Path.data })
    const effectFlock = yield* EffectFlock.Service
    const storageCleanup = StorageCleanup.make({
      data: Global.Path.data,
      state: Global.Path.state,
      locks: StorageCleanup.lockManager(effectFlock, join(Global.Path.state, "locks")),
    })
    yield* runAutomaticStorageCleanup(storageCleanup, configuredStorageCleanup(globalConfig)).pipe(Effect.forkScoped)
    const useQuestions = <A, E, R>(
      directory: string,
      use: (question: QuestionV2.Interface) => Effect.Effect<A, E, R>,
    ) =>
      QuestionV2.Service.use(use).pipe(
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
      )

    yield* router.add("GET", "/app/plugins", (request) =>
      Effect.promise(async () => {
        const url = new URL(request.url, "http://localhost")
        const directory = url.searchParams.get("directory") ?? undefined
        return HttpServerResponse.jsonUnsafe(await AppPluginAssets.clientManifest(directory), {
          headers: new Headers({ "cache-control": "no-store" }),
        })
      }),
    )
    yield* router.add("GET", "/app/storage/status", () =>
      Effect.gen(function* () {
        const settings = configuredStorageCleanup(yield* config.getGlobal())
        const [snapshot, status, cleanupStatus] = yield* Effect.all([
          storageMaintenance.snapshot(),
          archiveMaintenance.status,
          Effect.promise(() => storageCleanup.status(settings)),
        ])
        return HttpServerResponse.jsonUnsafe(storageSettingsStatus(snapshot, status, settings, cleanupStatus), {
          headers: new Headers({ "cache-control": "no-store" }),
        })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("storage status inspection failed", { cause: Cause.pretty(cause) }).pipe(
            Effect.as(
              HttpServerResponse.jsonUnsafe({ error: "Storage status could not be inspected" }, { status: 500 }),
            ),
          ),
        ),
      ),
    )
    yield* router.add("GET", "/app/storage/cleanup/preview", () =>
      Effect.gen(function* () {
        const settings = configuredStorageCleanup(yield* config.getGlobal())
        const inventory = yield* Effect.promise(() => storageCleanup.preview(settings))
        return HttpServerResponse.jsonUnsafe(inventory, { headers: new Headers({ "cache-control": "no-store" }) })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("storage cleanup preview failed", { cause: Cause.pretty(cause) }).pipe(
            Effect.as(HttpServerResponse.jsonUnsafe({ error: "Storage cleanup preview failed" }, { status: 500 })),
          ),
        ),
      ),
    )
    yield* router.add("PATCH", "/app/storage/cleanup/config", (request) =>
      Effect.gen(function* () {
        const input = jsonObject(yield* Effect.orDie(request.text))
        const enabled = input.enabled
        const snapshotRetentionDays = input.snapshotRetentionDays
        const compactionBackupRetentionDays = input.compactionBackupRetentionDays
        const snapshotMaxBytes = input.snapshotMaxBytes
        const checkIntervalHours = input.checkIntervalHours
        const positiveInteger = (value: unknown): value is number =>
          typeof value === "number" && Number.isSafeInteger(value) && value > 0
        if (
          typeof enabled !== "boolean" ||
          !positiveInteger(snapshotRetentionDays) ||
          !positiveInteger(compactionBackupRetentionDays) ||
          !positiveInteger(snapshotMaxBytes) ||
          !positiveInteger(checkIntervalHours) ||
          checkIntervalHours < ConfigStorageCleanup.MIN_CHECK_INTERVAL_HOURS
        )
          return HttpServerResponse.jsonUnsafe(
            { error: "Expected enabled, positive whole-number cleanup limits, and checkIntervalHours of at least 24" },
            { status: 400 },
          )
        yield* config.updateGlobal({
          storage_cleanup: {
            enabled,
            snapshot_retention_days: snapshotRetentionDays,
            compaction_backup_retention_days: compactionBackupRetentionDays,
            snapshot_max_bytes: snapshotMaxBytes,
            check_interval_hours: checkIntervalHours,
          },
        })
        storageCleanup.invalidatePreview()
        const settings: StorageCleanup.Settings = {
          enabled,
          snapshotRetentionDays,
          compactionBackupRetentionDays,
          snapshotMaxBytes,
          checkIntervalHours,
        }
        return HttpServerResponse.jsonUnsafe(
          { settings, status: yield* Effect.promise(() => storageCleanup.status(settings)) },
          { headers: new Headers({ "cache-control": "no-store" }) },
        )
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("storage cleanup configuration failed", { cause: Cause.pretty(cause) }).pipe(
            Effect.as(
              HttpServerResponse.jsonUnsafe({ error: "Storage cleanup configuration failed" }, { status: 500 }),
            ),
          ),
        ),
      ),
    )
    yield* router.add("POST", "/app/storage/cleanup/run", (request) =>
      Effect.gen(function* () {
        const text = yield* Effect.orDie(request.text)
        const input = (() => {
          try {
            return jsonObject(text)
          } catch {
            return undefined
          }
        })()
        const previewToken = input?.previewToken
        if (typeof previewToken !== "string" || !previewToken.trim())
          return HttpServerResponse.jsonUnsafe(
            { error: "Preview cleanup with the current settings before permanently deleting artifacts" },
            { status: 409 },
          )
        const settings = configuredStorageCleanup(yield* config.getGlobal())
        const attempted = yield* Effect.promise(async () => {
          try {
            return { ok: true as const, result: await storageCleanup.runNow(settings, previewToken) }
          } catch (error) {
            return { ok: false as const, error }
          }
        })
        if (!attempted.ok) {
          if (attempted.error instanceof StorageCleanup.PreviewRequiredError)
            return HttpServerResponse.jsonUnsafe({ error: attempted.error.message }, { status: 409 })
          return yield* Effect.fail(attempted.error)
        }
        return HttpServerResponse.jsonUnsafe(attempted.result, {
          headers: new Headers({ "cache-control": "no-store" }),
        })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("manual storage cleanup failed", { cause: Cause.pretty(cause) }).pipe(
            Effect.as(HttpServerResponse.jsonUnsafe({ error: "Storage cleanup failed" }, { status: 500 })),
          ),
        ),
      ),
    )
    yield* router.add("PATCH", "/app/storage/retention", (request) =>
      Effect.gen(function* () {
        const input = jsonObject(yield* Effect.orDie(request.text))
        const enabled = input.enabled
        const inactivityDays = input.inactivityDays
        if (
          typeof enabled !== "boolean" ||
          typeof inactivityDays !== "number" ||
          !Number.isInteger(inactivityDays) ||
          inactivityDays < 1 ||
          inactivityDays > SessionArchiveMaintenance.MAX_RETENTION_DAYS
        )
          return HttpServerResponse.jsonUnsafe(
            { error: "Expected enabled and inactivityDays between 1 and 3650" },
            { status: 400 },
          )
        yield* config.updateGlobal({
          session: { retention: { enabled, inactivity_days: inactivityDays } },
        })
        const retention = yield* archiveMaintenance.configureRetention(
          SessionArchiveMaintenance.retentionFromDays(enabled, inactivityDays),
        )
        return HttpServerResponse.jsonUnsafe(
          {
            enabled: retention.enabled,
            inactivityDays: Math.round(retention.inactivityMs / (24 * 60 * 60 * 1_000)),
            defaultInactivityDays: SessionArchiveMaintenance.DEFAULT_RETENTION_DAYS,
          },
          { headers: new Headers({ "cache-control": "no-store" }) },
        )
      }),
    )
    yield* router.add("POST", "/app/storage/integrity", (request) =>
      Effect.gen(function* () {
        const input = jsonObject(yield* Effect.orDie(request.text))
        const mode = optionalString(input, "mode")
        if ((mode !== "quick" && mode !== "full") || input.dryRun !== true)
          return HttpServerResponse.jsonUnsafe({ error: "Expected a quick or full dry-run" }, { status: 400 })
        const result = yield* storageMaintenance.runIntegrityDryRun({ level: mode })
        return HttpServerResponse.jsonUnsafe({
          id: `integrity-${randomUUID()}`,
          mode,
          state: result.healthy ? "completed" : "failed",
          message: storageIntegritySummary(result),
        })
      }).pipe(
        Effect.catchTag("StorageMaintenance.Error", () =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe({ error: "Storage integrity could not be inspected" }, { status: 500 }),
          ),
        ),
      ),
    )
    yield* router.add("GET", "/app/storage/migration/status", (request) =>
      Effect.gen(function* () {
        const database = new URL(request.url, "http://localhost").searchParams.get("database") ?? "production"
        if (database !== "production" && database !== "local")
          return HttpServerResponse.jsonUnsafe({ error: "Expected production or local database" }, { status: 400 })
        const status = yield* Effect.tryPromise({
          try: () => storageMigration.status(database),
          catch: (cause) => (cause instanceof Error ? cause : new Error("Storage migration status could not be read")),
        })
        return HttpServerResponse.jsonUnsafe(status, { headers: new Headers({ "cache-control": "no-store" }) })
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 500 })),
        ),
      ),
    )
    yield* router.add("POST", "/app/storage/migration/dry-run", (request) =>
      Effect.gen(function* () {
        const input = jsonObject(yield* Effect.orDie(request.text))
        const snapshotDirectory = optionalString(input, "snapshotDirectory")
        const database = optionalString(input, "databaseKind") ?? "production"
        if (database !== "production" && database !== "local")
          return HttpServerResponse.jsonUnsafe({ error: "Expected production or local database" }, { status: 400 })
        const status = yield* Effect.tryPromise({
          try: () =>
            storageMigration.startDryRun({
              databaseKind: database,
              ...(snapshotDirectory ? { snapshotDirectory } : {}),
            }),
          catch: (cause) =>
            cause instanceof Error ? cause : new Error("Storage migration dry-run could not be started"),
        })
        return HttpServerResponse.jsonUnsafe(status, { headers: new Headers({ "cache-control": "no-store" }) })
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 409 })),
        ),
      ),
    )
    yield* router.add("POST", "/app/storage/backups/retire", (request) =>
      Effect.gen(function* () {
        const input = jsonObject(yield* Effect.orDie(request.text))
        const id = optionalString(input, "id")
        const confirmation = optionalString(input, "confirmation")
        const reviewed = isRecord(input.reviewed) ? input.reviewed : undefined
        const bytes = reviewed && typeof reviewed.bytes === "number" ? reviewed.bytes : undefined
        const modifiedAt = reviewed && typeof reviewed.modifiedAt === "number" ? reviewed.modifiedAt : undefined
        if (!id || confirmation === undefined || bytes === undefined || modifiedAt === undefined)
          return HttpServerResponse.jsonUnsafe(
            { error: "Expected reviewed backup metadata and confirmation" },
            { status: 400 },
          )
        const snapshot = yield* storageMaintenance.snapshot()
        const backup = snapshot.backups.items.find((item) => item.id === id)
        if (!backup)
          return HttpServerResponse.jsonUnsafe({ error: "Reviewed backup is no longer available" }, { status: 404 })
        if (backup.bytes !== bytes || backup.modifiedAt !== modifiedAt)
          return HttpServerResponse.jsonUnsafe({ error: "Backup changed after review" }, { status: 409 })
        if (confirmation !== storageRetirementConfirmation(backup))
          return HttpServerResponse.jsonUnsafe(
            { error: "Backup retirement was not explicitly confirmed" },
            { status: 400 },
          )
        yield* storageMaintenance.retireBackup({
          path: backup.path,
          confirmation: StorageMaintenance.retirementConfirmation(backup.path),
          expectedBytes: backup.bytes,
          expectedModifiedAt: backup.modifiedAt,
        })
        return HttpServerResponse.empty({ status: 204 })
      }).pipe(
        Effect.catchTag("StorageMaintenance.Error", () =>
          Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "Backup retirement failed safely" }, { status: 409 })),
        ),
      ),
    )
    yield* router.add("POST", "/app/host/command", (request) =>
      Effect.gen(function* () {
        const input = hostCommandInput(jsonRequestBody(yield* Effect.orDie(request.text), request.headers["content-type"]))
        const policy = yield* Effect.promise(() =>
          AppPluginAssets.hostPolicy(input.pluginID, input.pluginVersion, input.pluginHash),
        )
        if (!policy) return HttpServerResponse.jsonUnsafe({ ok: false, error: "Unknown app plugin" }, { status: 404 })
        if (!policy.capabilities.includes("host:command"))
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Missing host:command capability" }, { status: 403 })
        const result = yield* Effect.promise(() => runHostCommand(input))
        return HttpServerResponse.jsonUnsafe(result, { status: result.ok ? 200 : 500 })
      }),
    )
    yield* router.add("GET", "/app/gmail/recipients", (request) =>
      Effect.gen(function* () {
        const url = new URL(request.url, "http://localhost")
        const input = gmailRecipientsInput(url)
        const instance = yield* instanceStore.load({ directory: input.directory })
        return yield* Effect.gen(function* () {
          const requests = yield* useQuestions(input.directory, (surface) => surface.list())
          const tools = yield* useQuestions(input.directory, (surface) => surface.listPersistentTools(true))
          const problem = gmailRecipientsProblem(requests, input, tools)
          if (problem)
            return HttpServerResponse.jsonUnsafe({ ok: false, error: problem, suggestions: [] }, { status: 400 })
          const suggestions = yield* Effect.promise(() =>
            suggestGmailRecipients({
              query: input.query,
              refresh: input.refresh,
            }),
          )
          return HttpServerResponse.jsonUnsafe(
            {
              ok: true,
              suggestions,
            },
            { headers: new Headers({ "cache-control": "no-store" }) },
          )
        }).pipe(Effect.provideService(InstanceRef, instance))
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const message = Cause.pretty(cause).split("\n", 1)[0]?.trim() || "Gmail recipient lookup failed"
            yield* Effect.logError("gmail recipient lookup failed", { error: message, cause: Cause.pretty(cause) })
            return HttpServerResponse.jsonUnsafe({ ok: false, error: message, suggestions: [] }, { status: 500 })
          }),
        ),
      ),
    )
    yield* router.add("GET", "/app/media", (request) =>
      Effect.promise(async () => {
        const url = new URL(request.url, "http://localhost")
        const file = localMediaPath(url, request.headers)
        if (!file)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Expected local media path" }, { status: 400 })
        const contentType = localMediaType(file)
        if (!contentType)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Unsupported media type" }, { status: 415 })
        if (
          !(await stat(file)
            .then((item) => item.isFile())
            .catch(() => false))
        )
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Media file not found" }, { status: 404 })
        return HttpServerResponse.raw(new Uint8Array(await readFile(file)), {
          headers: new Headers({
            "cache-control": "no-store",
            "content-security-policy": "default-src 'none'; sandbox",
            "content-type": contentType,
            "x-content-type-options": "nosniff",
          }),
        })
      }),
    )
    yield* router.add("GET", "/app/attachment/preview/*", (request) =>
      Effect.gen(function* () {
        const url = new URL(request.url, "http://localhost")
        const id = url.pathname.split("/").filter(Boolean)[3]
        const sessionID = url.searchParams.get("sessionID")
        if (!id || !sessionID)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Expected attachment and session" }, { status: 400 })
        const artifact = yield* locateSessionAttachment({
          attachmentID: decodeURIComponent(id),
          sessionID,
          content: contentStore,
          archive: sessionArchive,
        })
        if (!artifact)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Attachment not found" }, { status: 404 })
        const preview = yield* Effect.tryPromise({
          try: () => AttachmentPreview.create(artifact),
          catch: (cause) => new Error(`Attachment preview failed: ${String(cause)}`),
        })
        const headers = new Headers({
          "accept-ranges": "none",
          "cache-control": "private, max-age=31536000, immutable",
          "content-disposition": ProofAttachment.contentDisposition(artifact.name ?? "attachment"),
          "content-length": String(preview.bytes.byteLength),
          "content-security-policy": "default-src 'none'; sandbox",
          "content-type": preview.mime,
          "x-content-type-options": "nosniff",
          "x-opencode-attachment-mime": artifact.mime,
          "x-opencode-attachment-size": String(artifact.sizeBytes),
          "x-opencode-preview-representation": preview.representation,
          "x-opencode-preview-truncated": String(preview.truncated),
        })
        if (preview.representation === "prefix")
          headers.set(
            "x-opencode-preview-source-range",
            `bytes 0-${preview.bytes.byteLength - 1}/${artifact.sizeBytes}`,
          )
        return HttpServerResponse.raw(preview.bytes, {
          status: 200,
          headers,
        })
      }).pipe(
        Effect.catchCause((cause) => {
          const message = Cause.pretty(cause).split("\n", 1)[0]?.trim() || "Attachment preview failed"
          return Effect.succeed(HttpServerResponse.jsonUnsafe({ ok: false, error: message }, { status: 500 }))
        }),
      ),
    )
    yield* router.add("GET", "/app/attachment/content/*", (request) =>
      Effect.gen(function* () {
        const url = new URL(request.url, "http://localhost")
        const id = url.pathname.split("/").filter(Boolean)[3]
        const sessionID = url.searchParams.get("sessionID")
        if (!id || !sessionID)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Expected attachment and session" }, { status: 400 })
        const artifact = yield* locateSessionAttachment({
          attachmentID: decodeURIComponent(id),
          sessionID,
          content: contentStore,
          archive: sessionArchive,
        })
        if (!artifact)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Attachment not found" }, { status: 404 })
        const range = ProofAttachment.rangeFromHeader(request.headers.range, artifact.sizeBytes)
        if (range === "invalid")
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: "Invalid range" },
            {
              status: 416,
              headers: {
                "accept-ranges": "bytes",
                "content-range": `bytes */${artifact.sizeBytes}`,
              },
            },
          )
        const headers = new Headers({
          "accept-ranges": "bytes",
          "cache-control": "private, max-age=31536000, immutable",
          "content-disposition": ProofAttachment.contentDisposition(artifact.name ?? "attachment"),
          "content-security-policy": "default-src 'none'; sandbox",
          "content-type": artifact.mime,
          "x-content-type-options": "nosniff",
        })
        headers.set("content-length", String(range ? range.end - range.start + 1 : artifact.sizeBytes))
        if (range) headers.set("content-range", `bytes ${range.start}-${range.end}/${artifact.sizeBytes}`)
        return HttpServerResponse.stream(
          Stream.fromReadableStream({
            evaluate: () => ProofAttachment.readStream(artifact.path, range),
            onError: (cause) => new Error(`Attachment stream failed: ${String(cause)}`),
          }),
          { status: range ? 206 : 200, headers },
        )
      }).pipe(
        Effect.catchTag("ContentStore.StorageError", (error) =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { ok: false, error: `Attachment ${error.operation} failed` },
              { status: 500 },
            ),
          ),
        ),
        Effect.catchTag("SessionArchive.IntegrityError", (error) =>
          Effect.succeed(HttpServerResponse.jsonUnsafe({ ok: false, error: error.message }, { status: 500 })),
        ),
      ),
    )
    yield* router.add("GET", "/app/attachment/proof/*", (request) =>
      Effect.promise(async () => {
        const artifact = await ProofAttachment.readRequest(new URL(request.url, "http://localhost").pathname)
        if (!artifact)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Proof attachment not found" }, { status: 404 })
        const range = ProofAttachment.rangeFromHeader(request.headers.range, artifact.sizeBytes)
        if (range === "invalid")
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: "Invalid range" },
            {
              status: 416,
              headers: {
                "accept-ranges": "bytes",
                "content-range": `bytes */${artifact.sizeBytes}`,
              },
            },
          )
        const headers = new Headers({
          "accept-ranges": "bytes",
          "cache-control": "no-store",
          "content-disposition": ProofAttachment.contentDisposition(artifact.filename),
          "content-security-policy": "default-src 'none'; sandbox",
          "content-type": artifact.mime,
          "x-content-type-options": "nosniff",
        })
        headers.set("content-length", String(range ? range.end - range.start + 1 : artifact.sizeBytes))
        if (range) headers.set("content-range", `bytes ${range.start}-${range.end}/${artifact.sizeBytes}`)
        return HttpServerResponse.stream(
          Stream.fromReadableStream({
            evaluate: () => ProofAttachment.readStream(artifact.path, range),
            onError: (cause) => new Error(`Proof attachment stream failed: ${String(cause)}`),
          }),
          { status: range ? 206 : 200, headers },
        )
      }),
    )
    yield* router.add("POST", "/app/surface-attachment", (request) =>
      Effect.gen(function* () {
        const url = new URL(request.url, "http://localhost")
        const directory = url.searchParams.get("directory") ?? request.headers["x-opencode-directory"]
        if (!directory)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Expected directory" }, { status: 400 })
        const targetKind = url.searchParams.get("targetKind") === "tool" ? "tool" : "request"
        const targetID = url.searchParams.get("targetID")?.trim()
        if (!targetID) return HttpServerResponse.jsonUnsafe({ ok: false, error: "Expected targetID" }, { status: 400 })
        const available = yield* useQuestions(directory, (surface) =>
          targetKind === "request"
            ? questionPending(surface, targetID)
            : surface
                .listPersistentTools(true)
                .pipe(Effect.map((tools) => tools.some((tool) => String(tool.id) === targetID))),
        )
        if (!available)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Surface target not found" }, { status: 404 })
        const mime = questionAttachmentMime(
          request.headers["content-type"] ?? url.searchParams.get("mime") ?? undefined,
        )
        const extension = mime ? questionAttachmentTypes.get(mime) : undefined
        if (!mime || !extension)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Unsupported attachment type" }, { status: 415 })
        const contentLength = Number(request.headers["content-length"] ?? 0)
        if (Number.isFinite(contentLength) && contentLength > questionAttachmentLimit)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Attachment is too large" }, { status: 413 })
        const body = yield* questionAttachmentBody(request.stream).pipe(Effect.orDie)
        if (body.tooLarge)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Attachment is too large" }, { status: 413 })
        if (body.bytes.byteLength === 0)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Attachment is empty" }, { status: 400 })
        const dir = questionAttachmentDirectory(directory)
        yield* Effect.promise(() => mkdir(dir, { recursive: true }))
        const filename = questionAttachmentFilename(url.searchParams.get("filename") ?? undefined, extension)
        const target = join(dir, `${Date.now()}-${randomUUID()}-${filename}`)
        yield* Effect.promise(() => writeFile(target, body.bytes))
        return HttpServerResponse.jsonUnsafe(
          { ok: true, file: { type: "file", mime, url: pathToFileURL(target).href, path: target, filename } },
          { headers: new Headers({ "cache-control": "no-store" }) },
        )
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const message = Cause.pretty(cause).split("\n", 1)[0]?.trim() || "Attachment upload failed"
            yield* Effect.logError("question attachment upload failed", { error: message, cause: Cause.pretty(cause) })
            return HttpServerResponse.jsonUnsafe({ ok: false, error: message }, { status: 500 })
          }),
        ),
      ),
    )
    yield* router.add("POST", "/app/form-action", (request) =>
      Effect.gen(function* () {
        const input = formActionInput(jsonObject(yield* Effect.orDie(request.text)))
        const instance = yield* instanceStore.load({ directory: input.directory })

        return yield* Effect.gen(function* () {
          // Authorized result replay: a retry of the exact same invocation id
          // (double click, lost response, submit after the popup already
          // closed) returns the stored outcome instead of executing again.
          const storedInvocation = yield* useQuestions(input.directory, (surface) => surface.getActionInvocation(input.invocationID)).pipe(
            Effect.option,
          )
          if (Option.isSome(storedInvocation)) {
            const stored = storedInvocation.value
            if (
              stored.payloadHash === QuestionV2.actionInvocationPayloadHash({
                id: input.invocationID,
                target: input.target,
                actionID: input.action.id,
                source: input.action.source,
                values: input.values,
              }) &&
              stored.target.kind === input.target.kind &&
              stored.target.id === input.target.id
            ) {
              if (stored.state === "completed")
                return HttpServerResponse.jsonUnsafe(stored.result ?? { ok: true }, {
                  headers: new Headers({ "cache-control": "no-store" }),
                })
              if (stored.state === "failed")
                return HttpServerResponse.jsonUnsafe(
                  {
                    ok: false,
                    error: stored.error ?? "Form action failed",
                    retry: "reconcile",
                    errorClass: stored.errorClass,
                  },
                  { status: 500 },
                )
              if (stored.effectStartedAt)
                return HttpServerResponse.jsonUnsafe(
                  { ok: false, error: "Form action is already executing", retry: "reconcile" },
                  { status: 409 },
                )
            }
          }

          const requests = yield* useQuestions(input.directory, (question) => question.list())
          const tools = yield* useQuestions(input.directory, (surface) => surface.listPersistentTools(true))
          const action = formActionForInput(requests, input, tools)
          const problem = formActionProblem(requests, input, action, tools)
          if (problem)
            return HttpServerResponse.jsonUnsafe(
              { ok: false, error: problem, retry: formActionProblemRetry(problem) },
              { status: 400 },
            )
          const managerStep = hostFormActionStep(action!.steps)
          if (managerStep?.type === "mail_manager") {
            if (input.formID !== "email-manager.v1" || input.action.id !== (managerStep.mode === "wish" ? "wish_send" : "apply") || input.target.kind !== "request")
              return HttpServerResponse.jsonUnsafe({ ok: false, error: "Invalid mail manager action" }, { status: 400 })
            const target = requests.find((item) => String(item.id) === input.target.id)!
            const owner = { sessionID: target.sessionID, directory: input.directory, revision: input.target.revision }
            const valid = yield* Effect.promise(() => readOwnedMailView(managerStep.viewID, owner).then(
              (view) => {
                if (view.state !== "ready") throw new Error("Mail view already used")
                if (managerStep.mode === "apply") managerSelection(view, input.values)
                if (managerStep.mode === "wish" && (input.values.wish_open !== "true" ||
                  typeof input.values.wish_text !== "string" || !input.values.wish_text.trim() || input.values.wish_text.length > 4000))
                  throw new Error("Write a wish and explicitly submit it")
                return true
              },
            ).catch((error: unknown) => error instanceof Error ? error.message : "Mail view unavailable"))
            if (valid !== true) return HttpServerResponse.jsonUnsafe({ ok: false, error: valid }, { status: 400 })
          }
          const claim = yield* useQuestions(input.directory, (surface) =>
            surface.beginActionInvocation({
              id: input.invocationID,
              target: input.target,
              actionID: input.action.id,
              source: input.action.source,
              values: input.values,
            }),
          )
          if (!claim.claimed) {
            if (claim.invocation.state === "completed")
              return HttpServerResponse.jsonUnsafe(claim.invocation.result ?? { ok: true }, {
                headers: new Headers({ "cache-control": "no-store" }),
              })
            if (claim.invocation.state === "failed")
              return HttpServerResponse.jsonUnsafe(
                {
                  ok: false,
                  error: claim.invocation.error ?? "Form action failed",
                  retry: claim.invocation.errorClass === "preflight" ? "reconcile" : "reconcile",
                  errorClass: claim.invocation.errorClass,
                },
                { status: 500 },
              )
            return HttpServerResponse.jsonUnsafe(
              { ok: false, error: "Form action invocation is still pending", retry: "reconcile" },
              { status: 409 },
            )
          }
          const step = hostFormActionStep(action!.steps)!

          // Once executions claim a durable effect slot before any side effect.
          // A competing submit of the same intent observes the winner instead of
          // producing a second provider call.
          const executionKey =
            Control.executionModeForAction(action!, action!.steps) === "once"
              ? `x:${input.target.kind}:${input.target.id}:${input.target.revision}:${input.formID}:${
                  Control.executionGroupForAction(action!, input.formID) ?? action!.id
                }`
              : undefined
          if (executionKey) {
            const effect = yield* useQuestions(input.directory, (surface) =>
              surface.beginActionEffect({ invocationID: input.invocationID, executionKey }),
            )
            if (!effect.claimed) {
              if (effect.invocation.state === "completed") {
                if (input.target.kind === "request")
                  yield* useQuestions(input.directory, (question) => closeQuestion(question, input.target.id))
                return HttpServerResponse.jsonUnsafe(effect.invocation.result ?? { ok: true }, {
                  headers: new Headers({ "cache-control": "no-store" }),
                })
              }
              if (effect.invocation.state === "failed")
                return HttpServerResponse.jsonUnsafe(
                  {
                    ok: false,
                    error: effect.invocation.error ?? "Form action failed",
                    retry: "reconcile",
                    errorClass: effect.invocation.errorClass,
                  },
                  { status: 500 },
                )
              return HttpServerResponse.jsonUnsafe(
                { ok: false, error: "Form action is already executing", retry: "reconcile" },
                { status: 409 },
              )
            }
          }

          if (step.type === "mail_manager") {
            const target = requests.find((item) => String(item.id) === input.target.id)!
            const owner = { sessionID: target.sessionID, directory: input.directory, revision: input.target.revision }
            const view = yield* Effect.promise(() => readOwnedMailView(step.viewID, owner))
            const sessions = yield* SessionV2.Service
            const active = yield* sessions.get(SessionSchema.ID.make(owner.sessionID))
            if (active.location.directory !== owner.directory) throw new Error("Mail view Session location changed")
            const result = yield* Effect.promise(() => (step.mode === "apply"
              ? applyMailView({ id: step.viewID, owner, values: input.values }, async (ref, operation, destination) => {
                  if (ref.provider === "gmx") {
                    if ((await gmxAccount(ref.accountID)).email.toLowerCase() !== view.address.toLowerCase())
                      throw new Error("GMX account changed")
                    return gmxApply(ref, operation, destination)
                  }
                  const { gmailIdentity } = await import("@opencode-ai/core/mail/manager-gmail")
                  if ((await gmailIdentity()).toLowerCase() !== view.address.toLowerCase()) throw new Error("Gmail account changed")
                  return gmailApply(ref, operation, destination)
                })
              : wishMailView({ id: step.viewID, owner, values: input.values }, (text) =>
                  Effect.runPromise(sessions.prompt({
                    id: SessionMessage.ID.make(`msg_mailmanager_${view.id.replaceAll("-", "")}`),
                    sessionID: SessionSchema.ID.make(owner.sessionID), prompt: new Prompt({ text }), delivery: "queue",
                  })))
            ).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error })))
            if (!result.ok) {
              const message = result.error instanceof Error ? result.error.message : "Mail action state unknown"
              yield* useQuestions(input.directory, (surface) => surface.failActionInvocation(input.invocationID, message, "unknown"))
              return HttpServerResponse.jsonUnsafe({ ok: false, error: message, retry: "reconcile" }, { status: 409 })
            }
            const output = { ok: result.value.state === "completed", action: step.mode, result: result.value.result,
              state: result.value.state }
            if (!output.ok) {
              yield* useQuestions(input.directory, (surface) => surface.failActionInvocation(input.invocationID,
                "Mail outcome unknown; inspect saved per-message results before a new search", "unknown"))
              return HttpServerResponse.jsonUnsafe({ ...output, retry: "reconcile" }, { status: 409 })
            }
            if (input.target.kind === "request") yield* useQuestions(input.directory, (question) => closeQuestion(question, input.target.id))
            yield* useQuestions(input.directory, (surface) => surface.completeActionInvocation(input.invocationID, output))
            return HttpServerResponse.jsonUnsafe(output, { headers: new Headers({ "cache-control": "no-store" }) })
          }
          if (step.type === "dismiss") {
            if (input.target.kind === "request")
              yield* useQuestions(input.directory, (question) => closeQuestion(question, input.target.id))
            if (input.target.kind === "tool")
              yield* useQuestions(input.directory, (surface) =>
                surface.setPersistentToolHidden(QuestionV2.PersistentToolID.make(input.target.id), true),
              )
            const output = { ok: true, action: "dismiss" }
            yield* useQuestions(input.directory, (surface) =>
              surface.completeActionInvocation(input.invocationID, output),
            )
            return HttpServerResponse.jsonUnsafe(output, { headers: new Headers({ "cache-control": "no-store" }) })
          }
          if (step.type === "command") {
            const result = yield* Effect.promise(() =>
              runHostCommand({
                command: step.command,
                arguments: [...(step.arguments ?? [])],
                directory: step.directory ?? input.directory,
                env: {
                  OPENCODE_FORM_ID: input.formID,
                  OPENCODE_FORM_ACTION: input.action.id,
                  OPENCODE_FORM_VALUES: JSON.stringify(input.values),
                },
              }),
            )
            const responseResult = commandFormActionResult(result)
            if (!result.ok) {
              yield* useQuestions(input.directory, (surface) =>
                surface.failActionInvocation(input.invocationID, responseResult.stderr || "Command form action failed"),
              )
              return HttpServerResponse.jsonUnsafe(
                { ok: false, action: "command", result: responseResult, retry: "reconcile" },
                { status: 500 },
              )
            }
            if (action!.trigger.event === "submit" && input.target.kind === "request")
              yield* useQuestions(input.directory, (question) => closeQuestion(question, input.target.id))
            const output = { ok: true, action: "command", result: responseResult }
            yield* useQuestions(input.directory, (surface) =>
              surface.completeActionInvocation(input.invocationID, output),
            )
            return HttpServerResponse.jsonUnsafe(output, { headers: new Headers({ "cache-control": "no-store" }) })
          }
          if (step.type === "gmx" && input.formID === "email-composer.v1") {
            const result = yield* Effect.promise(() =>
              executeGmxFormAction({ account: step.account, mode: step.mode, values: input.values }).then(
                (value) => ({ ok: true as const, value }),
                (error: unknown) => ({ ok: false as const, error }),
              ),
            )
            if (!result.ok) {
              const message = result.error instanceof Error ? result.error.message : "GMX delivery failed; check status before retrying"
              yield* useQuestions(input.directory, (surface) =>
                surface.failActionInvocation(input.invocationID, message, "unknown"),
              )
              return HttpServerResponse.jsonUnsafe(
                { ok: false, error: message, retry: "reconcile", errorClass: "unknown" },
                { status: 409 },
              )
            }
            if (input.target.kind === "request")
              yield* useQuestions(input.directory, (question) => closeQuestion(question, input.target.id))
            const output = { ok: true, action: step.mode, gmx: result.value }
            yield* useQuestions(input.directory, (surface) =>
              surface.completeActionInvocation(input.invocationID, output),
            )
            return HttpServerResponse.jsonUnsafe(output, { headers: new Headers({ "cache-control": "no-store" }) })
          }
          if (step.type !== "gmail")
            return HttpServerResponse.jsonUnsafe(
              { ok: false, error: "Unsupported form action", retry: "safe" },
              { status: 400 },
            )
          if (input.formID !== "email-composer.v1")
            return HttpServerResponse.jsonUnsafe(
              { ok: false, error: "Unsupported Gmail form", retry: "safe" },
              { status: 400 },
            )
          const mode = step.mode
          if (mode !== "send" && mode !== "draft")
            return HttpServerResponse.jsonUnsafe(
              { ok: false, error: "Unsupported Gmail mode", retry: "safe" },
              { status: 400 },
            )

          const gmailResult = yield* Effect.promise(() =>
            executeGmailFormAction({ mode, values: input.values }).then(
              (value) => ({ ok: true as const, value }),
              (error: unknown) => ({ ok: false as const, error }),
            ),
          )
          if (!gmailResult.ok) {
            const error = gmailResult.error
            const phase = error instanceof GmailActionError ? error.phase : "unknown"
            const message = error instanceof Error ? error.message : String(error)
            yield* useQuestions(input.directory, (surface) =>
              surface.failActionInvocation(input.invocationID, message, phase),
            )
            return HttpServerResponse.jsonUnsafe(
              { ok: false, error: message, retry: "reconcile", errorClass: phase },
              { status: phase === "unknown" ? 409 : 400 },
            )
          }
          const gmail = gmailResult.value
          if (input.target.kind === "request")
            yield* useQuestions(input.directory, (question) => closeQuestion(question, input.target.id))
          const output = { ok: true, action: mode, gmail }
          yield* useQuestions(input.directory, (surface) =>
            surface.completeActionInvocation(input.invocationID, output),
          )
          return HttpServerResponse.jsonUnsafe(output, { headers: new Headers({ "cache-control": "no-store" }) })
        }).pipe(Effect.provideService(InstanceRef, instance))
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const message = Cause.pretty(cause).split("\n", 1)[0]?.trim() || "Form action failed"
            yield* Effect.logError("form action failed", { error: message, cause: Cause.pretty(cause) })
            return HttpServerResponse.jsonUnsafe({ ok: false, error: message, retry: "reconcile" }, { status: 500 })
          }),
        ),
      ),
    )
    yield* router.add("GET", "/app/form-action", (request) =>
      Effect.gen(function* () {
        const url = new URL(request.url, "http://localhost")
        const invocationID = url.searchParams.get("invocationID") ?? ""
        const directory = url.searchParams.get("directory") ?? ""
        if (!invocationID.trim()) return HttpServerResponse.jsonUnsafe({ ok: false, error: "Expected invocationID" }, { status: 400 })
        if (!directory.trim()) return HttpServerResponse.jsonUnsafe({ ok: false, error: "Expected directory" }, { status: 400 })
        yield* instanceStore.load({ directory })
        // Read-only status lookup scoped to the loaded instance; executes nothing.
        const stored = yield* useQuestions(directory, (surface) => surface.getActionInvocation(invocationID)).pipe(
          Effect.option,
        )
        if (Option.isNone(stored))
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Unknown form action invocation" }, { status: 404 })
        const invocation = stored.value
        return HttpServerResponse.jsonUnsafe(
          {
            ok: true,
            state: invocation.state,
            error: invocation.error,
            errorClass: invocation.errorClass,
            effectStartedAt: invocation.effectStartedAt,
            result: invocation.result,
          },
          { headers: new Headers({ "cache-control": "no-store" }) },
        )
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const message = Cause.pretty(cause).split("\n", 1)[0]?.trim() || "Form action status failed"
            yield* Effect.logError("form action status failed", { error: message })
            return HttpServerResponse.jsonUnsafe({ ok: false, error: message }, { status: 500 })
          }),
        ),
      ),
    )
    yield* router.add("POST", "/app/host/images/generate", (request) =>
      Effect.gen(function* () {
        const input = hostImageGenerateInput(
          jsonRequestBody(yield* Effect.orDie(request.text), request.headers["content-type"]),
        )
        const policy = yield* Effect.promise(() =>
          AppPluginAssets.hostPolicy(input.pluginID, input.pluginVersion, input.pluginHash),
        )
        if (!policy) return HttpServerResponse.jsonUnsafe({ ok: false, error: "Unknown app plugin" }, { status: 404 })
        if (!policy.capabilities.includes("host:images"))
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Missing host:images capability" }, { status: 403 })
        const problem = AppPluginHostImages.validateImageInput(input)
        if (problem) return HttpServerResponse.jsonUnsafe({ ok: false, error: problem }, { status: 400 })
        const result = yield* AppPluginHostImages.generateImage(AppPluginHostImages.toImageRequest(input))
        return HttpServerResponse.jsonUnsafe(AppPluginHostImages.toImageResponse(result), {
          headers: new Headers({ "cache-control": "no-store" }),
        })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const message = Cause.pretty(cause).split("\n", 1)[0]?.trim() || "Plugin image generation failed"
            yield* Effect.logError("plugin image generation failed", { error: message, cause: Cause.pretty(cause) })
            return HttpServerResponse.jsonUnsafe(
              { ok: false, error: message },
              { status: 500, headers: new Headers({ "cache-control": "no-store" }) },
            )
          }),
        ),
      ),
    )
    yield* router.add("POST", "/app/host/ai/run", (request) =>
      Effect.gen(function* () {
        const started = Date.now()
        const input = hostAIRunInput(jsonObject(yield* Effect.orDie(request.text)))
        const parsedAt = Date.now()
        const directory =
          input.directory ??
          new URL(request.url, "http://localhost").searchParams.get("directory") ??
          request.headers["x-opencode-directory"]
        if (!directory?.trim())
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Expected directory" }, { status: 400 })
        const pluginVersion = input.pluginVersion
        if (!pluginVersion)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Expected pluginVersion" }, { status: 400 })
        const pluginHash = input.pluginHash
        if (!pluginHash)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Expected pluginHash" }, { status: 400 })
        const policy = yield* Effect.promise(() =>
          AppPluginAssets.hostAIPolicy(input.pluginID, pluginVersion, pluginHash),
        )
        const policyAt = Date.now()
        if (!policy) return HttpServerResponse.jsonUnsafe({ ok: false, error: "Unknown app plugin" }, { status: 404 })
        if (!policy.capabilities.includes("host:ai"))
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Missing host:ai capability" }, { status: 403 })
        const allowedTools = new Set(policy.ai.tools)
        const unknownTool = input.tools.find((tool) => !allowedTools.has(tool))
        if (unknownTool)
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: `Plugin AI tool is not allowed: ${unknownTool}` },
            { status: 403 },
          )
        if (input.tools.length > 0)
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: "Plugin AI tools are not supported yet" },
            { status: 400 },
          )
        if (!input.messages.length)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Expected prompt or messages" }, { status: 400 })
        if (input.chain?.error)
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: `Invalid model chain: ${input.chain.error}` },
            { status: 400 },
          )
        const chainSteps = input.chain?.steps
        if (chainSteps && input.model)
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: "Expected either model or chain, not both" },
            { status: 400 },
          )
        const hostDirectory = hostRouteDirectory(directory, { globalDirectory: join(Global.Path.data, "desktop-global") })
        if (!hostDirectory)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Expected an absolute directory" }, { status: 400 })
        const instance = lightweightInstance(hostDirectory)
        const instanceAt = Date.now()
        const requestAbort = new AbortController()
        yield* Effect.addFinalizer(() => Effect.sync(() => requestAbort.abort()))
        return yield* Effect.gen(function* () {
          const result = yield* headlessAI.text({
            model: input.model,
            variant: input.variant,
            chain: chainSteps,
            system: input.system,
            // Plugin helper answers may be short, but the cap also covers hidden
            // reasoning; without an explicit budget the provider default can be
            // exhausted before any visible text.
            generation: ModelRequest.helperGeneration(input.generation),
            maxRetries: input.maxRetries,
            returnAfter: input.returnAfter,
            abort: requestAbort.signal,
            messages: input.messages,
            metadata: { kind: "plugin.ai", pluginID: input.pluginID, directory },
          })
          const generatedAt = Date.now()
          const timing = {
            totalMs: generatedAt - started,
            parseMs: parsedAt - started,
            policyMs: policyAt - parsedAt,
            instanceMs: instanceAt - policyAt,
            generationMs: generatedAt - instanceAt,
          }
          yield* Effect.logInfo("plugin ai run timing", {
            pluginID: input.pluginID,
            model: result.model,
            directory,
            ...timing,
          })
          return HttpServerResponse.jsonUnsafe(
            {
              ok: true,
              text: result.text,
              model: result.model,
              ...(chainSteps ? { chain: chainSteps.map(AIChain.aiChainStepKey) } : {}),
              timing,
            },
            { headers: new Headers({ "cache-control": "no-store" }) },
          )
        }).pipe(Effect.provideService(InstanceRef, instance))
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const message = Cause.pretty(cause).split("\n", 1)[0]?.trim() || "Plugin AI failed"
            yield* Effect.logError("plugin ai failed", { error: message, cause: Cause.pretty(cause) })
            return HttpServerResponse.jsonUnsafe(
              { ok: false, error: message },
              { status: 500, headers: new Headers({ "cache-control": "no-store" }) },
            )
          }),
        ),
      ),
    )
    yield* router.add("POST", "/app/host/stt/transcribe", (request) =>
      Effect.gen(function* () {
        const contentType = (request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase()
        const form = yield* contentType === "application/json" ? sttJson(request) : sttMultipart(request)
        if (!form.audio) return sttResponse({ ok: false, error: "Expected one audio file" }, 400)
        const pluginID = requiredString(form.fields, "pluginID")
        const pluginVersion = requiredString(form.fields, "pluginVersion")
        const pluginHash = requiredString(form.fields, "pluginHash")
        const model = (form.fields.model ?? "").trim()
        if (model.length > 512) throw new Error("model exceeds 512 characters")
        if (form.chain.error) return sttResponse({ ok: false, error: `Invalid model chain: ${form.chain.error}` }, 400)
        const chainSteps = form.chain.steps
        if (chainSteps && model)
          return sttResponse({ ok: false, error: "Expected either model or chain, not both" }, 400)
        if (!chainSteps && !model) return sttResponse({ ok: false, error: "Expected model" }, 400)
        const mimeType = form.audio.mimeType.split(";", 1)[0].toLowerCase()
        if (!sttMimeTypes.has(mimeType))
          return sttResponse({ ok: false, error: `Unsupported audio type ${mimeType}` }, 415)
        const policy = yield* Effect.promise(() => AppPluginAssets.hostPolicy(pluginID, pluginVersion, pluginHash))
        if (!policy) return sttResponse({ ok: false, error: "Unknown app plugin" }, 404)
        if (!policy.capabilities.includes("host:stt"))
          return sttResponse({ ok: false, error: "Missing host:stt capability" }, 403)
        const directory =
          new URL(request.url, "http://localhost").searchParams.get("directory") ??
          request.headers["x-opencode-directory"]
        if (!directory?.trim()) return sttResponse({ ok: false, error: "Expected directory" }, 400)
        const hostDirectory = hostRouteDirectory(directory, { globalDirectory: join(Global.Path.data, "desktop-global") })
        if (!hostDirectory) return sttResponse({ ok: false, error: "Expected an absolute directory" }, 400)
        const instance = lightweightInstance(hostDirectory)
        yield* plugins.init().pipe(Effect.provideService(InstanceRef, instance))
        const globalConfig = yield* config.getGlobal()
        const requestAbort = new AbortController()
        // One correlation ID ties the job event to every attempt event of
        // this transcription request for later diagnosis.
        const correlationID = randomUUID()
        const jobStartedAt = new Date().toISOString()
        const jobStarted = Date.now()
        let served: { providerID: string; modelID: string } | undefined
        let success: STT.Result | undefined
        let lastFailure: { code: string; message: string } | undefined
        // Variants are intentionally ignored: STT adapters select by exact
        // provider/model identity and do not expose reasoning variants.
        const attempts = chainSteps ? chainSteps.map((step) => `${step.providerID}/${step.modelID}`) : [model]
        // Leave time for the response before the plugin's 120s deadline. A
        // stalled first provider must not consume every fallback's budget.
        const deadline = Date.now() + 110_000
        // A client disconnect interrupts this whole handler, so the aborted
        // attempt and job diagnostics can only be emitted from the finalizer.
        let jobLogged = false
        let inFlight:
          | {
              attempt: number
              providerID: string
              modelID: string
              startedAt: string
              started: number
              timeoutMs: number | undefined
            }
          | undefined
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            requestAbort.abort()
            if (jobLogged) return
            if (inFlight) {
              yield* Effect.logInfo(
                "stt transcription attempt",
                sttAttemptDiagnostic({
                  correlationID,
                  attempt: inFlight.attempt,
                  attempts: attempts.length,
                  providerID: inFlight.providerID,
                  modelID: inFlight.modelID,
                  startedAt: inFlight.startedAt,
                  timeoutMs: inFlight.timeoutMs,
                  durationMs: Date.now() - inFlight.started,
                  outcome: "aborted",
                  errorCode: "cancelled",
                }),
              )
            }
            yield* Effect.logInfo(
              "stt transcription job",
              sttJobDiagnostic({
                correlationID,
                attempts: attempts.length,
                startedAt: jobStartedAt,
                durationMs: Date.now() - jobStarted,
                outcome: success ? "succeeded" : "aborted",
                providerID: served?.providerID,
                modelID: served?.modelID,
                errorCode: success ? undefined : "cancelled",
              }),
            )
          }),
        )
        for (const [index, attempt] of attempts.entries()) {
          if (requestAbort.signal.aborted) break
          const started = Date.now()
          const attemptStartedAt = new Date().toISOString()
          if (chainSteps && started >= deadline) {
            lastFailure = { code: "timeout", message: "Transcription chain timed out" }
            break
          }
          const timeoutMs = chainSteps ? Math.floor((deadline - started) / (attempts.length - index)) : undefined
          const ref = anonymizeModelRef(attempt)
          inFlight = {
            attempt: index + 1,
            providerID: ref.providerID,
            modelID: ref.modelID,
            startedAt: attemptStartedAt,
            started,
            timeoutMs,
          }
          const separator = attempt.indexOf("/")
          const providerID = ProviderV2.ID.make(separator > 0 ? attempt.slice(0, separator) : attempt)
          const configured = globalConfig.provider?.[providerID]
          const authInfo = yield* auth.get(providerID)
          const options = configured?.options ?? {}
          const catalogProvider = yield* provider.getProvider(providerID).pipe(Effect.provideService(InstanceRef, instance))
          const globalProvider: Provider.Info = {
            id: providerID,
            name: configured?.name ?? providerID,
            source: configured ? "config" : authInfo ? "api" : "custom",
            env: configured?.env ?? [],
            key:
              typeof options.apiKey === "string"
                ? options.apiKey
                : authInfo?.type === "api"
                  ? authInfo.key
                  : (configured?.env ?? catalogProvider?.env ?? []).map((name) => process.env[name]).find((value) => value?.trim()),
            options,
            models: {},
          }
          const outcome = yield* STT.transcribe({
            model: attempt,
            audio: form.audio.bytes,
            mimeType,
            language: sttString(form.fields, "language", 64),
            context: sttString(form.fields, "context", 8_000),
            signal: requestAbort.signal,
            timeoutMs,
            provider: globalProvider,
            // This endpoint is already frozen to a plugin with host:stt and the
            // adapter owns the dedicated model-slug contract. The lightweight
            // provider deliberately has no model catalog, so do not reject a
            // valid adapter model merely because normal provider config exists.
            // Adapter admission must use the same resolved scope as dispatch;
            // the raw "global" sentinel is not a media-registry directory.
            allowUncataloguedModel: STT.supportsAdapterModel(providerID, attempt.slice(separator + 1), hostDirectory),
          }).pipe(
            Effect.map((result) => ({ ok: true as const, result })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
            Effect.provideService(InstanceRef, instance),
            Effect.provideService(Provider.Service, provider),
          )
          inFlight = undefined
          // A failed step with an advanceable code hands over to the next
          // chain entry; user cancellation always ends the whole job.
          const advance =
            !outcome.ok &&
            !requestAbort.signal.aborted &&
            index + 1 < attempts.length &&
            sttChainAdvanceCodes.has(outcome.error.code)
          yield* Effect.logInfo(
            "stt transcription attempt",
            sttAttemptDiagnostic({
              correlationID,
              attempt: index + 1,
              attempts: attempts.length,
              providerID: ref.providerID,
              modelID: ref.modelID,
              startedAt: attemptStartedAt,
              timeoutMs,
              durationMs: Date.now() - started,
              outcome: outcome.ok
                ? "succeeded"
                : requestAbort.signal.aborted
                  ? "aborted"
                  : advance
                    ? "fallback"
                    : "failed",
              errorCode: outcome.ok ? undefined : outcome.error.code,
            }),
          )
          if (outcome.ok) {
            served = ref
            success = outcome.result
            break
          }
          lastFailure = { code: outcome.error.code, message: outcome.error.message }
          yield* Effect.logWarning("stt transcription failed", {
            model: attempt,
            code: outcome.error.code,
            error: outcome.error.message,
          })
          if (!sttChainAdvanceCodes.has(outcome.error.code)) break
        }
        jobLogged = true
        yield* Effect.logInfo(
          "stt transcription job",
          sttJobDiagnostic({
            correlationID,
            attempts: attempts.length,
            startedAt: jobStartedAt,
            durationMs: Date.now() - jobStarted,
            outcome: success ? "succeeded" : requestAbort.signal.aborted ? "aborted" : "failed",
            providerID: served?.providerID,
            modelID: served?.modelID,
            errorCode: lastFailure?.code,
          }),
        )
        if (success) return sttResponse({ ok: true, ...success })
        if (!lastFailure) return sttResponse({ ok: false, error: "Transcription failed" }, 500)
        return sttResponse({ ok: false, error: lastFailure.message }, sttErrorStatus(lastFailure.code))
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            sttResponse(
              { ok: false, error: error instanceof Error ? error.message : "Invalid transcription request" },
              error instanceof Error && /25 MiB|file size|too large/i.test(error.message) ? 413 : 400,
            ),
          ),
        ),
      ),
    )
    yield* router.add("POST", "/app/host/tts/speech", (request) =>
      Effect.gen(function* () {
        const input = ttsInput(yield* Effect.orDie(request.text))
        if (input.chain.error)
          return sttResponse({ ok: false, error: `Invalid model chain: ${input.chain.error}` }, 400)
        const attempts = input.chain.steps
          ? input.chain.steps.map((step) => `${step.providerID}/${step.modelID}`)
          : input.model
            ? [input.model]
            : []
        if (input.chain.steps && input.model)
          return sttResponse({ ok: false, error: "Expected either model or chain, not both" }, 400)
        if (!attempts.length) return sttResponse({ ok: false, error: "Expected model" }, 400)
        const voices = attempts.map((attempt) => input.voices[attempt] ?? input.voice)
        const policy = yield* Effect.promise(() =>
          AppPluginAssets.hostPolicy(input.pluginID, input.pluginVersion, input.pluginHash),
        )
        if (!policy) return sttResponse({ ok: false, error: "Unknown app plugin" }, 404)
        if (!policy.capabilities.includes("host:tts"))
          return sttResponse({ ok: false, error: "Missing host:tts capability" }, 403)
        const directory =
          new URL(request.url, "http://localhost").searchParams.get("directory") ??
          request.headers["x-opencode-directory"]
        if (!directory?.trim()) return sttResponse({ ok: false, error: "Expected directory" }, 400)
        const hostDirectory = hostRouteDirectory(directory, { globalDirectory: join(Global.Path.data, "desktop-global") })
        if (!hostDirectory) return sttResponse({ ok: false, error: "Expected an absolute directory" }, 400)
        const instance = lightweightInstance(hostDirectory)
        yield* plugins.init().pipe(Effect.provideService(InstanceRef, instance))
        const globalConfig = yield* config.getGlobal()
        const requestAbort = new AbortController()
        yield* Effect.addFinalizer(() => Effect.sync(() => requestAbort.abort()))
        let lastFailure: { code: string; message: string } | undefined
        for (const [index, attempt] of attempts.entries()) {
          const separator = attempt.indexOf("/")
          const providerID = ProviderV2.ID.make(separator > 0 ? attempt.slice(0, separator) : attempt)
          const configured = globalConfig.provider?.[providerID]
          const authInfo = yield* auth.get(providerID)
          const options = configured?.options ?? {}
          const catalogProvider = yield* provider
            .getProvider(providerID)
            .pipe(Effect.provideService(InstanceRef, instance))
          const globalProvider: Provider.Info = {
            id: providerID,
            name: configured?.name ?? catalogProvider?.name ?? providerID,
            source: configured ? "config" : authInfo ? "api" : "custom",
            env: configured?.env ?? [],
            key:
              typeof options.apiKey === "string"
                ? options.apiKey
                : authInfo?.type === "api"
                  ? authInfo.key
                  : (configured?.env ?? catalogProvider?.env ?? []).map((name) => process.env[name]).find((value) => value?.trim()),
            options,
            models: catalogProvider?.models ?? {},
          }
          const outcome = yield* TTS.speak({
            model: attempt,
            text: input.text,
            voice: voices[index]!,
            format: input.format,
            speed: input.speed,
            signal: requestAbort.signal,
            provider: globalProvider,
          }).pipe(
            Effect.map((result) => ({ ok: true as const, result })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
            Effect.provideService(InstanceRef, instance),
            Effect.provideService(Provider.Service, provider),
            Effect.timeoutOrElse({
              duration: attempts.length > 1 ? 8_000 : 25_000,
              orElse: () => Effect.succeed({
                ok: false as const,
                error: new TTS.SpeechError("timeout", `Speech model ${attempt} did not start in time`),
              }),
            }),
          )
          if (outcome.ok) {
            const headers = new Headers({
              "cache-control": "no-store",
              "content-type": outcome.result.mimeType,
              "access-control-expose-headers": "x-generation-id, x-opencode-tts-model, x-opencode-tts-step, x-opencode-tts-format, x-opencode-tts-voice, x-opencode-tts-sample-rate, x-opencode-tts-channels",
              "x-opencode-tts-model": `${outcome.result.providerID}/${outcome.result.modelID}`,
              "x-opencode-tts-step": String(index),
              "x-opencode-tts-format": outcome.result.format,
              "x-opencode-tts-voice": encodeURIComponent(outcome.result.voice),
            })
            if (outcome.result.sampleRate) headers.set("x-opencode-tts-sample-rate", String(outcome.result.sampleRate))
            if (outcome.result.channels) headers.set("x-opencode-tts-channels", String(outcome.result.channels))
            if (outcome.result.generationID) headers.set("x-generation-id", outcome.result.generationID)
            return HttpServerResponse.stream(
              Stream.fromReadableStream({
                evaluate: () => outcome.result.stream,
                onError: (cause) => new Error(`Speech stream failed: ${String(cause)}`),
              }),
              { headers },
            )
          }
          lastFailure = { code: outcome.error.code, message: outcome.error.message }
          yield* Effect.logWarning("tts speech failed before playback", {
            model: attempt,
            code: outcome.error.code,
            error: outcome.error.message,
          })
          if (!ttsChainAdvanceCodes.has(outcome.error.code)) break
        }
        if (!lastFailure) return sttResponse({ ok: false, error: "Speech failed" }, 500)
        return sttResponse({ ok: false, error: lastFailure.message }, ttsErrorStatus(lastFailure.code))
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            sttResponse({ ok: false, error: error instanceof Error ? error.message : "Invalid speech request" }, 400),
          ),
        ),
      ),
    )
    yield* router.add("POST", "/app/host/prompt/improve", (request) => {
      let modelKey: string | undefined
      return Effect.gen(function* () {
        const input = promptImproveInput(jsonObject(yield* Effect.orDie(request.text)))
        const directory =
          input.directory ??
          new URL(request.url, "http://localhost").searchParams.get("directory") ??
          request.headers["x-opencode-directory"]
        if (!directory?.trim())
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "Expected directory" }, { status: 400 })
        const instance = yield* instanceStore.load({ directory })

        return yield* Effect.gen(function* () {
          const result = yield* headlessAI.text({
            model: input.model,
            generation: ModelRequest.helperGeneration(),
            messages: [{ role: "user", content: promptImproveUserPrompt(input.prompt, input.promptTemplate) }],
            metadata: { kind: "prompt.improve", directory },
          })
          modelKey = result.model
          const prompt = cleanImprovedPrompt(result.text)
          if (!prompt)
            return HttpServerResponse.jsonUnsafe(
              { ok: false, error: "Model returned an empty prompt" },
              { status: 500 },
            )
          return HttpServerResponse.jsonUnsafe(
            { ok: true, prompt, model: modelKey },
            { headers: new Headers({ "cache-control": "no-store" }) },
          )
        }).pipe(Effect.provideService(InstanceRef, instance))
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const message = promptImproveMessage(cause, modelKey)
            yield* Effect.logError("prompt improve failed", {
              model: modelKey,
              error: message,
              cause: Cause.pretty(cause),
            })
            return HttpServerResponse.jsonUnsafe(
              { ok: false, error: message },
              { status: 500, headers: new Headers({ "cache-control": "no-store" }) },
            )
          }),
        ),
      )
    })
    yield* router.add("GET", "/app/state/*", (request) =>
      Effect.promise(async () => {
        const key = appStateKeyFromUrl(new URL(request.url, "http://localhost"))
        if (!key) return HttpServerResponse.jsonUnsafe({ error: "Expected app state key" }, { status: 400 })
        return HttpServerResponse.jsonUnsafe(await readAppState(key), {
          headers: new Headers({ "cache-control": "no-store" }),
        })
      }),
    )
    yield* router.add("PUT", "/app/state/*", (request) =>
      Effect.gen(function* () {
        const key = appStateKeyFromUrl(new URL(request.url, "http://localhost"))
        if (!key) return HttpServerResponse.jsonUnsafe({ error: "Expected app state key" }, { status: 400 })
        const data = jsonObject(yield* Effect.orDie(request.text))
        yield* Effect.promise(() => writeAppState(key, data))
        return HttpServerResponse.jsonUnsafe({ ok: true }, { headers: new Headers({ "cache-control": "no-store" }) })
      }),
    )
    yield* router.add("GET", "/app/extensions", (request) =>
      Effect.promise(async () => {
        const url = new URL(request.url, "http://localhost")
        const directory = url.searchParams.get("directory")
        if (!directory) return HttpServerResponse.jsonUnsafe({ error: "Expected directory" }, { status: 400 })
        return HttpServerResponse.jsonUnsafe(await listLocalExtensions(directory), {
          headers: new Headers({ "cache-control": "no-store" }),
        })
      }),
    )
    yield* router.add("POST", "/app/extensions/plugin/install", (request) =>
      Effect.gen(function* () {
        const input = installInput(jsonObject(yield* Effect.orDie(request.text)))
        const result = yield* Effect.promise(() => installLocalPlugin(input))
        const config = yield* Config.Service
        yield* config.invalidate()
        return HttpServerResponse.jsonUnsafe(result, { status: installStatus(result) })
      }),
    )
    yield* router.add("POST", "/app/extensions/plugin/uninstall", (request) =>
      Effect.gen(function* () {
        const text = yield* Effect.orDie(request.text)
        const result = yield* Effect.promise(() => uninstallLocalPlugin(pluginUninstallInput(jsonObject(text))))
        const config = yield* Config.Service
        yield* config.invalidate()
        return HttpServerResponse.jsonUnsafe(result)
      }),
    )
    yield* router.add("POST", "/app/extensions/skill/install", (request) =>
      Effect.gen(function* () {
        const input = installInput(jsonObject(yield* Effect.orDie(request.text)))
        const result = yield* Effect.promise(() => installLocalSkill(input))
        const config = yield* Config.Service
        yield* config.invalidate()
        return HttpServerResponse.jsonUnsafe(result, { status: installStatus(result) })
      }),
    )
    yield* router.add("POST", "/app/extensions/skill/uninstall", (request) =>
      Effect.gen(function* () {
        const text = yield* Effect.orDie(request.text)
        const result = yield* Effect.promise(() => uninstallLocalSkill(skillUninstallInput(jsonObject(text))))
        const config = yield* Config.Service
        yield* config.invalidate()
        return HttpServerResponse.jsonUnsafe(result)
      }),
    )
    yield* router.add("GET", "/app/plugin/*", (request) =>
      Effect.promise(async () => {
        const url = new URL(request.url, "http://localhost")
        const parts = url.pathname.split("/").filter(Boolean)
        const id = parts[2] ? decodeURIComponent(parts[2]) : ""
        const version = parts[3] ? decodeURIComponent(parts[3]) : ""
        const file = parts.slice(4).map(decodeURIComponent).join("/")
        const result = await AppPluginAssets.readAsset(id, version, file)
        if (result.status !== 200) return HttpServerResponse.text(result.body, { status: result.status })
        // The URL embeds both version and (transitively) the asset hash: when
        // a plugin mutates on disk, AppPluginAssets returns 409 and the
        // client-manifest emits a fresh module URL with a new hash. That makes
        // 200 responses safe to cache aggressively without revalidation.
        // Keep the authenticated code private so shared caches cannot replay
        // one user's authorized response to another client.
        return HttpServerResponse.raw(new Uint8Array(result.body), {
          headers: new Headers({
            "cache-control": "private, max-age=31536000, immutable",
            "content-type": result.contentType,
          }),
        })
      }),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

const uiRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const client = yield* HttpClient.HttpClient
    const flags = yield* RuntimeFlags.Service
    yield* router.add("*", "/*", (request) =>
      serveUIEffect(request, { fs, client, disableEmbeddedWebUi: flags.disableEmbeddedWebUi }),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

type RouteRequirements =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"Error", unknown>
  | HttpRouter.Request<"GlobalError", unknown>
  | HttpRouter.Request<"Requires", unknown>
  | HttpRouter.Request<"GlobalRequires", never>

const app = LayerNode.group([
  Npm.node,
  EffectFlock.node,
  FSUtil.node,
  Database.node,
  Auth.node,
  Account.node,
  Config.node,
  Env.node,
  Git.node,
  Ripgrep.node,
  Storage.node,
  Snapshot.node,
  Plugin.node,
  ModelsDev.node,
  Provider.node,
  ProviderAuth.node,
  HeadlessAI.node,
  Agent.node,
  Skill.node,
  Discovery.node,
  Permission.node,
  Todo.node,
  Session.node,
  SessionProjector.node,
  SessionStatus.node,
  TurnCompletion.node,
  TurnCompletionV2.node,
  BackgroundJob.node,
  RuntimeFlags.node,
  EventV2Bridge.node,
  SessionRunState.node,
  SessionRevert.node,
  SessionSummary.node,
  Instruction.node,
  LLM.node,
  LSP.node,
  MCP.node,
  McpAuth.node,
  Command.node,
  Format.node,
  Project.node,
  ProjectIconGeneration.node,
  Vcs.node,
  Workspace.node,
  Worktree.node,
  Installation.node,
  ShareNext.node,
  SessionShare.node,
  InstanceStore.node,
  httpClient,
  EventV2.node,
  ContentStore.node,
  ProjectV2.node,
  PtyTicket.node,
])

export function createRoutes(
  corsOptions?: CorsOptions,
  observabilityLayer: typeof Observability.layer = Observability.layer,
): Layer.Layer<never, EffectConfig.ConfigError, RouteRequirements> {
  return Layer.mergeAll(
    rootApiRoutes,
    eventApiRoutes,
    ptyConnectApiRoutes,
    instanceRoutes,
    serverRoutes,
    docRoute,
    appPluginAssetRoute,
    uiRoute,
  ).pipe(
    Layer.provide([
      errorLayer,
      compressionLayer,
      corsVaryFix,
      fenceLayer,
      cors(corsOptions),
      sessionArchiveServerLayer,
      MoveSession.defaultLayer,
      HttpServer.layerServices,
    ]),
    Layer.provide(
      measureServerStartLayer("app-service-graph", LayerNode.buildLayer(app)).pipe(
        Layer.provide(observabilityLayer),
      ),
    ),
    Layer.provide(LocationServiceMap.layer),
    Layer.provide(Layer.succeed(CorsConfig)(corsOptions)),
    Layer.provide(observabilityLayer),
    // Completion needs the same process coordinator as HTTP sessions.
    Layer.provideMerge(sessionRuntimeLayer),
  )
}

export const routes = createRoutes()

export const webHandler = lazy(() =>
  HttpRouter.toWebHandler(
    Layer.provide(measureServerStartLayer("httpapi-route-layer", routes), Observability.layer),
    {
      disableLogger: true,
      memoMap,
      middleware: disposeMiddleware,
    },
  ),
)

export * as HttpApiApp from "./server"
