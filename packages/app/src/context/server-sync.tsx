import type {
  Config,
  ConfigUpdate,
  McpLocalConfig,
  McpRemoteConfig,
  OpencodeClient,
  Path,
  Project,
  ProviderAuthResponse,
  Session,
  SessionStatus,
  Todo,
} from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { getFilename } from "@opencode-ai/core/util/path"
import { type Accessor, batch, createEffect, createMemo, getOwner, onCleanup, onMount, untrack } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { InitError } from "../pages/error"
import { Binary } from "@opencode-ai/core/util/binary"
import { GLOBAL_SCOPE_DIRECTORY, ServerSDK, globalScopeSessionRef, type SyncServerEvent } from "./server-sdk"
import {
  bootstrapDirectory,
  bootstrapGlobal,
  clearProviderRev,
  loadAgentsQuery,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadProjectsQuery,
  loadProvidersQuery,
  retryFailedProviderQueries,
  shouldRefreshCatalogsAfterConfigUpdate,
} from "./global-sync/bootstrap"
import { createChildStoreManager } from "./global-sync/child-store"
import { applyDirectoryEvent, applyGlobalEvent, cleanupDroppedSessionCaches } from "./global-sync/event-reducer"
import { clearSessionPrefetchDirectory } from "./global-sync/session-prefetch"
import {
  estimateRootSessionTotal,
  loadRootSessionsWithFallback,
  mergeLoadedSessions,
  type SharedSessionLoad,
  waitForSharedSessionLoad,
} from "./global-sync/session-load"
import { sessionTrimPreserveIDs, trimSessions } from "./global-sync/session-trim"
import { mergeSessionList, replaceSessionList } from "./global-sync/session-list"
import type { ProjectMeta, State } from "./global-sync/types"
import { SESSION_RECENT_LIMIT } from "./global-sync/types"
import { formatServerError, isCancellationError } from "@/utils/server-errors"
import { queryOptions, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/solid-query"
import { createRefreshQueue } from "./global-sync/queue"
import { directoryKey, normalizeCommandList, cmp } from "./global-sync/utils"
import { PathKey } from "@/utils/path-key"
import { createDirSyncContext, hydratedSessionStatus, isSessionNotFoundError } from "./directory-sync"
import { createSimpleContext, NormalizedProviderListResponse } from "@opencode-ai/ui/context"
import { createRefCountMap } from "@/utils/refcount"
import { useGlobal } from "./global"
import { ServerConnection, useServer } from "./server"
import { retry } from "@opencode-ai/core/util/retry"
import type { ServerScope } from "@/utils/server-scope"
import { hasActiveSessionTool, idleSignalSettlesActivity, type TurnCompletionStatus } from "@/utils/session-status"
import { Persist, persisted } from "@/utils/persist"
import { toggleMcp } from "./global-sync/mcp"
import { updateGlobalConfig } from "./global-config-update"
import { sidebarSessionLimitDefault } from "./settings"
import { permissionChangedAfter, permissionRevision } from "./global-sync/permission-revision"
import { questionChangedAfter, questionRevision } from "./global-sync/question-revision"
import { loadPendingPermissions } from "./permission-request"
import { loadPendingQuestions } from "./question-request"
import {
  activeSessionActivityIDs,
  sessionActivityDismissed,
  finishSessionActivity,
  sessionActivity,
  sessionActivityGeneration,
  sessionActivityGenerationSnapshot,
  sessionActivitySettled,
  sessionActivityStartedAt,
  updateSessionActivity,
} from "@/utils/session-activity"

type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  project: Project[]
  session_todo: {
    [key: string]: Todo[]
  }
  session_turn_completion: {
    [key: string]: TurnCompletionStatus
  }
  provider: NormalizedProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

type SessionStatusSnapshot = {
  data: Record<string, SessionStatus>
  generations: ReadonlyMap<string, number>
}

export function mcpSetupSessionModel(config: Pick<Config, "model_chains" | "default_model_chain">) {
  const chain = config.model_chains?.find((item) => item.id === config.default_model_chain)
  const first = chain?.steps[0]
  if (!chain || !first) return
  return {
    id: first.modelID,
    providerID: first.providerID,
    ...(first.variant ? { variant: first.variant } : {}),
    chain: {
      id: chain.id,
      name: chain.name,
      active: 0,
      steps: chain.steps.map((step) => ({
        id: step.modelID,
        providerID: step.providerID,
        ...(step.variant ? { variant: step.variant } : {}),
      })),
    },
  }
}

export const loadMcpQuery = (scope: ServerScope, directory: string, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [scope, directoryKey(directory), "mcp"] as const,
    queryFn: ({ signal }) => sdk.mcp.status({}, { signal }).then((r) => r.data ?? {}),
  })

export const loadLspQuery = (scope: ServerScope, directory: string, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [scope, directoryKey(directory), "lsp"] as const,
    queryFn: ({ signal }) => sdk.lsp.status({}, { signal }).then((r) => r.data ?? []),
  })

const SESSION_TAB_EVENTS = new Set([
  "session.turn.completed",
  "session.deleted",
  "session.next.title.updated",
  "session.next.activity.started",
  "session.next.activity.recovered",
  "session.next.activity.interrupted",
  "session.next.activity.completed",
  "session.next.activity.failed",
  "session.status",
  "permission.asked",
  "permission.v2.asked",
  "permission.replied",
  "permission.v2.replied",
  "surface.asked",
  "surface.replied",
  "surface.dismissed",
])

export const SESSION_STATUS_POLL_INTERVAL_MS = 3_000
// Lifecycle events are the fast path, but a resume can start outside this renderer
// (another tab, the desktop bridge, or a server-side recovery). Reconcile the active
// root and visible, foreground-ready workspaces without polling every cached child.
export const SESSION_STATUS_RECONCILIATION_INTERVAL_MS = 15_000

export function isSessionTabEvent(type: string) {
  return SESSION_TAB_EVENTS.has(type.replace(/\.\d+$/, ""))
}

export function directoryStoreForEvent<T>(input: {
  existing: T | undefined
  type: string
  createLightweight: () => T
}) {
  if (input.existing) return input.existing
  if (!isSessionTabEvent(input.type)) return
  return input.createLightweight()
}

// Stale references (restored tabs, favorites) can point at sessions the server
// no longer knows. Swallow only that 404 after forgetting the record; every
// other failure keeps rejecting so callers and bootstrap surfaces stay honest.
export function recoverMissingSessionInfo(error: unknown, forget: () => void): undefined {
  if (!isSessionNotFoundError(error)) throw error
  forget()
  return undefined
}

export function sessionsNeedingStatusRecovery(store: Pick<State, "session_status" | "message" | "part">) {
  return [
    ...new Set([
      ...Object.entries(store.session_status)
        .filter(([, status]) => status.type !== "idle")
        .map(([sessionID]) => sessionID),
      ...Object.keys(store.message).filter(
        (sessionID) => store.session_status[sessionID] === undefined && hasActiveSessionTool(store, sessionID),
      ),
    ]),
  ]
}

