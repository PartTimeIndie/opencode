import type { createOpencodeClient, Session, VcsGitSnapshot, VcsGitDiscoverResult, VcsGitActionInput, VcsGitActionResult } from "@opencode-ai/sdk/v2/client"

import type { PluginOptions } from "./index.js"
import type { PluginServicesSessionContextResponses } from "@opencode-ai/sdk/v2/client"

export type AppCapability =
  | "ui:dock"
  | "ui:slots"
  | "commands"
  | "routes"
  | "kv"
  | "ui:toolbar"
  | "ui:settings"
  | "ui:loading"
  | "ui:models"
  | "ui:overlay"
  | "ui:floating"
  | "client"
  | "events"
  | "chat:parts"
  | "host:projects"
  | "host:navigation"
  | "host:sessions"
  | "host:session-policy"
  | "host:session-context"
  | "host:session-attention"
  | "host:session-attention-read"
  | "host:git"
  | "host:http"
  | "host:command"
  | "host:ai"
  | "host:images"
  | "host:stt"
  | "host:tts"
  | "host:audio"
  | "host:composer"
  | "host:toolbar"
  | "host:skills"
  | "host:skill-content"
  | "host:text-input"
  | "host:desktop-services"
  | "automation"
  | `services:${string}:${string}`

export type AppDockArea = "top" | "left" | "middle" | "right" | "bottom"

export type AppDockBounds = {
  width: number
  height: number
}

export type AppDockMountContext = {
  element: HTMLElement
  area: AppDockArea
  bounds: AppDockBounds
  visible: boolean
  signal: AbortSignal
}

export type AppDockItemPlacement = {
  area?: AppDockArea
  reveal?: boolean
}

export type AppDockItem = {
  id: string
  title: string
  icon?: string
  defaultArea: AppDockArea
  allowedAreas?: AppDockArea[]
  minWidth?: number
  minHeight?: number
  preferredWidth?: number
  preferredHeight?: number
  mount(context: AppDockMountContext): void | (() => void) | Promise<void | (() => void)>
}

export type AppSlotMountContext = {
  element: HTMLElement
  signal: AbortSignal
  context?: { slot: string; directory: string; sessionID: string }
}

export type AppSlotItem = {
  id: string
  slot: string
} & ({
  mount(context: AppSlotMountContext): void | (() => void) | Promise<void | (() => void)>
  menu?: never
} | {
  mount?: never
  menu: {
    state(context: { directory: string; sessionID: string }): { label: string; checked: boolean; disabled?: boolean }
    run(context: { directory: string; sessionID: string }): void | Promise<void>
  }
})

export type AppToolbarPlacement = "top" | "composer"
export type AppToolbarAlign = "left" | "right"

export type AppToolbarContext = {
  placement: AppToolbarPlacement
  align: AppToolbarAlign
  directory?: string
  sessionID?: string
  composerID?: string
}

export type AppToolbarMountContext = {
  element: HTMLElement
  signal: AbortSignal
  context: AppToolbarContext
}

export type AppToolbarItem = {
  id: string
  title: string
  tooltip?: string
  placement?: AppToolbarPlacement
  align?: AppToolbarAlign
  kind?: "icon" | "mount"
  mobile?: "visible" | "overflow"
  defaultVisible?: boolean
  skill?: {
    name: string
    aliases?: string[]
  }
  /**
   * Slash-command target for a declarative composer toggle. A command target
   * appends its reference as plain text; it never dispatches the command.
   * Use `skill` for skill references. Exactly one target per registration.
   */
  command?: {
    name: string
  }
  /**
   * Registers the shared one-shot composer toggle: clicking arms the item's
   * `command` or `skill` reference for the next manually submitted normal
   * message of that exact composer. Requires `host:composer` and `ui:toolbar`.
   * Custom `run`/`mount` handlers override this standard action entirely;
   * they never receive an additional hidden standard handler.
   */
  appendOnSubmit?: boolean
  icon?: {
    name?: string
    src?: string
    alt?: string
    size?: "small" | "normal" | "large"
  }
  order?: number
  visible?: (context: AppToolbarContext) => boolean
  enabled?: (context: AppToolbarContext) => boolean
  run?: (context: AppToolbarContext) => void | Promise<void>
  mount?(context: AppToolbarMountContext): void | (() => void) | Promise<void | (() => void)>
}

export type AppLoadingOverlayOptions = {
  title?: string
  message?: string
  timeoutMs: number
}

