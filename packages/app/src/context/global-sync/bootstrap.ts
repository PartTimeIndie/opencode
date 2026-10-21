import type {
  Config,
  OpencodeClient,
  Path,
  Project,
  ProviderAuthResponse,
  SurfaceRequest,
  Session,
  Todo,
} from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import type { TurnCompletionStatus } from "@/utils/session-status"
import { getFilename } from "@opencode-ai/core/util/path"
import { retry } from "@opencode-ai/core/util/retry"
import { batch } from "solid-js"
import { produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type { State, VcsCache } from "./types"
import { cmp, normalizeAgentList, normalizeCommandList, normalizeProviderList } from "./utils"
import { formatServerError, isCancellationError } from "@/utils/server-errors"
import { QueryClient, queryOptions } from "@tanstack/solid-query"
import { loadMcpQuery } from "../server-sync"
import { NormalizedProviderListResponse } from "@opencode-ai/ui/context"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"
import { directoryKey } from "@/utils/path-key"
import { questionChangedAfter, questionRevision } from "./question-revision"
import { permissionChangedAfter, permissionRevision } from "./permission-revision"
import { loadPendingPermissions } from "../permission-request"
import { loadPendingQuestions } from "../question-request"
import { sessionActivityDirectoryGeneration } from "@/utils/session-activity"
import { mergeSessionList } from "./session-list"

type GlobalStore = {
  ready: boolean
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

function waitForPaint() {
  return new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    const timer = setTimeout(finish, 50)
    if (typeof requestAnimationFrame !== "function") return
    requestAnimationFrame(() => {
      setTimeout(() => {
        clearTimeout(timer)
        finish()
      }, 0)
    })
  })
}

function errors(list: PromiseSettledResult<unknown>[]) {
  return list
    .filter((item): item is PromiseRejectedResult => item.status === "rejected")
    .map((item) => item.reason)
    .filter((error) => !isCancellationError(error))
}

const providerRev = new Map<string, number>()
const PROVIDER_DISCOVERY_TIMEOUT_MS = 240_000

export function clearProviderRev(scope: ServerScope, directory: string) {
  providerRev.delete(ScopedKey.from(scope, directory))
}

function runAll(list: Array<() => Promise<unknown>>) {
  return Promise.allSettled(list.map((item) => item()))
}

export function bootstrapFeedbackErrors(errors: unknown[], handledErrors: Set<unknown>) {
  return errors.filter((error) => !handledErrors.has(error))
}

function showErrors(input: {
  errors: unknown[]
  title: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
}) {
  if (input.errors.length === 0) return
  const message = formatServerError(input.errors[0], input.translate)
  const more = input.errors.length > 1 ? input.formatMoreCount(input.errors.length - 1) : ""
  showToast({
    variant: "error",
    title: input.title,
    description: message + more,
  })
}

export const loadGlobalConfigQuery = (scope: ServerScope, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [scope, "config"],
    queryFn: ({ signal }) => retry(() => sdk.global.config.get({ signal }).then((x) => x.data!)),
  })

export const loadProjectsQuery = (scope: ServerScope, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [scope, "project"],
    queryFn: ({ signal }) =>
      retry(() =>
        sdk.project.list({}, { signal }).then((x) => {
          return (x.data ?? [])
            .filter((p) => !!p?.id)
            .filter((p) => !!p.worktree && !p.worktree.includes("opencode-test"))
            .slice()
            .sort((a, b) => cmp(a.id, b.id))
        }),
      ),
  })

export async function bootstrapGlobal(input: {
  serverSDK: OpencodeClient
  scope: ServerScope
  requestFailedTitle: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
  setGlobalStore: SetStoreFunction<GlobalStore>
  queryClient: QueryClient
}) {
  const slow = [
    () => input.queryClient.fetchQuery(loadGlobalConfigQuery(input.scope, input.serverSDK)),
    () => input.queryClient.fetchQuery(loadProvidersQuery(input.scope, null, input.serverSDK)),
    () => input.queryClient.fetchQuery(loadPathQuery(input.scope, null, input.serverSDK)),
    () =>
      input.queryClient
        .fetchQuery(loadProjectsQuery(input.scope, input.serverSDK))
        .then((data) => input.setGlobalStore("project", data)),
  ]
  await runAll(slow)
  // showErrors({
  //   errors: errors(),
  //   title: input.requestFailedTitle,
  //   translate: input.translate,
  //   formatMoreCount: input.formatMoreCount,
  // })
}

function groupBySession<T extends { id: string; sessionID: string }>(input: T[]) {
  return input.reduce<Record<string, T[]>>((acc, item) => {
    if (!item?.id || !item.sessionID) return acc
    const list = acc[item.sessionID]
    if (list) list.push(item)
    if (!list) acc[item.sessionID] = [item]
    return acc
  }, {})
}

function projectID(directory: string, projects: Project[]) {
  const key = directoryKey(directory)
  return projects.find(
    (project) =>
      directoryKey(project.worktree) === key || project.sandboxes?.some((sandbox) => directoryKey(sandbox) === key),
  )?.id
}