export function sessionIDsForStatusRecovery(
  directory: string,
  store: Pick<State, "session_status" | "message" | "part">,
) {
  return [
    ...new Set([
      ...Object.keys(store.session_status),
      ...sessionsNeedingStatusRecovery(store),
      ...activeSessionActivityIDs(directory),
    ]),
  ]
}

export function shouldPollSessionStatus(directory: string, store: Pick<State, "session_status" | "message" | "part">) {
  return sessionsNeedingStatusRecovery(store).length > 0 || activeSessionActivityIDs(directory).length > 0
}

export function sessionStatusReconciliationScope(input: {
  activeDirectory: string
  visibleDirectories: string[]
  activeSessionMessagesReady: boolean
  pageVisible: boolean
  hasSessions: boolean
}) {
  const foregroundReady = input.activeSessionMessagesReady && input.pageVisible && input.hasSessions
  return {
    activeDirectory: directoryKey(input.activeDirectory),
    foregroundReady,
    directories: new Set(
      [input.activeDirectory, ...(foregroundReady ? input.visibleDirectories : [])].map(directoryKey),
    ),
  }
}

export function shouldRefreshDirectoryStatus(input: {
  directory: string
  store: Pick<State, "session_status" | "message" | "part">
  activeOnly: boolean
  scope: ReturnType<typeof sessionStatusReconciliationScope>
}) {
  if (input.activeOnly) {
    if (!input.scope.foregroundReady && directoryKey(input.directory) !== input.scope.activeDirectory) return false
    return shouldPollSessionStatus(input.directory, input.store)
  }
  return input.scope.directories.has(directoryKey(input.directory))
}

export function shouldApplySessionStatusResponse(
  directory: string,
  sessionID: string,
  generations: ReadonlyMap<string, number>,
) {
  return sessionActivityGeneration(directory, sessionID) === (generations.get(sessionID) ?? 0)
}

export function statusSnapshotSettlesActivity(incoming?: SessionStatus) {
  return (incoming?.type ?? "idle") === "idle"
}

export function statusSnapshotRecoversMissedTerminal(
  incoming: SessionStatus | undefined,
  store: Pick<State, "message" | "part">,
  sessionID: string,
  startedAt?: number,
  now = Date.now(),
) {
  return statusSnapshotSettlesActivity(incoming) && idleSignalSettlesActivity(store, sessionID, startedAt, now)
}

export function reconcileSessionStatusSnapshot(input: {
  directory: string
  sessionID: string
  generations: ReadonlyMap<string, number>
  incoming?: SessionStatus
  store: Pick<State, "session_status" | "message" | "part">
}) {
  if (!shouldApplySessionStatusResponse(input.directory, input.sessionID, input.generations)) return
  if (input.incoming?.type !== undefined && input.incoming.type !== "idle" && sessionActivitySettled(input.directory, input.sessionID)) {
    updateSessionActivity(input.directory, input.sessionID, input.incoming)
  }
  if (
    statusSnapshotSettlesActivity(input.incoming) &&
    (sessionActivityDismissed(input.directory, input.sessionID) ||
      statusSnapshotRecoversMissedTerminal(
        input.incoming,
        input.store,
        input.sessionID,
        sessionActivityStartedAt(input.directory, input.sessionID),
      )) &&
    sessionActivity(input.directory, input.sessionID)
  ) {
    finishSessionActivity(input.directory, input.sessionID)
  }
  return hydratedSessionStatus({
    current: input.store.session_status[input.sessionID],
    incoming: input.incoming,
    liveBusy: sessionActivity(input.directory, input.sessionID)?.type === "busy",
  })
}

export function sessionTabSyncEvent(event: SyncServerEvent): { type: string; properties: unknown } | undefined {
  const type = event.syncEvent.type.replace(/\.\d+$/, "")
  if (!isSessionTabEvent(type)) return
  const data = event.syncEvent.data
  if (!data || typeof data !== "object" || !("sessionID" in data)) return
  if (data.sessionID !== event.syncEvent.aggregateID) return
  return { type, properties: data }
}

// Scope-less session events are re-keyed onto the project directory that owns
// the session, so the transport pseudo "global" scope never replaces a real
// placement. Payload info.directory always routes. The known-session lookup
// resolves only sessions a directory store already lists or tracks status for;
// everything else keeps the global scope and is reconciled by the periodic
// status polls once a store materializes.
export function sessionDirectoryInStores(input: {
  directories: Iterable<[string, Pick<State, "session" | "session_status">]>
  sessionID: string
}) {
  for (const [directory, store] of input.directories) {
    if (!directory || directory === GLOBAL_SCOPE_DIRECTORY) continue
    if (Binary.search(store.session, input.sessionID, (s) => s.id).found) return directory
    if (store.session_status[input.sessionID] !== undefined) return directory
  }
  return undefined
}

type BootstrapRun = {
  promise: Promise<void>
  sessions: boolean
}

export function withBootstrapSessions(run: BootstrapRun, loadSessions: () => Promise<void>) {
  if (run.sessions) return run.promise
  run.sessions = true
  run.promise = Promise.all([run.promise, Promise.resolve().then(loadSessions)]).then(() => undefined)
  return run.promise
}

export const PASSIVE_SIDEBAR_REQUEST_TIMEOUT_MS = 10_000

export async function withAbortableDeadline<T>(input: {
  signal: AbortSignal
  timeoutMs: number
  run: (signal: AbortSignal) => Promise<T>
}) {
  const controller = new AbortController()
  const abort = () => controller.abort(input.signal.reason)
  if (input.signal.aborted) abort()
  else input.signal.addEventListener("abort", abort, { once: true })
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Passive sidebar request deadline exceeded", "TimeoutError")),
    input.timeoutMs,
  )
  try {
    input.signal.throwIfAborted()
    return await input.run(controller.signal)
  } finally {
    clearTimeout(timeout)
    input.signal.removeEventListener("abort", abort)
  }
}

export function loadPassiveSessionStatus(client: OpencodeClient, directory: string, signal: AbortSignal) {
  return client.session.status({ directory }, { signal })
}

export function loadPassiveSessionInfo(client: OpencodeClient, sessionID: string, signal: AbortSignal) {
  return client.session.get({ sessionID }, { signal })
}