export type AppSettingsField =
  | {
      key: string
      type: "model-selection"
      label: string
      description?: string
      default: { model: string; variant?: string }
    }
  | {
      key: string
      type: "object"
      label: string
      description?: string
      default: Record<string, unknown>
      fields: AppSettingsField[]
    }
  | {
      key: string
      type: "list"
      label: string
      description?: string
      default: Array<Record<string, unknown>>
      fields: AppSettingsField[]
      addLabel?: string
      minItems?: number
      itemLabelKey?: string
      /** Builds a new row using current plugin settings; existing rows are copied before passing them. */
      createItem?(items: readonly Record<string, unknown>[]): Record<string, unknown>
    }
  | { key: string; type: "boolean"; label: string; description?: string; default: boolean }
  | {
      key: string
      type: "select"
      label: string
      description?: string
      options: { value: string; label: string }[]
      default: string
    }
  | {
      key: string
      type: "voice"
      label: string
      description?: string
      default: string
      /** Flat model-target key in this same settings item/storage scope. */
      targetKey: string
      /** Optional summary-language key; informational only, never a voice filter. */
      languageKey?: string
      /** Explicit custom-ID entry. Defaults to false; unknown saved IDs are always retained. */
      allowCustom?: boolean
    }
  | { key: string; type: "number"; label: string; description?: string; min?: number; max?: number; default: number }
  | {
      /** @deprecated Use `model-target`: every model target accepts a model or a chain. */
      key: string
      type: "model"
      label: string
      description?: string
      default: string
      filter?: {
        providerIDs?: string[]
        inputModalities?: Array<"text" | "audio" | "image" | "video" | "pdf">
        purpose?: "transcription" | "speech"
      }
    }
  | {
      key: string
      type: "model-chain"
      label: string
      description?: string
      default: string
      filter?: {
        providerIDs?: string[]
        inputModalities?: Array<"text" | "audio" | "image" | "video" | "pdf">
        purpose?: "transcription" | "speech"
      }
      required?: boolean
      autoSelectSingle?: boolean
      autoSelectDefault?: boolean
    }
  | {
      key: string
      type: "model-target"
      label: string
      description?: string
      default: string
      filter?: {
        providerIDs?: string[]
        inputModalities?: Array<"text" | "audio" | "image" | "video" | "pdf">
        purpose?: "transcription" | "speech"
      }
      required?: boolean
      autoSelectSingle?: boolean
      autoSelectDefault?: boolean
    }
  | { key: string; type: "text"; label: string; description?: string; default: string }
  | { key: string; type: "skill-list"; label: string; description?: string; default: string[] }
  | {
      key: string
      type: "textarea"
      label: string
      description?: string
      placeholder?: string
      rows?: number
      default: string
    }
  | {
      /**
       * Layout container rendered behind an open button; nested fields keep
       * their flat settings keys, so no value is stored under this key.
       */
      key: string
      type: "overlay"
      label: string
      description?: string
      fields: AppSettingsField[]
    }


export type AppSettingsItem = {
  id: string
  title: string
  searchTerms?: string[]
  storage?: {
    read(key: string, fallback: unknown): unknown
    write(key: string, value: unknown): void | Promise<void>
    /** Serialize with write; evaluate the updater against the latest accepted value. */
    update(key: string, updater: (value: unknown) => unknown): void | Promise<void>
    subscribe(handler: () => void): () => void
  }
  searchEntries?(): Array<{ title: string; description?: string; keywords: string[] }>
  sections: Array<{
    title: string
    fields: AppSettingsField[]
    actions?: Array<{ id: string; label: string; run(): void | Promise<void> }>
  }>
}

export type AppAutomationItem = {
  id: string
  title: string
  description?: string
  inputSchema?: unknown
  run(input?: unknown): unknown | Promise<unknown>
}

export type AppRouteItem = {
  id: string
  path: string
  title: string
  icon?: string
  mount(context: AppDockMountContext): void | (() => void) | Promise<void | (() => void)>
}

export type AppCustomPart = {
  id: string
  sessionID: string
  messageID: string
  type: "custom"
  kind: string
  data: unknown
  title?: string
  fallback?: string
  metadata?: Record<string, unknown>
  time?: {
    start: number
    end?: number
  }
}

export type AppCustomPartMountContext = {
  element: HTMLElement
  part: AppCustomPart
  signal: AbortSignal
}

