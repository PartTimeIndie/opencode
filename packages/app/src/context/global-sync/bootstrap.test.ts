import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { QueryClient } from "@tanstack/solid-query"
import type {
  Config,
  OpencodeClient,
  PermissionRequest,
  PermissionV2Request,
  Project,
  SurfaceBlockingRequest,
  SurfaceRequest,
  Session,
} from "@opencode-ai/sdk/v2/client"
import type { NormalizedProviderListResponse } from "@opencode-ai/ui/context"
import {
  bootstrapDirectory,
  bootstrapFeedbackErrors,
  loadAgentsQuery,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadProjectsQuery,
  loadProvidersQuery,
  retryFailedProviderQueries,
  shouldRefreshCatalogsAfterConfigUpdate,
} from "./bootstrap"
import { modelChainConfig } from "../model-chain"
import type { State, VcsCache } from "./types"
import { ServerScope } from "@/utils/server-scope"
import { applyDirectoryEvent } from "./event-reducer"
import { isV2PermissionRequest } from "../permission-request"
import { isV2SurfaceRequest } from "../question-request"

const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse

describe("global config catalog refresh", () => {
  test("does not restart catalog discovery for model-chain or safety-review writes", () => {
    expect(shouldRefreshCatalogsAfterConfigUpdate(modelChainConfig([], undefined))).toBe(false)
    expect(shouldRefreshCatalogsAfterConfigUpdate({ access_control: { safety_review: {} } })).toBe(false)
  })

  test("keeps refreshing catalogs for provider-related config writes", () => {
    expect(shouldRefreshCatalogsAfterConfigUpdate({ provider: { custom: {} } })).toBe(true)
    expect(shouldRefreshCatalogsAfterConfigUpdate({ disabled_providers: ["custom"] })).toBe(true)
  })
})

describe("bootstrap feedback", () => {
  test("does not duplicate a handled provider failure as a global bootstrap error", () => {
    const providerFailure = new Error("Provider catalog unavailable")
    const otherFailure = new Error("Session status unavailable")
    expect(bootstrapFeedbackErrors([providerFailure], new Set([providerFailure]))).toEqual([])
    expect(bootstrapFeedbackErrors([providerFailure, otherFailure], new Set([providerFailure]))).toEqual([otherFailure])
    expect(bootstrapFeedbackErrors([otherFailure], new Set())).toEqual([otherFailure])
  })
})

function bootstrapState() {
  return createStore<State>({
    status: "loading",
    agent: [],
    command: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider_ready: true,
    provider_error: false,
    provider,
    config: {},
    path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
    session: [],
    sessionTotal: 0,
    session_status: {},
    turnCompletion: {},
    session_working(id: string) {
      return this.session_status[id]?.type !== "idle"
    },
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp_ready: true,
    mcp: {},
    lsp_ready: true,
    lsp: [],
    vcs: undefined,
    limit: 5,
    message: {},
    part: {},
    part_text_accum_delta: {},
  })
}

function question(id: string, sessionID: string, title: string): SurfaceBlockingRequest {
  return { id, sessionID, mode: "blocking", revision: 1, actions: [], questions: [{ question: title }] }
}

function permission(id: string, sessionID: string, title: string): PermissionRequest {
  return { id, sessionID, permission: title, patterns: [title], metadata: {}, always: [title] }
}

function permissionV2(id: string, sessionID: string, action: string): PermissionV2Request {
  return { id, sessionID, action, resources: [action], save: [action] }
}

function session(id: string, directory = "/project"): Session {
  return {
    id,
    slug: id,
    projectID: "project",
    directory,
    title: id,
    version: "test",
    time: { created: 1, updated: 1 },
  }
}

function questionSDK(input: {
  legacy?: SurfaceRequest[]
  current?: SurfaceRequest[]
  legacyPermissions?: PermissionRequest[]
  currentPermissions?: PermissionV2Request[]
  get?: (sessionID: string) => Promise<{ data: Session }>
}) {
  return {
    app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
    config: { get: async () => ({ data: {} }) },
    session: {
      status: async () => ({ data: {} }),
      get: ({ sessionID }: { sessionID: string }) =>
        input.get?.(sessionID) ?? Promise.resolve({ data: session(sessionID) }),
    },
    vcs: { get: async () => ({ data: undefined }) },
    permission: { list: async () => ({ data: input.legacyPermissions ?? [] }) },
    question: { list: async () => ({ data: input.legacy ?? [] }) },
    v2: {
      command: { list: async () => ({ data: { data: [] } }) },
      permission: { request: { list: async () => ({ data: { data: input.currentPermissions ?? [] } }) } },
      surface: { request: { list: async () => ({ data: { data: input.current ?? [] } }) } },
    },
    provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
  } as unknown as OpencodeClient
}