export function createSerialDirectoryLoader(input: {
  load: (directory: string, options: { signal: AbortSignal; canContinue: () => boolean }) => Promise<boolean | void>
}) {
  const pending = new Map<string, string>()
  const loading = new Set<string>()
  const loadingGeneration = new Map<string, number>()
  const loadingDirectory = new Map<string, string>()
  const loadingControllers = new Map<string, AbortController>()
  const loaded = new Set<string>()
  const generations = new Map<string, number>()
  const directoryNames = new Map<string, string>()
  let requested = new Set<string>()
  let disposed = false
  let active: Promise<void> | undefined
  let canContinue = (_directory: string) => true

  const drain = () => {
    if (active) return active
    active = (async () => {
      while (pending.size > 0) {
        const next = pending.entries().next().value
        if (!next) break
        if (!canContinue(next[1])) break
        pending.delete(next[0])
        loading.add(next[0])
        loadingDirectory.set(next[0], next[1])
        const generation = generations.get(next[0]) ?? 0
        loadingGeneration.set(next[0], generation)
        const controller = new AbortController()
        loadingControllers.set(next[0], controller)
        let complete = false
        try {
          complete =
            (await input.load(next[1], {
              signal: controller.signal,
              canContinue: () => canContinue(next[1]),
            })) !== false
        } catch (error) {
          if (!controller.signal.aborted) console.warn("Failed to load passive session indicators", next[1], error)
        } finally {
          loading.delete(next[0])
          loadingDirectory.delete(next[0])
          loadingGeneration.delete(next[0])
          loadingControllers.delete(next[0])
        }
        if ((generations.get(next[0]) ?? 0) !== generation) continue
        if (!complete || controller.signal.aborted || !canContinue(next[1])) continue
        loaded.add(next[0])
      }
    })().finally(() => {
      active = undefined
    })
    return active
  }

  const waitForIdle = async () => {
    if (active) await active
  }

  return {
    enqueue(directories: string[], eligible: (directory: string) => boolean = () => true) {
      if (disposed) return Promise.resolve()
      requested = new Set<string>(directories.map(directoryKey).filter(Boolean))
      for (const directory of directories) {
        const key = directoryKey(directory)
        if (key && !directoryNames.has(key)) directoryNames.set(key, directory)
      }
      canContinue = (directory) => requested.has(directoryKey(directory)) && eligible(directory)
      for (const [key, controller] of loadingControllers) {
        const directory = loadingDirectory.get(key)
        if (directory && !canContinue(directory)) controller.abort(new DOMException("Passive load is no longer eligible", "AbortError"))
      }
      for (const key of pending.keys()) {
        if (!requested.has(key)) pending.delete(key)
      }
      for (const directory of directories) {
        const key = directoryKey(directory)
        if (!key || loaded.has(key) || pending.has(key)) continue
        if (loading.has(key)) {
          if (
            loadingControllers.get(key)?.signal.aborted ||
            (loadingGeneration.get(key) ?? 0) !== (generations.get(key) ?? 0)
          )
            pending.set(key, directoryNames.get(key) ?? directory)
          continue
        }
        pending.set(key, directoryNames.get(key) ?? directory)
      }
      void drain()
      return waitForIdle()
    },
    forget(directory: string) {
      const key = directoryKey(directory)
      if (!key) return
      pending.delete(key)
      loaded.delete(key)
      directoryNames.delete(key)
      if (loading.has(key)) {
        generations.set(key, (generations.get(key) ?? 0) + 1)
        loadingControllers.get(key)?.abort(new DOMException("Passive directory was disposed", "AbortError"))
      }
    },
    dispose() {
      disposed = true
      requested.clear()
      pending.clear()
      directoryNames.clear()
      for (const controller of loadingControllers.values())
        controller.abort(new DOMException("Passive directory loader was disposed", "AbortError"))
    },
  }
}

function mergePendingRequests<T extends { id: string; sessionID: string }>(input: {
  pending: T[]
  current: T[]
  complete: boolean
  inDirectory: (sessionID: string) => boolean
  changedAfter: (requestID: string) => boolean
}) {
  const merged = new Map(
    input.pending
      .filter((request) => input.inDirectory(request.sessionID))
      .filter((request) => !input.changedAfter(request.id))
      .map((request) => [request.id, request]),
  )
  input.current
    .filter((request) => input.inDirectory(request.sessionID))
    .filter((request) => input.changedAfter(request.id) || (!input.complete && !merged.has(request.id)))
    .forEach((request) => merged.set(request.id, request))
  return [...merged.values()].reduce<Record<string, T[]>>((grouped, request) => {
    const list = grouped[request.sessionID]
    if (list) list.push(request)
    if (!list) grouped[request.sessionID] = [request]
    return grouped
  }, {})
}

export function makeQueryOptionsApi(
  scope: ServerScope,
  serverSDK: () => OpencodeClient,
  sdkFor: (dir: string) => OpencodeClient,
) {
  return {
    globalConfig: () => loadGlobalConfigQuery(scope, serverSDK()),
    projects: () => loadProjectsQuery(scope, serverSDK()),
    providers: (key: PathKey | null, directory?: string) =>
      loadProvidersQuery(scope, key, key === null ? serverSDK() : sdkFor(directory ?? key)),
    path: (key: PathKey | null, directory?: string) =>
      loadPathQuery(scope, key, key === null ? serverSDK() : sdkFor(directory ?? key)),
    agents: (key: PathKey, directory?: string) => loadAgentsQuery(scope, key, sdkFor(directory ?? key)),
    mcp: (key: PathKey, directory?: string) => loadMcpQuery(scope, key, sdkFor(directory ?? key)),
    lsp: (key: PathKey, directory?: string) => loadLspQuery(scope, key, sdkFor(directory ?? key)),
    sessions: (directory: PathKey) => ({ queryKey: [scope, directoryKey(directory), "loadSessions"] as const }),
  }
}
export type QueryOptionsApi = ReturnType<typeof makeQueryOptionsApi>

function readSidebarSessionLimit(): number {
  try {
    const raw = localStorage.getItem("settings.v3")
    if (!raw) return sidebarSessionLimitDefault
    const value = JSON.parse(raw)?.general?.sidebarSessionLimit
    if (typeof value !== "number" || !Number.isFinite(value)) return sidebarSessionLimitDefault
    return Math.min(50, Math.max(1, Math.round(value)))
  } catch {
    return sidebarSessionLimitDefault
  }
}