export type AppCustomPartRenderer = {
  kind: string
  mount(context: AppCustomPartMountContext): void | (() => void) | Promise<void | (() => void)>
}

export type AppLifecycle = {
  readonly signal: AbortSignal
  onDispose(fn: () => void | Promise<void>): () => void
}

export type AppPluginStatus = {
  id: string
  displayName?: string
  enabled: boolean
  active: boolean
  capabilities: AppCapability[]
}

export type AppHostProject = {
  id: string
  projectID?: string
  worktree: string
  /** Exact directory spellings to use when listing this project's sessions. */
  sessionDirectories?: string[]
  name: string
  icon?: {
    url?: string
    override?: string
    color?: string
    generated?: string
  }
  iconGeneration?: { status?: "idle" | "queued" | "generating" | "ready" | "failed" }
}

export type AppHostNavigationState = {
  directory?: string
  sessionID?: string
}

export type AppHostNavigationEvent = {
  activated?: boolean
}

export type AppHostSessionFavorite = {
  directory: string
  id: string
  parentID?: string | null
  title?: string
  slug?: string
  time?: Session["time"]
}

export type AppHostSessionStatus = "running" | "attention" | "done" | "incomplete" | "unknown"

export type AppHostGitActionInput = VcsGitActionInput & {
  directory?: string
  /** Durable model:<provider>/<model> or chain:<id> reference for AI commits. */
  commitTarget?: string
  /** Legacy chain-only form of commitTarget. */
  modelChain?: string
}

export type AppHostGitActionResult = VcsGitActionResult
export type AppHostGitSnapshot = VcsGitSnapshot
export type AppHostGitDiscoverResult = VcsGitDiscoverResult

export type AppHostGitHistoryInput = {
  directory?: string
  selector?: "all" | "head" | "branch"
  ref?: string
  firstParent?: boolean
  limit?: number
  cursor?: string
}

export type AppHostGitHistoryCommit = {
  hash: string
  short: string
  parents: string[]
  author: string
  email: string
  date: string
  refs: string[]
  subject: string
  body: string
  bodyTruncated: boolean
  boundary: "none" | "shallow" | "missing"
}

export type AppHostGitHistoryPage = {
  commits: AppHostGitHistoryCommit[]
  hasMore: boolean
  selector: "all" | "head" | "branch"
  firstParent: boolean
  headOid?: string
  refLabels: { hash: string; label: string }[]
  nextCursor?: string
}

export type AppHostGitCommitMessageInput = {
  directory?: string
  hash?: string
  cursor?: string
}

export type AppHostGitCommitMessagePage = {
  text: string
  truncated: boolean
  nextCursor?: string
}

/** Structured history error preserved across the host boundary (opt-in). */
export type AppHostGitHistoryError = Error & {
  code: string
  recovery: string
  status?: number
}

export type AppHostGitDiffInput = {
  directory?: string
  mode?: "git" | "branch"
  context?: number
}

export type AppHostGitDiffEntry = Record<string, unknown> & {
  file?: string
  patch?: string
  additions?: number
  deletions?: number
}

export type AppHostHttpRequest = {
  path: string
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  signal?: AbortSignal
}

export type AppHostHttpResponse = {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  body?: unknown
  text: string
}

export type AppHostCommandInput = {
  command: string
  arguments?: string[]
  directory?: string
  env?: Record<string, string>
}

export type AppHostCommandResult = {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  output: string
}

export type AppHostAIMessage = {
  role: "system" | "user" | "assistant"
  content: string
}

export type AppHostAIRunInput = {
  directory?: string
  model?: string
  /** Settings model-chain id or the literal `default`. */
  chain?: string
  variant?: string
  system?: string
  prompt?: string
  messages?: AppHostAIMessage[]
  returnAfter?: "sentence"
  maxRetries?: number
  generation?: {
    maxTokens?: number
    temperature?: number
    topP?: number
    topK?: number
    frequencyPenalty?: number
    presencePenalty?: number
    seed?: number
    stop?: string[]
  }
  tools?: string[]
  signal?: AbortSignal
}

export type AppHostAIRunResult = {
  ok: boolean
  text?: string
  model?: string
  timing?: {
    totalMs: number
    parseMs: number
    policyMs: number
    instanceMs: number
    generationMs: number
  }
  error?: string
}

export type AppHostSTTInput = {
  directory?: string
  model?: string
  chain?: string
  audio: Blob
  mimeType: string
  language?: string
  context?: string
  signal?: AbortSignal
}