function startQuestionBootstrap(input: {
  store: ReturnType<typeof bootstrapState>[0]
  setStore: ReturnType<typeof bootstrapState>[1]
  sdk: OpencodeClient
  directory?: string
  projectDirectory?: string
  queryClient?: QueryClient
}) {
  const directory = input.directory ?? "/project"
  const projectDirectory = input.projectDirectory ?? directory
  return bootstrapDirectory({
    directory,
    scope: ServerScope.local,
    mcp: false,
    global: {
      config: {} satisfies Config,
      path: { state: "", config: "", worktree: projectDirectory, directory: projectDirectory, home: "/home" },
      project: [{ id: "project", worktree: projectDirectory } as Project],
      provider,
    },
    sdk: input.sdk,
    store: input.store,
    setStore: input.setStore,
    vcsCache: { setStore() {} } as unknown as VcsCache,
    loadSessions() {},
    translate: (key) => key,
    queryClient: input.queryClient ?? new QueryClient(),
  })
}

async function waitForBootstrap(store: ReturnType<typeof bootstrapState>[0]) {
  const deadline = Date.now() + 2_000
  while (store.status !== "complete") {
    if (Date.now() > deadline) throw new Error("Bootstrap did not complete")
    await Bun.sleep(1)
  }
}

describe("bootstrapDirectory", () => {
  test("completes directory bootstrap when its independent provider query fails", async () => {
    const [store, setStore] = bootstrapState()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let providerReads = 0
    let failProviderRead = true
    const sdk = {
      ...questionSDK({}),
      provider: {
        list: async () => {
          providerReads += 1
          if (failProviderRead) throw Object.assign(new Error("Provider catalog unavailable"), { status: 400 })
          return { data: { all: [], connected: [], default: {} } }
        },
      },
    } as unknown as OpencodeClient

    await startQuestionBootstrap({ store, setStore, sdk, queryClient })

    expect(store.status).toBe("complete")
    expect(providerReads).toBe(1)
    expect(queryClient.getQueryState(loadProvidersQuery(ServerScope.local, "/project", sdk).queryKey)?.status).toBe(
      "error",
    )
  })

  test("retries only failed provider scopes and finishes while unrelated bootstrap work is pending", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let globalReads = 0
    let directoryReads = 0
    let recover = false
    let signalRecoveryStarted = () => {}
    let releaseRecovery = () => {}
    const recoveryStarted = new Promise<void>((resolve) => (signalRecoveryStarted = resolve))
    const recoveryGate = new Promise<void>((resolve) => (releaseRecovery = resolve))
    const globalSDK = {
      provider: { list: async () => {
        globalReads++
        return { data: { all: [], connected: [], default: {} } }
      } },
    } as unknown as OpencodeClient
    const directorySDK = {
      provider: { list: async () => {
        directoryReads++
        if (!recover) throw Object.assign(new Error("Directory catalog unavailable"), { status: 400 })
        signalRecoveryStarted()
        await recoveryGate
        return { data: { all: [], connected: [], default: {} } }
      } },
    } as unknown as OpencodeClient
    const globalQuery = loadProvidersQuery(ServerScope.local, null, globalSDK)
    const directoryQuery = loadProvidersQuery(ServerScope.local, "/project", directorySDK)
    await queryClient.fetchQuery(globalQuery)
    await queryClient.fetchQuery(directoryQuery).catch(() => undefined)

    let releaseBootstrap = () => {}
    const unrelatedBootstrap = new Promise<void>((resolve) => (releaseBootstrap = resolve))
    recover = true
    const retry = retryFailedProviderQueries(queryClient, [globalQuery, directoryQuery])
    await recoveryStarted
    await retryFailedProviderQueries(queryClient, [globalQuery, directoryQuery])
    expect(globalReads).toBe(1)
    expect(directoryReads).toBe(2)

    releaseRecovery()
    await retry
    expect(queryClient.getQueryState(directoryQuery.queryKey)?.status).toBe("success")
    expect(globalReads).toBe(1)

    releaseBootstrap()
    await unrelatedBootstrap
  })

  test("retries a failed global provider query without restarting a healthy directory query", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let globalReads = 0
    let directoryReads = 0
    let globalFailure = true
    const globalSDK = {
      provider: { list: async () => {
        globalReads++
        if (globalFailure) throw Object.assign(new Error("Global catalog unavailable"), { status: 400 })
        return { data: { all: [], connected: [], default: {} } }
      } },
    } as unknown as OpencodeClient
    const directorySDK = {
      provider: { list: async () => {
        directoryReads++
        return { data: { all: [], connected: [], default: {} } }
      } },
    } as unknown as OpencodeClient
    const globalQuery = loadProvidersQuery(ServerScope.local, null, globalSDK)
    const directoryQuery = loadProvidersQuery(ServerScope.local, "/project", directorySDK)
    await queryClient.fetchQuery(globalQuery).catch(() => undefined)
    await queryClient.fetchQuery(directoryQuery)

    globalFailure = false
    await retryFailedProviderQueries(queryClient, [globalQuery, directoryQuery])

    expect(globalReads).toBe(2)
    expect(directoryReads).toBe(1)
  })

  test("marks a loading directory partial during bootstrap and complete after success", async () => {
    const mcpReads: string[] = []
    const commandReads: string[] = []
    const questionReads: string[] = []
    const permissionReads: string[] = []
    let sessionLoads = 0
    const [store, setStore] = createStore<State>({
      status: "loading",
      agent: [],
      command: [],
      project: "",
      projectMeta: undefined,
      icon: undefined,
      provider_ready: true,
      provider_error: false,
      provider,
      config: {},
      path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
      session: [],
      sessionTotal: 0,
      session_status: {},
      turnCompletion: {},
      session_working(id: string) {
        return this.session_status[id]?.type !== "idle"
      },
      session_diff: {},
      todo: {},
      permission: {},
      question: {},
      mcp_ready: true,
      mcp: {},
      lsp_ready: true,
      lsp: [],
      vcs: undefined,
      limit: 5,
      message: {},
      part: {},
      part_text_accum_delta: {},
    })

    const completion = bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: {
        app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
        config: { get: async () => ({ data: {} }) },
        session: { status: async () => ({ data: {} }) },
        vcs: { get: async () => ({ data: undefined }) },
        command: {
          list: async () => {
            mcpReads.push("command")
            return { data: [] }
          },
        },
        permission: { list: async () => ({ data: [] }) },
        question: { list: async () => ({ data: [] }) },
        v2: {
          command: {
            list: async () => {
              commandReads.push("command")
              return {
                data: {
                  location: { directory: "/project" },
                  data: [{ name: "on-demand-ui", template: "", source: "skill" }],
                },
              }
            },
          },
          surface: {
            request: {
              list: async (input: { location?: { directory?: string } }) => {
                questionReads.push(input.location?.directory ?? "")
                return { data: { data: [] } }
              },
            },
          },
          permission: {
            request: {
              list: async (input: { location?: { directory?: string } }) => {
                permissionReads.push(input.location?.directory ?? "")
                return { data: { data: [] } }
              },
            },
          },
        },
        mcp: {
          status: async () => {
            mcpReads.push("status")
            return { data: {} }
          },
        },
        provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
      } as unknown as OpencodeClient,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {
        sessionLoads += 1
      },
      translate: (key) => key,
      queryClient: new QueryClient(),
    })

    expect(store.status).toBe("partial")

    await completion

    expect(store.status).toBe("complete")
    expect(sessionLoads).toBe(1)
    expect(mcpReads).toEqual([])
    expect(commandReads).toEqual(["command"])
    expect(store.command).toMatchObject([{ name: "on-demand-ui", source: "skill" }])
    expect(questionReads).toEqual(["/project"])
    expect(permissionReads).toEqual(["/project"])
  })

  test("does not restore a V2 question closed while its session warms", async () => {
    const [store, setStore] = bootstrapState()
    const pending = question("que_race", "ses_race", "Still pending?")
    let releaseSession: (value: { data: Session }) => void = () => {}
    let markStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const sdk = questionSDK({
      current: [pending],
      get: () =>
        new Promise((resolve) => {
          releaseSession = resolve
          markStarted()
        }),
    })

    startQuestionBootstrap({ store, setStore, sdk })
    await started
    applyDirectoryEvent({
      event: { type: "surface.replied", properties: { sessionID: pending.sessionID, requestID: pending.id } },
      store,
      setStore,
      push() {},
      directory: "/project",
      loadLsp() {},
    })
    releaseSession({ data: session(pending.sessionID) })
    await waitForBootstrap(store)

    expect(store.question[pending.sessionID] ?? []).toEqual([])
  })

  test("uses V2 pending questions as the sole authority when legacy data overlaps", async () => {
    const [store, setStore] = bootstrapState()
    const duplicateLegacy = question("que_shared", "ses_shared", "Legacy copy")
    const duplicateV2 = question("que_shared", "ses_shared", "V2 copy")
    const legacyOnly = question("que_legacy", "ses_shared", "Legacy only")
    setStore("session", [session("ses_shared")])

    startQuestionBootstrap({
      store,
      setStore,
      sdk: questionSDK({ legacy: [duplicateLegacy, legacyOnly], current: [duplicateV2] }),
    })
    await waitForBootstrap(store)

    expect(store.question.ses_shared?.map((item) => item.id)).toEqual(["que_shared"])
    const storedQuestion = store.question.ses_shared?.find((item) => item.id === "que_shared")
    expect(storedQuestion?.mode === "blocking" ? storedQuestion.questions[0]?.question : undefined).toBe("V2 copy")
    expect(isV2SurfaceRequest(store.question.ses_shared?.find((item) => item.id === "que_shared")!)).toBe(true)
  })

  test("merges legacy and V2 pending permissions while preserving the V2 reply protocol", async () => {
    const [store, setStore] = bootstrapState()
    const duplicateLegacy = permission("per_shared", "ses_shared", "legacy")
    const duplicateV2 = permissionV2("per_shared", "ses_shared", "external_directory")
    const legacyOnly = permission("per_legacy", "ses_shared", "read")
    setStore("session", [session("ses_shared")])

    startQuestionBootstrap({
      store,
      setStore,
      sdk: questionSDK({
        legacyPermissions: [duplicateLegacy, legacyOnly],
        currentPermissions: [duplicateV2],
      }),
    })
    await waitForBootstrap(store)

    expect(store.permission.ses_shared?.map((item) => item.id)).toEqual(["per_legacy", "per_shared"])
    const current = store.permission.ses_shared?.find((item) => item.id === "per_shared")
    expect(current?.permission).toBe("external_directory")
    expect(isV2PermissionRequest(current!)).toBe(true)
  })

  test("does not restore a V2 permission answered while its session warms", async () => {
    const [store, setStore] = bootstrapState()
    const pending = permissionV2("per_race", "ses_race", "external_directory")
    let releaseSession: (value: { data: Session }) => void = () => {}
    let markStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const sdk = questionSDK({
      currentPermissions: [pending],
      get: () =>
        new Promise((resolve) => {
          releaseSession = resolve
          markStarted()
        }),
    })

    startQuestionBootstrap({ store, setStore, sdk })
    await started
    applyDirectoryEvent({
      event: { type: "permission.v2.replied", properties: { sessionID: pending.sessionID, requestID: pending.id } },
      store,
      setStore,
      push() {},
      directory: "/project",
      loadLsp() {},
    })
    releaseSession({ data: session(pending.sessionID) })
    await waitForBootstrap(store)

    expect(store.permission[pending.sessionID] ?? []).toEqual([])
  })

  test("recovers pending questions across Windows directory casing", async () => {
    const [store, setStore] = bootstrapState()
    const original = "C:\\Repo-A\\Project"
    const recovery = "c:/repo-a/project/"
    const pending = question("que_mixed_case", "ses_mixed_case", "Still pending?")
    setStore("session", [session(pending.sessionID, original)])

    startQuestionBootstrap({
      store,
      setStore,
      directory: recovery,
      projectDirectory: original,
      sdk: questionSDK({
        current: [pending],
        get: (sessionID) => Promise.resolve({ data: session(sessionID, original) }),
      }),
    })
    await waitForBootstrap(store)

    expect(store.project).toBe("project")
    expect(store.path.directory).toBe(original)
    expect(store.question[pending.sessionID]?.map((item) => item.id)).toEqual([pending.id])
  })
})