export function createServerSyncContextInner(serverSDK: ServerSDK) {
  const language = useLanguage()
  const owner = getOwner()
  if (!owner) throw new Error("ServerSync must be created within owner")

  const sdkCache = new Map<string, OpencodeClient>()
  const booting = new Map<string, BootstrapRun>()
  const sessionLoads = new Map<string, SharedSessionLoad>()
  const sessionStatusLoads = new Map<string, Promise<SessionStatusSnapshot>>()
  const sessionMeta = new Map<string, { limit: number }>()
  const locallyCreatedSessionIDs = new Map<string, Set<string>>()
  const retainedSessionIDs = new Map<string, Map<string, number>>()
  const statusLifecycle = { disposed: false }

  const sdkFor = (directory: string) => {
    const key = directoryKey(directory)
    const cached = sdkCache.get(key)
    if (cached) return cached
    const sdk = serverSDK.createClient({
      directory,
      throwOnError: true,
    })
    sdkCache.set(key, sdk)
    return sdk
  }

  const queryOptionsApi = makeQueryOptionsApi(serverSDK.scope, () => serverSDK.client, sdkFor)
  const globalProviderQueryOptions = queryOptionsApi.providers(null)

  const [configQuery, providerQuery, pathQuery] = useQueries(() => ({
    queries: [queryOptionsApi.globalConfig(), globalProviderQueryOptions, queryOptionsApi.path(null)],
  }))

  const [sessionTurnCompletion, setSessionTurnCompletionStore] = persisted(
    Persist.serverGlobal(serverSDK.scope, "session-turn-completion.v1"),
    createStore({ value: {} as Record<string, TurnCompletionStatus> }),
  )
  const [globalStore, setGlobalStore] = createStore<GlobalStore>({
    get ready() {
      return !bootstrap.isPending
    },
    project: [],
    session_todo: {},
    get session_turn_completion() {
      return sessionTurnCompletion.value
    },
    provider_auth: {},
    get path() {
      const EMPTY = { state: "", config: "", worktree: "", directory: "", home: "" }
      if (pathQuery.isLoading) return EMPTY
      return pathQuery.data ?? EMPTY
    },
    get provider() {
      const EMPTY = { all: new Map(), connected: [], default: {} }
      if (providerQuery.isLoading) return EMPTY
      return providerQuery.data ?? EMPTY
    },
    get config() {
      if (configQuery.isLoading) return {}
      return configQuery.data ?? {}
    },
    get reload() {
      return updateConfigMutation.isPending ? "pending" : undefined
    },
  })

  const queryClient = useQueryClient()

  let bootedAt = 0
  let bootingRoot = false
  onCleanup(() => {
    statusLifecycle.disposed = true
    sessionStatusLoads.clear()
  })

  const setProjects = (next: Project[] | ((draft: Project[]) => Project[])) => {
    setGlobalStore("project", next)
  }

  const setBootStore = ((...input: unknown[]) => {
    if (input[0] === "project" && Array.isArray(input[1])) {
      setProjects(input[1] as Project[])
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const bootstrap = useQuery(() => ({
    queryKey: [serverSDK.scope, "bootstrap"],
    queryFn: async () => {
      await bootstrapGlobal({
        serverSDK: serverSDK.client,
        scope: serverSDK.scope,
        requestFailedTitle: language.t("common.requestFailed"),
        translate: language.t,
        formatMoreCount: (count) => language.t("common.moreCountSuffix", { count }),
        setGlobalStore: setBootStore,
        queryClient,
      })
      bootedAt = Date.now()
      return bootedAt
    },
  }))

  const set = ((...input: unknown[]) => {
    if (input[0] === "project" && (Array.isArray(input[1]) || typeof input[1] === "function")) {
      setProjects(input[1] as Project[] | ((draft: Project[]) => Project[]))
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const sessionTodoKey = (directory: string, sessionID: string) => `${directoryKey(directory)}\n${sessionID}`

  const setSessionTodo = (directory: string, sessionID: string, todos: Todo[] | undefined) => {
    if (!directory || !sessionID) return
    const key = sessionTodoKey(directory, sessionID)
    if (!todos) {
      setGlobalStore(
        "session_todo",
        produce((draft) => {
          delete draft[key]
        }),
      )
      return
    }
    setGlobalStore("session_todo", key, reconcile(todos, { key: "id" }))
  }

  const getSessionTodo = (directory: string, sessionID: string) => {
    if (!directory || !sessionID) return undefined
    return globalStore.session_todo[sessionTodoKey(directory, sessionID)]
  }

  const setSessionTurnCompletion = (directory: string, sessionID: string, status: TurnCompletionStatus | undefined) => {
    if (!directory || !sessionID) return
    const key = sessionTodoKey(directory, sessionID)
    if (!status) {
      setSessionTurnCompletionStore(
        "value",
        produce((draft) => {
          delete draft[key]
        }),
      )
      return
    }
    setSessionTurnCompletionStore("value", key, status)
  }

  const getSessionTurnCompletion = (directory: string, sessionID: string) => {
    if (!directory || !sessionID) return undefined
    return globalStore.session_turn_completion[sessionTodoKey(directory, sessionID)]
  }

  const paused = () => untrack(() => globalStore.reload) !== undefined

  const queue = createRefreshQueue({
    paused,
    key: directoryKey,
    bootstrap: () => queryClient.fetchQuery({ queryKey: [serverSDK.scope, "bootstrap"] }),
    bootstrapInstance,
  })

  const sidebarIndicatorLoader = createSerialDirectoryLoader({ load: refreshPassiveSidebarIndicators })
  let statusReconciliationScope = sessionStatusReconciliationScope({
    activeDirectory: "",
    visibleDirectories: [],
    activeSessionMessagesReady: false,
    pageVisible: false,
    hasSessions: false,
  })
  const children = createChildStoreManager({
    owner,
    scope: serverSDK.scope,
    persist: persisted,
    isBooting: (directory) => booting.has(directory),
    isLoadingSessions: (directory) => sessionLoads.has(directory),
    onBootstrap: (directory) => {
      void bootstrapInstance(directory)
    },
    onMcp: (directory, setStore) => {
      void retry(() =>
        sdkFor(directory)
          .v2.command.list()
          .then((x) => setStore("command", normalizeCommandList(x.data?.data ?? []))),
      ).catch((err) => {
        if (isCancellationError(err)) return
        showToast({
          variant: "error",
          title: language.t("toast.project.reloadFailed.title", { project: getFilename(directory) }),
          description: formatServerError(err, language.t),
        })
      })
    },
    onDispose: (directory) => {
      const key = directoryKey(directory)
      sidebarIndicatorLoader.forget(directory)
      queue.clear(key)
      sessionMeta.delete(key)
      locallyCreatedSessionIDs.delete(key)
      retainedSessionIDs.delete(key)
      sdkCache.delete(key)
      clearProviderRev(serverSDK.scope, directory)
      clearSessionPrefetchDirectory(serverSDK.scope, directory)
    },
    initialSessionLimit: readSidebarSessionLimit,
    translate: language.t,
    queryOptions: queryOptionsApi,
    global: {
      provider: () => globalStore.provider,
    },
  })

  const knownSessionDirectory = (sessionID: string) =>
    sessionDirectoryInStores({
      directories: Object.entries(children.children).map(([key, store]) => [children.sourceDirectory(key), store[0]]),
      sessionID,
    })

  // Events published outside any instance arrive without a transport directory.
  // Re-key them onto the real project scope before they reach any emitter. The
  // transport routing already learned placement from session metadata payloads;
  // this store lookup covers sessions the app already knows.
  serverSDK.event.resolveSessionScope((payload) => {
    const ref = globalScopeSessionRef(payload)
    if (!ref || "directory" in ref) return ref?.directory
    return knownSessionDirectory(ref.sessionID)
  })

  async function loadSessions(directory: string, options?: { limit?: number; signal?: AbortSignal }) {
    options?.signal?.throwIfAborted()
    const key = directoryKey(directory)
    const pending = sessionLoads.get(key)
    if (pending) {
      await waitForSharedSessionLoad(pending, options?.signal)
      return loadSessions(directory, options)
    }

    children.pin(key)
    const [store, setStore] = children.child(directory, { bootstrap: false })
    const meta = sessionMeta.get(key)
    const retainedLimit = Math.max(store.limit, options?.limit ?? 0, meta?.limit ?? 0)
    const preserve = sessionTrimPreserveIDs({
      retained: new Set(retainedSessionIDs.get(key)?.keys()),
      status: store.session_status,
      permission: store.permission,
      question: store.question,
    })
    if (meta && meta.limit >= retainedLimit) {
      const next = trimSessions(store.session, {
        limit: retainedLimit,
        permission: store.permission,
        preserve,
      })
      if (next.length !== store.session.length) {
        setStore(
          "session",
          produce((draft) => replaceSessionList(draft, next)),
        )
        cleanupDroppedSessionCaches(store, setStore, next, directory, setSessionTodo, setSessionTurnCompletion)
      }
      children.unpin(key)
      return
    }

    const limit = Math.max(retainedLimit + SESSION_RECENT_LIMIT, SESSION_RECENT_LIMIT)
    const initialSessionIDs = new Set(store.session.map((session) => session.id))
    const controller = new AbortController()
    const promise = queryClient
      .fetchQuery({
        ...queryOptionsApi.sessions(key),
        queryFn: ({ signal: querySignal }) => {
          const signal = AbortSignal.any([querySignal, controller.signal])
          return loadRootSessionsWithFallback({
            directory,
            limit,
            signal,
            list: (query) => serverSDK.client.session.list(query, { signal }),
          })
            .then((x) => {
              const nonArchived = (x.data ?? [])
                .filter((s) => !!s?.id)
                .filter((s) => !s.time?.archived)
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              const limit = Math.max(store.limit, options?.limit ?? 0, sessionMeta.get(key)?.limit ?? 0)
              const merged = mergeLoadedSessions({
                loaded: nonArchived,
                current: store.session,
                initialIDs: initialSessionIDs,
                preserveIDs: locallyCreatedSessionIDs.get(key),
              })
              const sessions = trimSessions(merged, {
                limit,
                permission: store.permission,
                preserve: sessionTrimPreserveIDs({
                  retained: new Set(retainedSessionIDs.get(key)?.keys()),
                  status: store.session_status,
                  permission: store.permission,
                  question: store.question,
                }),
              })
              const createdRoots = merged.filter(
                (session) => !session.parentID && !initialSessionIDs.has(session.id) && !nonArchived.includes(session),
              ).length
              batch(() => {
                setStore(
                  "sessionTotal",
                  estimateRootSessionTotal({
                    count: nonArchived.length,
                    limit: x.limit,
                    limited: x.limited,
                  }) + createdRoots,
                )
                setStore(
                  "session",
                  produce((draft) => replaceSessionList(draft, sessions)),
                )
                cleanupDroppedSessionCaches(
                  store,
                  setStore,
                  sessions,
                  directory,
                  setSessionTodo,
                  setSessionTurnCompletion,
                )
              })
              const confirmed = locallyCreatedSessionIDs.get(key)
              for (const session of nonArchived) confirmed?.delete(session.id)
              if (confirmed?.size === 0) locallyCreatedSessionIDs.delete(key)
              sessionMeta.set(key, { limit })
            })
            .catch((err) => {
              if (isCancellationError(err)) return
              console.error("Failed to load sessions", err)
              const project = getFilename(directory)
              showToast({
                variant: "error",
                title: language.t("toast.session.listFailed.title", { project }),
                description: formatServerError(err, language.t),
              })
              throw err
            })
            .then(() => null)
        },
      })
      .catch(() => {})
      .then(() => {})

    const load = { promise, controller, consumers: new Set<symbol>() }
    sessionLoads.set(key, load)
    void promise.finally(() => {
      sessionLoads.delete(key)
      children.unpin(key)
    })
    return waitForSharedSessionLoad(load, options?.signal)
  }

  function loadSessionStatus(directory: string) {
    const key = directoryKey(directory)
    const pending = sessionStatusLoads.get(key)
    if (pending) return pending
    const generations = sessionActivityGenerationSnapshot(directory)
    const promise = sdkFor(directory)
      .session.status()
      .then((response) => ({ data: response.data ?? {}, generations }))
      .finally(() => {
        if (sessionStatusLoads.get(key) === promise) sessionStatusLoads.delete(key)
      })
    sessionStatusLoads.set(key, promise)
    return promise
  }

  function refreshSessionStatus(directory: string, sessionID: string) {
    if (statusLifecycle.disposed) return Promise.resolve()
    const [store, setStore] = children.child(directory, { bootstrap: false })
    if (store.session_status[sessionID]?.type === "idle") return Promise.resolve()
    return loadSessionStatus(directory).then((snapshot) => {
      if (statusLifecycle.disposed) return
      const status = reconcileSessionStatusSnapshot({
        directory,
        sessionID,
        generations: snapshot.generations,
        incoming: snapshot.data[sessionID],
        store,
      })
      if (!status) return
      setStore("session_status", sessionID, status)
      if (status.type !== "idle") setSessionTurnCompletion(directory, sessionID, undefined)
    })
  }

  async function loadSessionInfo(directory: string, sessionID: string) {
    const [store, setStore] = children.child(directory, { bootstrap: false })
    const existing = store.session.find((session) => session.id === sessionID)
    if (existing) return existing
    const session = await sdkFor(directory)
      .session.get({ sessionID })
      .then((response) => response.data)
      .catch((error) => recoverMissingSessionInfo(error, () => forgetSession(directory, sessionID)))
    if (!session?.id) return
    setStore(
      "session",
      produce((draft) => mergeSessionList(draft, session)),
    )
    return session
  }

  function applyDirectorySessionStatus(directory: string, snapshot: SessionStatusSnapshot) {
    const [store, setStore] = children.child(directory, { bootstrap: false })
    const sessionIDs = sessionIDsForStatusRecovery(directory, store)
    batch(() => {
      for (const sessionID of new Set([...sessionIDs, ...Object.keys(snapshot.data)])) {
        const status = reconcileSessionStatusSnapshot({
          directory,
          sessionID,
          generations: snapshot.generations,
          incoming: snapshot.data[sessionID],
          store,
        })
        if (!status) continue
        setStore("session_status", sessionID, status)
        if (status.type !== "idle") setSessionTurnCompletion(directory, sessionID, undefined)
      }
    })
  }

  function refreshDirectorySessionStatus(directory: string) {
    if (statusLifecycle.disposed) return Promise.resolve()
    return loadSessionStatus(directory).then((snapshot) => {
      if (statusLifecycle.disposed) return
      applyDirectorySessionStatus(directory, snapshot)
    })
  }

  async function refreshPassiveSidebarIndicators(
    directory: string,
    options: { signal: AbortSignal; canContinue: () => boolean },
  ) {
    const key = directoryKey(directory)
    const existing = children.existing(key)
    if (statusLifecycle.disposed) return false
    if (children.bootstrapped(key)) return true
    if (!existing || existing[0].session.length === 0 || !options.canContinue()) return false

    const sdk = sdkFor(directory)
    return withAbortableDeadline({
      signal: options.signal,
      timeoutMs: PASSIVE_SIDEBAR_REQUEST_TIMEOUT_MS,
      run: async (signal) => {
        const canProceed = () => !signal.aborted && !statusLifecycle.disposed && options.canContinue()
        if (!canProceed()) return false
        const [store, setStore] = children.child(directory, { bootstrap: false })
        const revisions = {
          permission: permissionRevision(store),
          question: questionRevision(store),
        }
        const generations = sessionActivityGenerationSnapshot(directory)
        const statusLoaded = await loadPassiveSessionStatus(sdk, directory, signal)
          .then((response) => {
            if (!canProceed()) return false
            applyDirectorySessionStatus(directory, { data: response.data ?? {}, generations })
            return true
          })
          .catch((error) => {
            if (!canProceed()) return false
            console.warn("Failed to load passive session status", directory, error)
            return false
          })
        if (!canProceed()) return false
        if (children.bootstrapped(key)) return true

        const permissions = await loadPendingPermissions(sdk, directory, signal).catch((error) => {
          if (canProceed()) console.warn("Failed to load passive session permissions", directory, error)
          return undefined
        })
        if (!canProceed()) return false
        if (children.bootstrapped(key)) return true

        const questions = await loadPendingQuestions(sdk, directory, signal).catch((error) => {
          if (canProceed()) console.warn("Failed to load passive session questions", directory, error)
          return undefined
        })
        if (!canProceed()) return false
        if (children.bootstrapped(key)) return true

        const sessionIDs = [
          ...new Set([...(permissions?.pending ?? []), ...(questions?.pending ?? [])].map((request) => request.sessionID)),
        ]
        const sessionsComplete = await sessionIDs.reduce(
          (pending, sessionID) =>
            pending.then(async (complete) => {
              if (!canProceed()) return false
              if (store.session.some((session) => session.id === sessionID)) return complete
              const session = await loadPassiveSessionInfo(sdk, sessionID, signal)
                .then((response) => response.data)
                .catch((error) => {
                  if (canProceed()) console.warn("Failed to load passive session info", directory, sessionID, error)
                  return undefined
                })
              if (!session?.id || !canProceed()) return false
              setStore(
                "session",
                produce((draft) => mergeSessionList(draft, session)),
              )
              return complete
            }),
          Promise.resolve(true),
        )

        if (!canProceed()) return false
        if (children.bootstrapped(key)) return true

        const inDirectory = (sessionID: string) => {
          const session = store.session.find((item) => item.id === sessionID)
          return !!session?.directory && directoryKey(session.directory) === key
        }
        batch(() => {
          if (permissions) {
            const grouped = mergePendingRequests({
              pending: permissions.pending,
              current: Object.values(store.permission).flat(),
              complete: permissions.complete,
              inDirectory,
              changedAfter: (requestID) => permissionChangedAfter(store, requestID, revisions.permission),
            })
            for (const sessionID of Object.keys(store.permission)) {
              if (grouped[sessionID] || !inDirectory(sessionID)) continue
              setStore("permission", sessionID, [])
            }
            for (const [sessionID, requests] of Object.entries(grouped)) {
              setStore("permission", sessionID, reconcile(requests.sort((a, b) => cmp(a.id, b.id)), { key: "id" }))
            }
          }
          if (questions) {
            const grouped = mergePendingRequests({
              pending: questions.pending,
              current: Object.values(store.question).flat(),
              complete: questions.complete,
              inDirectory,
              changedAfter: (requestID) => questionChangedAfter(store, requestID, revisions.question),
            })
            for (const sessionID of Object.keys(store.question)) {
              if (grouped[sessionID] || !inDirectory(sessionID)) continue
              setStore("question", sessionID, [])
            }
            for (const [sessionID, requests] of Object.entries(grouped)) {
              setStore("question", sessionID, reconcile(requests.sort((a, b) => cmp(a.id, b.id)), { key: "id" }))
            }
          }
        })
        return statusLoaded && permissions?.complete === true && questions?.complete === true && sessionsComplete
      },
    }).catch((error) => {
      if (!options.signal.aborted && !statusLifecycle.disposed)
        console.warn("Failed to refresh passive session indicators", directory, error)
      return false
    })
  }

  async function loadProjectConfig(directory: string) {
    const config = await retry(() =>
      sdkFor(directory)
        .config.get()
        .then((x) => x.data!),
    )
    children.ensureChild(directory)[1]("config", reconcile(config, { merge: false }))
    return config
  }

  async function loadGlobalConfig() {
    const config = await retry(() => serverSDK.client.global.config.get().then((x) => x.data!))
    queryClient.setQueryData(queryOptionsApi.globalConfig().queryKey, config)
    return config
  }

  async function bootstrapInstance(directory: string, options?: { sessions?: boolean }) {
    const key = directoryKey(directory)
    if (!key) return
    const sessions = options?.sessions !== false
    const pending = booting.get(key)
    if (pending) {
      if (!sessions) return pending.promise
      const previous = pending.promise
      const promise = withBootstrapSessions(pending, () => loadSessions(directory))
      if (promise === previous) return promise
      void promise.then(
        () => finishBootstrap(key, pending, promise),
        () => finishBootstrap(key, pending, promise),
      )
      return promise
    }

    children.pin(key)
    const run = { promise: Promise.resolve(), sessions } satisfies BootstrapRun
    const promise = Promise.resolve().then(async () => {
      const child = children.ensureChild(directory)
      const cache = children.vcsCache.get(key)
      if (!cache) return
      const sdk = sdkFor(directory)
      await bootstrapDirectory({
        directory,
        scope: serverSDK.scope,
        mcp: children.mcp(key),
        global: {
          config: globalStore.config,
          path: globalStore.path,
          project: globalStore.project,
          provider: globalStore.provider,
        },
        sdk,
        loadSessionStatus: () => refreshDirectorySessionStatus(directory),
        store: child[0],
        setStore: child[1],
        vcsCache: cache,
        loadSessions: sessions ? loadSessions : () => undefined,
        translate: language.t,
        queryClient,
      })
    })

    run.promise = promise
    booting.set(key, run)
    void promise.then(
      () => finishBootstrap(key, run, promise),
      () => finishBootstrap(key, run, promise),
    )
    return promise
  }

  function finishBootstrap(key: string, run: BootstrapRun, promise: Promise<void>) {
    if (booting.get(key) !== run || run.promise !== promise) return
    booting.delete(key)
    children.unpin(key)
  }

  const applyServerEvent = (e: { name: string; details: { type: string; properties?: unknown } }) => {
    const directory = e.name
    const key = directoryKey(directory)
    const type = e.details.type.replace(/\.\d+$/, "")
    const event = type === e.details.type ? e.details : { ...e.details, type }
    const recent = bootingRoot || Date.now() - bootedAt < 1500

    if (event.type === "mcp.tools.changed") {
      queryClient.invalidateQueries({ queryKey: [serverSDK.scope, key, "mcp"] })
    }

    if (directory === "global") {
      applyGlobalEvent({
        event,
        project: globalStore.project,
        refresh: () => {
          if (recent) return
          bootstrap.refetch()
        },
        setGlobalProject: setProjects,
      })
      if (event.type === "global.disposed") {
        if (recent) return
        for (const key of Object.keys(children.children)) {
          if (!children.bootstrapped(key)) continue
          queue.push(children.sourceDirectory(key))
        }
      }
      return
    }

    // Status events belong to the directory, not to the currently selected route. Keep a
    // lightweight store for them so an inactive session tab cannot miss its terminal state.
    const existing = directoryStoreForEvent({
      existing: children.children[key],
      type: event.type,
      createLightweight: () => children.peek(directory, { bootstrap: false }),
    })
    if (!existing) return
    children.mark(key)
    const [store, setStore] = existing
    applyDirectoryEvent({
      event,
      directory: children.sourceDirectory(key),
      store,
      setStore,
      push: queue.push,
      setSessionTodo,
      setSessionTurnCompletion,
      retainedLimit: sessionMeta.get(key)?.limit,
      preserveSessionIDs: new Set(retainedSessionIDs.get(key)?.keys()),
      vcsCache: children.vcsCache.get(key),
      loadLsp: () => {
        void queryClient.fetchQuery(queryOptionsApi.lsp(key, children.sourceDirectory(key)))
      },
    })
  }

  const unsub = serverSDK.event.listen((e) => {
    applyServerEvent(e)
  })
  const unsubSync = serverSDK.sync.listen((e) => {
    const event = sessionTabSyncEvent(e.details)
    if (!event) return
    applyServerEvent({ name: e.name, details: event })
  })
  void serverSDK.event.start()

  onCleanup(unsub)
  onCleanup(unsubSync)
  onCleanup(() => {
    queue.dispose()
    sidebarIndicatorLoader.dispose()
  })
  onCleanup(() => {
    for (const directory of Object.keys(children.children)) {
      children.disposeDirectory(directoryKey(directory))
    }
  })

  const refreshSessionStatuses = (activeOnly: boolean) => {
    for (const key of Object.keys(children.children)) {
      const child = children.children[key]
      if (!child) continue
      const directory = children.sourceDirectory(key)
      if (
        !shouldRefreshDirectoryStatus({
          directory,
          store: child[0],
          activeOnly,
          scope: statusReconciliationScope,
        })
      )
        continue
      void refreshDirectorySessionStatus(directory).catch(() => {})
    }
  }

  createEffect(() => {
    if (serverSDK.event.reconnect() === 0) return
    refreshSessionStatuses(false)
  })

  onMount(() => {
    const timer = setInterval(() => refreshSessionStatuses(true), SESSION_STATUS_POLL_INTERVAL_MS)
    const reconciliationTimer = setInterval(
      () => refreshSessionStatuses(false),
      SESSION_STATUS_RECONCILIATION_INTERVAL_MS,
    )
    onCleanup(() => {
      clearInterval(timer)
      clearInterval(reconciliationTimer)
    })
  })

  const projectApi = {
    loadSessions,
    loadConfig: loadProjectConfig,
    meta(directory: string, patch: ProjectMeta) {
      children.projectMeta(directory, patch)
    },
    icon(directory: string, value: string | undefined) {
      children.projectIcon(directory, value)
    },
  }

  const updateConfigMutation = useMutation(() => ({
    mutationFn: (config: ConfigUpdate) => updateGlobalConfig(serverSDK.client, config),
    onSuccess: (result, config) => {
      if (result.data) queryClient.setQueryData(queryOptionsApi.globalConfig().queryKey, result.data)
      if (!shouldRefreshCatalogsAfterConfigUpdate(config)) return
      bootstrap.refetch()
      // Invalidate all provider queries so newly configured custom providers
      // appear immediately in the available provider list across all directories.
      queryClient.invalidateQueries({ queryKey: [serverSDK.scope, null, "providers"] })
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === serverSDK.scope && query.queryKey[2] === "providers",
      })
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === serverSDK.scope && query.queryKey[2] === "mcp",
      })
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === serverSDK.scope && query.queryKey[2] === "agents",
      })
    },
  }))
  const configWrites = { tail: Promise.resolve() }
  const updateConfig = (input: ConfigUpdate | ((current: Config) => ConfigUpdate)) => {
    const update = configWrites.tail.then(() =>
      updateConfigMutation.mutateAsync(typeof input === "function" ? input(globalStore.config) : input),
    )
    configWrites.tail = update.then(
      () => undefined,
      () => undefined,
    )
    return update
  }

  const updateProjectConfigMutation = useMutation(() => ({
    mutationFn: (input: { directory: string; config: Config }) =>
      sdkFor(input.directory).config.update({ directory: input.directory, config: input.config }),
    onSuccess: (_, input) => {
      children.existing(input.directory)?.[1]("config", (current) => ({ ...current, ...input.config }))
      bootstrap.refetch()
      queryClient.invalidateQueries({ queryKey: [serverSDK.scope, directoryKey(input.directory), "mcp"] })
      queryClient.invalidateQueries({ queryKey: [serverSDK.scope, directoryKey(input.directory), "providers"] })
    },
  }))

  const forgetSession = (directory: string, sessionID: string) => {
    const key = directoryKey(directory)
    retainedSessionIDs.get(key)?.delete(sessionID)
    if (retainedSessionIDs.get(key)?.size === 0) retainedSessionIDs.delete(key)
    locallyCreatedSessionIDs.get(key)?.delete(sessionID)
    if (locallyCreatedSessionIDs.get(key)?.size === 0) locallyCreatedSessionIDs.delete(key)
    children.existing(directory)?.[1](
      "session",
      produce((draft) => {
        const index = draft.findIndex((session) => session.id === sessionID)
        if (index >= 0) draft.splice(index, 1)
      }),
    )
  }

  return {
    data: globalStore,
    set,
    // True only after the global config query succeeded. A failed or pending
    // startup fetch leaves server state unknown, and chain hydration must not
    // treat that as "the server confirmed nothing".
    get configLoaded() {
      return configQuery.isSuccess
    },
    // A settled initial failure permits read-only chain management, but never
    // counts as hydration or authorizes chain writes.
    get configFailed() {
      return configQuery.isError && !configQuery.isFetching
    },
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    child: children.child,
    peek: children.peek,
    existing: children.existing,
    refresh: (directory: string) => bootstrapInstance(directory, { sessions: false }),
    setSessionStatusReconciliationScope: (input: Parameters<typeof sessionStatusReconciliationScope>[0]) => {
      statusReconciliationScope = sessionStatusReconciliationScope(input)
    },
    loadVisibleSidebarIndicators: (directories: string[], eligible: (directory: string) => boolean) =>
      sidebarIndicatorLoader.enqueue(directories, eligible),
    refreshProviders: (directory: string) => {
      const key = directoryKey(directory)
      return retryFailedProviderQueries(queryClient, [
        queryOptionsApi.providers(null),
        ...(key ? [queryOptionsApi.providers(key, directory)] : []),
      ])
    },
    disableMcp: children.disableMcp,
    queryOptions: queryOptionsApi,
    // bootstrap,
    loadConfig: loadGlobalConfig,
    updateConfig,
    updateProjectConfig: updateProjectConfigMutation.mutateAsync,
    session: {
      info: loadSessionInfo,
      refreshStatus: refreshSessionStatus,
      retain(directory: string, sessionID: string) {
        const key = directoryKey(directory)
        const retained = retainedSessionIDs.get(key) ?? new Map<string, number>()
        retained.set(sessionID, (retained.get(sessionID) ?? 0) + 1)
        retainedSessionIDs.set(key, retained)
      },
      release(directory: string, sessionID: string) {
        const key = directoryKey(directory)
        const retained = retainedSessionIDs.get(key)
        if (!retained) return
        const count = retained.get(sessionID) ?? 0
        if (count > 1) {
          retained.set(sessionID, count - 1)
          return
        }
        retained.delete(sessionID)
        if (retained.size === 0) retainedSessionIDs.delete(key)
      },
      seed(directory: string, info: Session) {
        const key = directoryKey(directory)
        const ids = locallyCreatedSessionIDs.get(key)
        if (ids) ids.add(info.id)
        if (!ids) locallyCreatedSessionIDs.set(key, new Set([info.id]))
        const [, setStore] = children.child(directory, { bootstrap: false })
        setStore(
          "session",
          produce((draft) => mergeSessionList(draft, info)),
        )
      },
      forget: forgetSession,
    },
    project: projectApi,
    todo: {
      get: getSessionTodo,
      set: setSessionTodo,
    },
    turnCompletion: {
      get: getSessionTurnCompletion,
      set: setSessionTurnCompletion,
    },
    mcp: {
      starter: async (prompt: string) => {
        const response = await serverSDK.client.mcp.starter({ prompt })
        if (!response.data) throw new Error("Could not generate MCP server config")
        return response.data
      },
      startSetupSession: async (input: string, directory: string) => {
        const client = serverSDK.createClient({ directory, throwOnError: true })
        const model = mcpSetupSessionModel(globalStore.config)
        const session = await client.v2.session.create({
          agent: "build",
          ...(model ? { model } : {}),
          location: { directory },
        })
        if (!session.data) throw new Error("Could not start MCP setup session")
        await client.v2.session.prompt({
          sessionID: session.data.data.id,
          agent: "build",
          ...(model ? { model } : {}),
          prompt: {
            text: `Configure this MCP server request for OpenCode, verify the generated configuration, and report the test result. If the input is a URL to a project or documentation page, inspect what the correct MCP endpoint should be instead of blindly using the pasted URL. If the input is a command, reason about whether it can start an MCP server. If you edit OpenCode config directly, use the mcp-config-reload skill at the end so the running app and Settings MCP tab refresh. Input:\n\n${input}`,
          },
        })
        return session.data.data.id
      },
      addAndConnect: async (name: string, config: McpLocalConfig | McpRemoteConfig) => {
        const response = await serverSDK.client.mcp.add({ name, config })
        if (!response.data) throw new Error("Could not add MCP server")
        await serverSDK.client.mcp.connect({ name })
        const status = await serverSDK.client.mcp.status()
        return status.data?.[name]
      },
      disconnect: async (name: string) => {
        await serverSDK.client.mcp.disconnect({ name })
      },
      toggle: async (directory: string, name: string) => {
        const key = directoryKey(directory)
        const sdk = sdkFor(directory)
        const status = children.child(directory, { bootstrap: false })[0].mcp[name].status
        await toggleMcp({
          status,
          connect: async () => {
            await sdk.mcp.connect({ name })
          },
          disconnect: async () => {
            await sdk.mcp.disconnect({ name })
          },
          authenticate: async () => {
            await sdk.mcp.auth.authenticate({ name })
          },
          refresh: async () => {
            await queryClient.refetchQueries(queryOptionsApi.mcp(key, directory))
          },
        })
      },
      setAvailability: async (directory: string, name: string, enabled: boolean) => {
        const key = directoryKey(directory)
        const sdk = sdkFor(directory)
        if (enabled) await sdk.mcp.connect({ name })
        else await sdk.mcp.disconnect({ name })
        await queryClient.refetchQueries(queryOptionsApi.mcp(key, directory))
      },
    },
  }
}

export function createServerSyncContext(serverSDK: ServerSDK) {
  const inner = createServerSyncContextInner(serverSDK)
  return Object.assign(inner, {
    createDirSyncContext: createRefCountMap(
      (dir) => createDirSyncContext(dir, inner, serverSDK),
      (dir) => inner.disableMcp(dir),
      directoryKey,
    ),
  })
}

export type ServerSync = ReturnType<typeof createServerSyncContext>

export const { use: useServerSync, provider: ServerSyncProvider } = createSimpleContext({
  name: "ServerSync",
  // Returns an accessor so the resolved server can change reactively without
  // re-instantiating the subtree (mirrors useServerSDK).
  init: (props: { server?: Accessor<ServerConnection.Any | undefined> }) => {
    const global = useGlobal()
    const language = useLanguage()
    const server = useServer()

    return createMemo<ServerSync>(() => {
      const conn = props.server?.() ?? server.current
      if (!conn) throw new Error(language.t("error.serverSDK.noServerAvailable"))
      return global.createServerCtx(conn).sync
    })
  },
})

export function useQueryOptions() {
  const sync = useServerSync()
  return createMemo(() => sync().queryOptions)
}