export type AppHostSTTResult = {
  ok: boolean
  text?: string
  providerID?: string
  modelID?: string
  error?: string
}

export type AppHostSessionModel = {
  id: string
  providerID: string
  variant?: string
  chain?: {
    id: string
    name: string
    steps: Array<{ id: string; providerID: string; variant?: string }>
    active?: number
  }
}

export type AppHostSessionEvent =
  | { type: "text.delta"; messageID: string; textID: string; delta: string }
  | { type: "text.ended"; messageID: string; textID: string; text: string }
  | { type: "activity.started" }
  | { type: "activity.completed" }
  | { type: "activity.interrupted" }
  | { type: "activity.failed"; error: string }
  | { type: "permission.asked"; sessionID: string; requestID: string; action: string; resources: string[] }
  | { type: "permission.replied"; requestID: string }

export type AppHostSessionMessage = {
  id: string
  role: "user" | "assistant"
  text: string
  createdAt: number
}

/** Bounded, read-only public projection. No permission or question replies. */
export type AppHostSessionContext = PluginServicesSessionContextResponses[200]["context"]
export type AppHostSessionContextInput = {
  directory?: string
  sessionID: string
  limit?: number
  maxTextChars?: number
  signal?: AbortSignal
}
export type AppHostSessionContextResult =
  | { ok: true; context: AppHostSessionContext }
  | { ok: false; error: { code: "forbidden" | "not_found" | "invalid_input" | "unavailable" | "aborted"; message: string } }

export type AppHostTTSInput = {
  directory?: string
  /** Direct model selection in `provider/model` form (durable `model:` refs are tolerated). */
  model?: string
  /** Explicit Settings chain reference. The text default is never selected implicitly. */
  chain?: string
  text: string
  voice?: string
  voices?: Record<string, string>
  format?: "auto" | "pcm" | "mp3"
  speed?: number
  signal?: AbortSignal
}

export type AppHostTTSResult =
  | {
      ok: true
      stream: ReadableStream<Uint8Array>
      mimeType: string
      format: "pcm" | "mp3"
      sampleRate?: number
      channels?: number
      voice: string
      model: string
      step: number
      generationID?: string
    }
  | { ok: false; error: string }

export type AppHostImageGenerateInput = {
  directory?: string
  prompt: string
  size?: string
  style?: string
  format?: string
  timeoutSeconds?: number
  signal?: AbortSignal
}

export type AppHostImageGenerateResult =
  | { ok: true; mime: string; data: string; filename: string; bytes: number }
  | { ok: false; error: string }

export type AppHostComposerInsertResult = {
  ok: boolean
  error?: string
  insertionReceiptID?: string
}

export type AppHostClipboardWriteResult = { ok: true } | { ok: false; error: string }

/** Preparation is consumed only by a user submit in the matching composer. */
export type AppHostComposerSendPreparation = {
  operationID: string
  isActive(): boolean
  subscribe(changed: () => void): () => void
  prepare(input: { intentID: string; signal: AbortSignal }): Promise<
    | { ok: true; text: string }
    | { ok: true; insertionReceiptID: string }
    /**
     * `insertDraft` asks the host to keep this text as an unsent composer draft:
     * the send stays blocked, the transaction unwinds, and only then is the
     * draft inserted, so a plugin-side insertion can never race the rollback.
     */
    | { ok: false; error: string; insertDraft?: string }
  >
}

export type AppHostComposerTarget = { directory: string; sessionID?: string; composerID: string }
export type AppHostComposerSnapshot = AppHostComposerTarget & {
  text: string
  mode: "normal" | "shell"
  model?: string
  agent?: string
}
export type AppHostComposerBeforeSubmitContext = AppHostComposerTarget & {
  mode: "normal" | "shell"
  signal: AbortSignal
  getText(): string
  setText(text: string): void
  appendText(text: string): void
  preventSubmit(reason?: string): void
  getAgent(): string | undefined
  setAgent(name: string): boolean
}
export type AppHostComposerBeforeSubmitHandler = (context: AppHostComposerBeforeSubmitContext) => void | Promise<void>

export type AppHostAudioCaptureInput = {
  /** A higher priority may replace an interruptible owner; equal priorities never preempt. */
  priority: number
  interruptible: boolean
  deviceID?: string
  signal?: AbortSignal
}