describe("query keys", () => {
  test("partitions identical directories by server scope", () => {
    const client = {} as OpencodeClient
    const remote = "https://debian.example" as typeof ServerScope.local

    expect([...loadPathQuery(ServerScope.local, "/repo", client).queryKey]).toEqual(["local", "/repo", "path"])
    expect([...loadPathQuery(remote, "/repo", client).queryKey]).toEqual(["https://debian.example", "/repo", "path"])
    expect([...loadProvidersQuery(remote, null, client).queryKey]).toEqual([
      "https://debian.example",
      null,
      "providers",
    ])
    expect(loadProvidersQuery(remote, null, client).retry).toBe(false)
    expect(loadProvidersQuery(remote, null, client).retryOnMount).toBe(false)
  })

  test("deduplicates Windows directory aliases", async () => {
    let providerReads = 0
    const sdk = {
      provider: {
        list: async () => {
          providerReads += 1
          await Bun.sleep(10)
          return { data: { all: [], connected: [], default: {} } }
        },
      },
    } as unknown as OpencodeClient
    const queryClient = new QueryClient()

    await Promise.all([
      queryClient.fetchQuery(loadProvidersQuery(ServerScope.local, "C:\\GitRepros\\PU", sdk)),
      queryClient.fetchQuery(loadProvidersQuery(ServerScope.local, "C:/GitRepros/PU/", sdk)),
    ])

    expect(providerReads).toBe(1)
    expect([...loadAgentsQuery(ServerScope.local, "C:\\GitRepros\\PU", sdk).queryKey]).toEqual([
      ServerScope.local,
      "c:/gitrepros/pu",
      "agents",
    ])
    expect([...loadPathQuery(ServerScope.local, "C:/GitRepros/PU/", sdk).queryKey]).toEqual([
      ServerScope.local,
      "c:/gitrepros/pu",
      "path",
    ])
  })

  test("forwards TanStack cancellation signals to bootstrap HTTP requests", async () => {
    const seen: Array<AbortSignal | undefined> = []
    const sdk = {
      global: {
        config: {
          get: async (options?: { signal?: AbortSignal }) => {
            seen.push(options?.signal)
            return { data: {} }
          },
        },
      },
      project: {
        list: async (_parameters?: unknown, options?: { signal?: AbortSignal }) => {
          seen.push(options?.signal)
          return { data: [] }
        },
      },
      provider: {
        list: async (_parameters?: unknown, options?: { signal?: AbortSignal }) => {
          seen.push(options?.signal)
          return { data: { all: [], connected: [], default: {} } }
        },
      },
      app: {
        agents: async (_parameters?: unknown, options?: { signal?: AbortSignal }) => {
          seen.push(options?.signal)
          return { data: [] }
        },
      },
      path: {
        get: async (_parameters?: unknown, options?: { signal?: AbortSignal }) => {
          seen.push(options?.signal)
          return {
            data: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
          }
        },
      },
    } as unknown as OpencodeClient
    const queries = [
      loadGlobalConfigQuery(ServerScope.local, sdk),
      loadProjectsQuery(ServerScope.local, sdk),
      loadProvidersQuery(ServerScope.local, null, sdk),
      loadAgentsQuery(ServerScope.local, "/project", sdk),
      loadPathQuery(ServerScope.local, null, sdk),
    ]
    const controllers = queries.map(() => new AbortController())
    const signals = controllers.map((controller) => controller.signal)

    await Promise.all(
      queries.map((query, index) => {
        const queryFn = query.queryFn as (context: { signal: AbortSignal }) => Promise<unknown>
        return queryFn({ signal: signals[index] })
      }),
    )

    expect(seen[0]).toBe(signals[0])
    expect(seen[1]).toBe(signals[1])
    expect(seen[2]).not.toBe(signals[2])
    controllers[2]!.abort()
    expect(seen[2]?.aborted).toBe(true)
    expect(seen[3]).toBeUndefined()
    expect(seen[4]).toBe(signals[4])
  })
})