function sessionInDirectory(store: Store<State>, sessionID: string, directory: string) {
  const session = store.session.find((item) => item.id === sessionID)
  if (!session?.directory) return false
  return directoryKey(session.directory) === directoryKey(directory)
}

function mergeSession(setStore: SetStoreFunction<State>, session: Session) {
  setStore(
    "session",
    produce((draft) => mergeSessionList(draft, session)),
  )
}

function warmSessions(input: {
  ids: string[]
  store: Store<State>
  setStore: SetStoreFunction<State>
  sdk: OpencodeClient
}) {
  const known = new Set(input.store.session.map((item) => item.id))
  const ids = [...new Set(input.ids)].filter((id) => !!id && !known.has(id))
  if (ids.length === 0) return Promise.resolve()
  return Promise.all(
    ids.map((sessionID) =>
      retry(() => input.sdk.session.get({ sessionID })).then((x) => {
        const session = x.data
        if (!session?.id) return
        mergeSession(input.setStore, session)
      }),
    ),
  ).then(() => undefined)
}

export const loadProvidersQuery = (scope: ServerScope, directory: string | null, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [scope, directory === null ? null : directoryKey(directory), "providers"],
    // retry() handles transient provider errors; a second query-level retry loop
    // delays the visible error and can multiply plugin discovery work.
    retry: false,
    // A remounted observer must not restart a failed plugin discovery. Bootstrap
    // and the explicit retry action own the next request.
    retryOnMount: false,
    queryFn: ({ signal }) => {
      const timeout = AbortSignal.timeout(PROVIDER_DISCOVERY_TIMEOUT_MS)
      return retry(() =>
        sdk.provider
          // Provider discovery can load several local plugins for multiple open
          // directories during startup. Use one longer deadline across retries.
          .list({}, { signal: AbortSignal.any([signal, timeout]) })
          .then((x) => normalizeProviderList(x.data!)),
      )
    },
  })

const catalogIndependentConfigKeys = new Set(["model_chains", "default_model_chain", "access_control"])

export function shouldRefreshCatalogsAfterConfigUpdate(config: object) {
  return Object.keys(config).some((key) => !catalogIndependentConfigKeys.has(key))
}

export function retryFailedProviderQueries(
  queryClient: QueryClient,
  queries: ReturnType<typeof loadProvidersQuery>[],
) {
  return Promise.allSettled(
    queries
      .filter((query) => {
        const state = queryClient.getQueryState(query.queryKey)
        return state?.status === "error" && state.fetchStatus !== "fetching"
      })
      .map((query) => queryClient.fetchQuery(query)),
  )
}

export const loadAgentsQuery = (scope: ServerScope, directory: string | null, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [scope, directory === null ? null : directoryKey(directory), "agents"],
    // Agent discovery can outlive a keyed session remount. Let the shared query
    // finish so the directory bootstrap can hydrate its agent store.
    queryFn: () => retry(() => sdk.app.agents().then((x) => normalizeAgentList(x.data))),
  })

export const loadPathQuery = (scope: ServerScope, directory: string | null, sdk: OpencodeClient) =>
  queryOptions<Path>({
    queryKey: [scope, directory === null ? null : directoryKey(directory), "path"],
    queryFn: ({ signal }) => retry(() => sdk.path.get({}, { signal }).then((x) => x.data!)),
  })