export type AppHostAudioCaptureResult =
  | { ok: true; stream: MediaStream; signal: AbortSignal; release(): void }
  | { ok: false; error: string; code?: string }

export type AppHostSkillReference = {
  name: string
  reference: string
  title?: string
  description?: string
  aliases: string[]
}

/** Read-only hints from command sources and the existing skill/policy evaluator.
 * Manual-only hints grant no invocation authority. Missing-tool hints describe
 * the supplied/current composer's selected agent, not a tool permission grant.
 */
export type AppHostSkillDiagnostic = {
  name: string
  title?: string
  reference: string
  kind: "command-not-skill" | "not-found" | "manual-only" | "missing-tools"
  message: string
  missingTools?: string[]
}

export type AppHostToolbarToggleResult = { ok: boolean; error?: string }

export type AppHostSkillResolveResult = {
  skills: Array<{ name: string; content: string }>
  issues: Array<{
    name: string
    code: "not_found" | "not_a_skill" | "too_large" | "total_too_large"
  }>
}

export type AppHostTextInputInsertResult = {
  ok: boolean
  error?: string
}

export type AppHostTextInputTarget = {
  insertText(text: string): AppHostTextInputInsertResult
}

export type AppHostHandoff = {
  pluginID: string
  handlerID: string
  directory: string
  payload: unknown
}

export type AppHostHandoffContext = {
  directory: string
  payload: unknown
  /** Host supplied origin classification; payload never grants permissions. */
  source: "plugin" | "external"
  signal: AbortSignal
}

export type AppHostDesktopServicePhase =
  "active" | "success" | "cancelled" | "error"

export type AppHostDesktopServiceInvocation = {
  id: string
  action: "start" | "toggle"
  target: {
    kind: "opencode" | "external"
    application: string
    display: { x: number; y: number; width: number; height: number }
  }
}

export type AppHostDesktopServiceState = {
  phase: AppHostDesktopServicePhase
  /** Plugin-provided status caption. */
  label: string
  detail?: string
  /** Caption for the registered shortcut during this step; omitted hides the hint. */
  actionLabel?: string
  /** Completed fraction between zero and one, when known. */
  progress?: number
  elapsedMs?: number
}

export type AppHostDesktopServiceInsertResult = {
  ok: boolean
  error?: string
  recoveredToClipboard?: boolean
}

export type AppHostDesktopServiceRegistration =
  | { ok: false; error: string }
  | {
      ok: true
      accelerator: string
      /** Invocation-scoped clipboard access, including when an external app has focus. */
      readClipboard?(invocationID: string): Promise<string>
      writeClipboard?(invocationID: string, text: string): Promise<void>
      update(invocationID: string, state: AppHostDesktopServiceState): Promise<void>
      insertText(invocationID: string, text: string): Promise<AppHostDesktopServiceInsertResult>
      dispose(): Promise<void>
    }

export type AppCommandInput = {
  id: string
  title: string
  description?: string
  category?: string
  keybind?: string
  run(): void | Promise<void>
  onKeyDown?(): void | Promise<void>
  onKeyUp?(): void | Promise<void>
}

export type AppOverlayOptions = {
  id: string
  title: string
  ariaLabel?: string
  mount(context: {
    element: HTMLElement
    signal: AbortSignal
    close(): void
  }): void | (() => void) | Promise<void | (() => void)>
}

/** Nonmodal, app-local controls. Leaving the session scope closes and aborts the mount. */
export type AppFloatingOptions = AppOverlayOptions & {
  sessions: { directory: string; ids: string[] }
}