export async function bootstrapDirectory(input: {
  directory: string
  scope: ServerScope
  mcp: boolean
  sdk: OpencodeClient
  store: Store<State>
  setStore: SetStoreFunction<State>
  vcsCache: VcsCache
  loadSessions: (directory: string) => Promise<void> | void
  loadSessionStatus?: () => Promise<void>
  translate: (key: string, vars?: Record<string, string | number>) => string
  global: {
    config: Config
    path: Path
    project: Project[]
    provider: NormalizedProviderListResponse
  }
  queryClient: QueryClient
}) {
  const loading = input.store.status !== "complete"
  const seededProject = projectID(input.directory, input.global.project)
  const seededPath =
    directoryKey(input.global.path.directory) === directoryKey(input.directory) ? input.global.path : undefined
  if (seededProject) input.setStore("project", seededProject)
  if (seededPath) input.setStore("path", seededPath)
  if (Object.keys(input.store.config).length === 0 && Object.keys(input.global.config).length > 0) {
    input.setStore("config", reconcile(input.global.config, { merge: false }))
  }
  if (loading) input.setStore("status", "partial")

  const revKey = ScopedKey.from(input.scope, input.directory)
  const rev = (providerRev.get(revKey) ?? 0) + 1
  providerRev.set(revKey, rev)
  const handledErrors = new Set<unknown>()
  const slow = [
    () => Promise.resolve(input.loadSessions(input.directory)),
    () =>
      input.queryClient
        .ensureQueryData(loadAgentsQuery(input.scope, input.directory, input.sdk))
        .then((data) => input.setStore("agent", data)),
    () =>
      retry(() =>
        input.sdk.v2.command
          .list()
          .then((response) => input.setStore("command", normalizeCommandList(response.data?.data ?? []))),
      ),
    () =>
      retry(() => input.sdk.config.get().then((x) => input.setStore("config", reconcile(x.data!, { merge: false })))),
    () => {
      if (input.loadSessionStatus) return input.loadSessionStatus()
      const generation = sessionActivityDirectoryGeneration(input.directory)
      return retry(() => input.sdk.session.status()).then((response) => {
        if (sessionActivityDirectoryGeneration(input.directory) !== generation) return
        input.setStore("session_status", response.data!)
      })
    },
    !seededProject &&
      (() => retry(() => input.sdk.project.current()).then((x) => input.setStore("project", x.data!.id))),
    !seededPath &&
      (() =>
        input.queryClient.ensureQueryData(loadPathQuery(input.scope, input.directory, input.sdk)).then((data) => {
          const next = projectID(data.directory ?? input.directory, input.global.project)
          if (next) input.setStore("project", next)
        })),
    () =>
      retry(() =>
        input.sdk.vcs.get().then((x) => {
          const next = x.data ?? input.store.vcs
          input.setStore("vcs", next)
          if (next) input.vcsCache.setStore("value", next)
        }),
      ),
    () =>
      retry(async () => {
        const revision = permissionRevision(input.store)
        const snapshot = await loadPendingPermissions(input.sdk, input.directory)
        const pending = snapshot.pending
        const ids = pending.map((permission) => permission.sessionID)
        await warmSessions({ ids, store: input.store, setStore: input.setStore, sdk: input.sdk })
        batch(() => {
          const merged = new Map(
            pending
              .filter((permission) => sessionInDirectory(input.store, permission.sessionID, input.directory))
              .filter((permission) => !permissionChangedAfter(input.store, permission.id, revision))
              .map((permission) => [permission.id, permission]),
          )
          Object.values(input.store.permission)
            .flat()
            .filter((permission) => sessionInDirectory(input.store, permission.sessionID, input.directory))
            .filter(
              (permission) =>
                permissionChangedAfter(input.store, permission.id, revision) ||
                (!snapshot.complete && !merged.has(permission.id)),
            )
            .forEach((permission) => merged.set(permission.id, permission))
          const grouped = groupBySession([...merged.values()])
          for (const sessionID of Object.keys(input.store.permission)) {
            if (grouped[sessionID] || !sessionInDirectory(input.store, sessionID, input.directory)) continue
            input.setStore("permission", sessionID, [])
          }
          for (const [sessionID, permissions] of Object.entries(grouped)) {
            input.setStore(
              "permission",
              sessionID,
              reconcile(
                permissions.sort((a, b) => cmp(a.id, b.id)),
                { key: "id" },
              ),
            )
          }
        })
      }),
    () =>
      retry(async () => {
        const revision = questionRevision(input.store)
        const snapshot = await loadPendingQuestions(input.sdk, input.directory)
        const pending = snapshot.pending
        const ids = pending.map((question) => question.sessionID)
        await warmSessions({ ids, store: input.store, setStore: input.setStore, sdk: input.sdk })
        batch(() => {
          const merged = new Map(
            pending
              .filter((question) => sessionInDirectory(input.store, question.sessionID, input.directory))
              .filter((question) => !questionChangedAfter(input.store, question.id, revision))
              .map((question) => [question.id, question]),
          )
          Object.values(input.store.question)
            .flat()
            .filter((question) => sessionInDirectory(input.store, question.sessionID, input.directory))
            .filter(
              (question) =>
                questionChangedAfter(input.store, question.id, revision) ||
                (!snapshot.complete && !merged.has(question.id)),
            )
            .forEach((question) => merged.set(question.id, question))
          const grouped = groupBySession([...merged.values()])
          for (const sessionID of Object.keys(input.store.question)) {
            if (grouped[sessionID] || !sessionInDirectory(input.store, sessionID, input.directory)) continue
            input.setStore("question", sessionID, [])
          }
          for (const [sessionID, questions] of Object.entries(grouped)) {
            input.setStore(
              "question",
              sessionID,
              reconcile(
                questions.sort((a, b) => cmp(a.id, b.id)),
                { key: "id" },
              ),
            )
          }
        })
      }),
    input.mcp && (() => input.queryClient.fetchQuery(loadMcpQuery(input.scope, input.directory, input.sdk))),
    () =>
      input.queryClient
        .fetchQuery(loadProvidersQuery(input.scope, input.directory, input.sdk))
        .catch((error) => {
          if (!isCancellationError(error)) {
            handledErrors.add(error)
          }
          throw error
        }),
  ].filter(Boolean) as (() => Promise<unknown>)[]

  await waitForPaint()
  const slowErrs = errors(await runAll(slow))
  const feedbackErrors = bootstrapFeedbackErrors(slowErrs, handledErrors)
  if (feedbackErrors.length > 0) {
    console.error("Failed to finish bootstrap instance", feedbackErrors[0])
    const project = getFilename(input.directory)
    showToast({
      variant: "error",
      title: input.translate("toast.project.reloadFailed.title", { project }),
      description: formatServerError(feedbackErrors[0], input.translate),
    })
  }

  if (loading && feedbackErrors.length === 0) input.setStore("status", "complete")
}