export type AppPluginApi = {
  readonly signal: AbortSignal
  readonly capabilities: ReadonlySet<AppCapability>
  client: ReturnType<typeof createOpencodeClient>
  services: {
    call(input: { pluginID: string; serviceID: string; version: number; input: unknown; directory?: string; signal?: AbortSignal }): Promise<{ ok: true; data: unknown } | { ok: false; error: string; status?: number }>
  }
  dock: {
    register(item: AppDockItem): () => void
    state: {
      item(id: string): { area?: AppDockArea; visible: boolean }
    }
    open: {
      item(id: string, placement?: AppDockItemPlacement): void
    }
    close: {
      item(id: string): void
    }
    move: {
      item(id: string, area: AppDockArea): void
    }
  }
  slots: {
    register(item: AppSlotItem): () => void
  }
  toolbar: {
    register(item: AppToolbarItem): () => void
  }
  ui: {
    floating: {
      open(input: AppFloatingOptions): { close(): void }
    }
    overlay: {
      open(input: AppOverlayOptions): { close(): void }
    }
    loading: {
      show(input: AppLoadingOverlayOptions): { close(): void }
      with<T>(input: AppLoadingOverlayOptions, run: () => Promise<T>): Promise<T>
    }
    models: {
      resolve(target: string): AppHostSessionModel | undefined
      chains(): Array<{ id: string; name: string; isDefault: boolean }>
      selector(input: {
        element: HTMLElement
        value?: string
        label?: string
        allowClear?: boolean
        onChange(value: string | undefined): void
      }): { setValue(value: string | undefined): void; dispose(): void }
    }
  }
  settings: {
    register(item: AppSettingsItem): () => void
    get<T>(key: string, fallback: T): T
    set(key: string, value: unknown): void
    subscribe(handler: (settings: Record<string, unknown>) => void): () => void
  }
  automation: {
    register(item: AppAutomationItem): () => void
  }
  routes: {
    register(item: AppRouteItem): () => void
  }
  chat: {
    parts: {
      register(renderer: AppCustomPartRenderer): () => void
    }
  }
  commands: {
    register(command: AppCommandInput): () => void
  }
  kv: {
    get<T>(key: string, fallback: T): T
    set(key: string, value: unknown): void
    delete(key: string): void
  }
  event: {
    on(type: string, handler: (event: unknown, context: { directory: string }) => void): () => void
  }
  host: {
    projects: {
      list(): AppHostProject[]
      open(directory?: string): void
      move(worktree: string, toIndex: number): void
      subscribe(handler: (projects: AppHostProject[]) => void): () => void
    }
    navigation: {
      current(): AppHostNavigationState
      subscribe?(handler: (state: AppHostNavigationState, event?: AppHostNavigationEvent) => void): () => void
      openSession(input: { directory: string; sessionID: string; area?: AppDockArea }): void
      newSession(input: { directory: string; area?: AppDockArea }): void
      handoff(input: AppHostHandoff): Promise<{ ok: boolean; error?: string }>
      registerHandoffHandler(input: {
        id: string
        handle(context: AppHostHandoffContext): void | Promise<void>
      }): () => void
    }
    sessions: {
      attention: {
        register(id: string): () => void
        get(input: { directory: string; sessionID: string }): { enabled: boolean; available: boolean; pendingCount: number; error: boolean } | undefined
        set(input: { directory: string; sessionID: string }, enabled: boolean): Promise<boolean>
        subscribe(handler: () => void): () => void
      }
      accessControl: {
        get(input: { directory: string; sessionID?: string }): Promise<{ mode: "ask" | "approve_for_me" | "full_access" }>
        set(input: { directory: string; sessionID: string; mode: "ask" | "approve_for_me" | "full_access" }): Promise<void>
      }
      create(input: {
        directory?: string
        modelTarget: string
        agent?: string
      }): Promise<{ ok: true; sessionID: string; model: AppHostSessionModel } | { ok: false; error: string }>
      prompt(input: {
        directory?: string
        sessionID: string
        text: string
        delivery?: "steer" | "queue"
        model: AppHostSessionModel
        agent?: string
      }): Promise<{ ok: boolean; error?: string }>
      interrupt(input: { directory?: string; sessionID: string }): Promise<{ ok: boolean; error?: string }>
      replyPermission(input: {
        directory?: string
        sessionID: string
        requestID: string
        reply: "once" | "reject"
      }): Promise<{ ok: boolean; error?: string }>
      messages(input: { directory?: string; sessionID: string; limit?: number }): Promise<AppHostSessionMessage[]>
      context(input: AppHostSessionContextInput): Promise<AppHostSessionContextResult>
      subscribeEvents(
        input: { directory: string; sessionID: string; relatedSession?: () => Promise<string | undefined> },
        handler: (event: AppHostSessionEvent) => void,
      ): () => void
      working(input: { directory: string; sessionID: string }): boolean
      status(input: { directory: string; sessionID: string }): AppHostSessionStatus | undefined
      active(): AppHostSessionFavorite[]
      subscribe(handler: () => void): () => void
      favorites: {
        list(): AppHostSessionFavorite[]
        is(input: { directory: string; id: string }): boolean
        set(input: AppHostSessionFavorite, favorite: boolean): void
        toggle(input: AppHostSessionFavorite): boolean
        subscribe(handler: (favorites: AppHostSessionFavorite[]) => void): () => void
      }
    }
    git: {
      snapshot(input?: { directory?: string; limit?: number }): Promise<AppHostGitSnapshot>
      /** Branch-filtered, anchored history page. Continuations pass only `cursor`. */
      history(input?: AppHostGitHistoryInput): Promise<AppHostGitHistoryPage>
      /** Next char-safe chunk of a full commit message. */
      commitMessage(input: AppHostGitCommitMessageInput): Promise<AppHostGitCommitMessagePage>
      discover(input?: { directory?: string; maxDepth?: number }): Promise<AppHostGitDiscoverResult>
      diff(input?: AppHostGitDiffInput): Promise<AppHostGitDiffEntry[]>
      action(input: AppHostGitActionInput): Promise<AppHostGitActionResult>
    }
    http: {
      request(input: AppHostHttpRequest): Promise<AppHostHttpResponse>
    }
    command: {
      run(input: AppHostCommandInput): Promise<AppHostCommandResult>
    }
    ai: {
      run(input: AppHostAIRunInput): Promise<AppHostAIRunResult>
    }
    stt: {
      transcribe(input: AppHostSTTInput): Promise<AppHostSTTResult>
    }
    tts: {
      speak(input: AppHostTTSInput): Promise<AppHostTTSResult>
    }
    images: {
      generate(input: AppHostImageGenerateInput): Promise<AppHostImageGenerateResult>
    }
    audio: {
      acquire(input: AppHostAudioCaptureInput): Promise<AppHostAudioCaptureResult>
    }
    composer: {
      read(target: AppHostComposerTarget): AppHostComposerSnapshot | undefined
      change(input: AppHostComposerTarget & { text: string; expectedText?: string }): AppHostComposerInsertResult
      beforeSubmit(target: AppHostComposerTarget, handler: AppHostComposerBeforeSubmitHandler): () => void
      registerSendPreparation(target: AppHostComposerTarget, preparation: AppHostComposerSendPreparation): () => void
      insertText(input: {
        directory: string
        sessionID?: string
        composerID?: string
        text: string
        position?: "cursor" | "end"
        replace?: string
        operationID?: string
      }): Promise<AppHostComposerInsertResult>
      submitText(input: {
        directory: string
        sessionID: string
        composerID: string
        text: string
      }): Promise<AppHostComposerInsertResult>
    }
    skills: {
      list(input?: {
        scope?: "visible" | "all"
        directory?: string
        sessionID?: string
        composerID?: string
        signal?: AbortSignal
      }): Promise<AppHostSkillReference[]>
      diagnostics(input?: {
        agent?: string
        directory?: string
        sessionID?: string
        composerID?: string
        signal?: AbortSignal
      }): Promise<AppHostSkillDiagnostic[]>
      resolve(input: {
        names: string[]
        directory?: string
        signal?: AbortSignal
      }): Promise<AppHostSkillResolveResult>
    }
    /**
     * Toggles the shared `appendOnSubmit` standard action of an app toolbar
     * item for the current or explicitly addressed composer. The item id is
     * the unscoped id used at `toolbar.register`. Requires `host:toolbar`.
     */
    toolbar: {
      toggle(input: {
        item: string
        directory?: string
        sessionID?: string
        composerID?: string
      }): Promise<AppHostToolbarToggleResult>
    }
    textInput: {
      capture(): AppHostTextInputTarget | undefined
    }
    desktopServices: {
      register(input: {
        id: string
        accelerator: string
        onInvoke(invocation: AppHostDesktopServiceInvocation): void | Promise<void>
      }): Promise<AppHostDesktopServiceRegistration>
      /**
        * Writes text through the desktop shell, which unlike the web Clipboard
        * API also works while the OpenCode window is in the background.
        * Absent on hosts without a desktop shell.
        */
      writeClipboardText?(text: string): Promise<AppHostClipboardWriteResult>
    }
  }
  plugins: {
    list(): ReadonlyArray<AppPluginStatus>
  }
  lifecycle: AppLifecycle
}

export type AppPluginMeta = {
  id: string
  spec: string
  version?: string
  capabilities: AppCapability[]
}

export type AppPlugin = (
  api: AppPluginApi,
  options: PluginOptions | undefined,
  meta: AppPluginMeta,
) => Promise<void> | void

export type AppPluginModule = {
  id?: string
  app: AppPlugin
  server?: never
  tui?: never
}
