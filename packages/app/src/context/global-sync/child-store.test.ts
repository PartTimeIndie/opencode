import { beforeAll, describe, expect, mock, test } from "bun:test"
import { createRoot, createSignal, getOwner, type Owner } from "solid-js"
import { createStore } from "solid-js/store"
import type { NormalizedProviderListResponse } from "@opencode-ai/ui/context"
import type { State } from "./types"
import type { QueryOptionsApi } from "../server-sync"
import { ServerScope } from "@/utils/server-scope"
import { directoryKey } from "./utils"

let createChildStoreManager: typeof import("./child-store").createChildStoreManager
const querySingles: Array<() => { queryKey?: unknown[]; enabled?: boolean; queryFn?: unknown }> = []
const persist: typeof import("@/utils/persist").persisted = (_target, store) => [
  store[0],
  store[1],
  null,
  Object.assign(() => true, { promise: undefined }),
]

const child = () => createStore({} as State)
const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse
let providerQueryOptionsCreated = 0
const globalProvider = {
  ...provider,
  all: new Map([["demo", {}]]),
} as unknown as NormalizedProviderListResponse
let providerQueryData: NormalizedProviderListResponse | undefined = provider
let providerQueryLoading = false
let providerQueryFetching = false
let providerQueryError = false

const queryOptionsApi = {
  globalConfig: () => ({ queryKey: ["globalConfig"], queryFn: async () => ({}) }),
  projects: () => ({ queryKey: ["projects"], queryFn: async () => [] }),
  providers: (directory: string | null) => {
    providerQueryOptionsCreated += 1
    return { queryKey: [directory, "providers"], queryFn: async () => provider }
  },
  path: (directory: string | null) => ({
    queryKey: [directory, "path"],
    queryFn: async () => ({
      state: "",
      config: "",
      worktree: "",
      directory: directory ?? "",
      home: "",
    }),
  }),
  agents: (directory: string) => ({ queryKey: [directory, "agents"], queryFn: async () => [] }),
  mcp: (directory: string) => ({ queryKey: [directory, "mcp"], queryFn: async () => ({}) }),
  lsp: (directory: string) => ({ queryKey: [directory, "lsp"], queryFn: async () => [] }),
  sessions: (directory: string) => ({ queryKey: [directory, "loadSessions"] as const }),
} as unknown as QueryOptionsApi

function createOwner(callback: (owner: Owner) => void) {
  return createRoot((dispose) => {
    const owner = getOwner()
    if (!owner) throw new Error("owner required")
    callback(owner)

    return dispose
  })
}

beforeAll(async () => {
  mock.module("@tanstack/solid-query", () => ({
    useQuery: (options: () => { queryKey?: unknown[]; enabled?: boolean }) => {
      querySingles.push(options)
      return {
        get isLoading() {
          return options().queryKey?.[1] === "path" ||
            (options().queryKey?.[1] === "providers" && providerQueryLoading)
        },
        get isFetching() {
          return options().queryKey?.[1] === "providers" && providerQueryFetching
        },
        get isError() {
          return options().queryKey?.[1] === "providers" && providerQueryError
        },
        get data() {
          if (options().queryKey?.[1] === "path") throw new Error("pending path data read")
          if (options().queryKey?.[1] === "mcp") return options().enabled ? { demo: { status: "disabled" } } : undefined
          if (options().queryKey?.[1] === "lsp") return []
          if (options().queryKey?.[1] === "providers") return providerQueryData
          return undefined
        },
      }
    },
  }))

  createChildStoreManager = (await import("./child-store")).createChildStoreManager
})

describe("createChildStoreManager", () => {
  test("does not evict the active directory during mark", () => {
    const owner = createRoot((dispose) => {
      const current = getOwner()
      dispose()
      return current
    })
    if (!owner) throw new Error("owner required")

    const manager = createChildStoreManager({
      owner,
      scope: ServerScope.local,
      persist,
      isBooting: () => false,
      isLoadingSessions: () => false,
      onBootstrap() {},
      onMcp() {},
      onDispose() {},
      initialSessionLimit: () => 4,
      translate: (key) => key,
      queryOptions: queryOptionsApi,
      global: { provider: () => provider },
    })

    Array.from({ length: 30 }, (_, index) => `/pinned-${index}`).forEach((directory) => {
      manager.children[directory] = child()
      manager.pin(directory)
    })

    const directory = "/active"
    manager.children[directory] = child()
    manager.mark(directory)

    expect(manager.children[directory]).toBeDefined()
  })

  test("starts new child stores as loading and bootstraps them on first access", () => {
    const bootstraps: string[] = []
    let manager: ReturnType<typeof createChildStoreManager> | undefined

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap(directory) {
          bootstraps.push(directory)
        },
        onMcp() {},
        onDispose() {},
        initialSessionLimit: () => 4,
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider: () => provider },
      })
    })

    try {
      if (!manager) throw new Error("manager required")

      const [store] = manager.child("/project")

      expect(store.status).toBe("loading")
      expect(store.limit).toBe(4)
      expect(bootstraps).toEqual(["/project"])
    } finally {
      dispose()
    }
  })

  test("provides the requested directory while the path query is pending", () => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap() {},
        onMcp() {},
        onDispose() {},
        initialSessionLimit: () => 4,
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider: () => provider },
      })
    })

    try {
      if (!manager) throw new Error("manager required")

      const [store] = manager.child("/project", { bootstrap: false })

      expect(store.path.directory).toBe("/project")
      expect(store.path.worktree).toBe("")
    } finally {
      dispose()
    }
  })

  test("falls back to global providers when project discovery fails", () => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined
    providerQueryData = undefined

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap() {},
        onMcp() {},
        onDispose() {},
        initialSessionLimit: () => 4,
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider: () => globalProvider },
      })
    })

    try {
      if (!manager) throw new Error("manager required")
      expect(manager.child("/project", { bootstrap: false })[0].provider).toBe(globalProvider)
    } finally {
      providerQueryData = provider
      dispose()
    }
  })

  test("tracks a global provider catalog that arrives after child-store creation", () => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined
    let readProviders: (() => NormalizedProviderListResponse) | undefined
    let setGlobalProviders: ((providers: NormalizedProviderListResponse) => void) | undefined
    providerQueryData = undefined

    const dispose = createOwner((owner) => {
      const [globalProviders, setGlobal] = createSignal<NormalizedProviderListResponse>(provider)
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap() {},
        onMcp() {},
        onDispose() {},
        initialSessionLimit: () => 4,
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider: globalProviders },
      })
      const [store] = manager.child("/project", { bootstrap: false })
      readProviders = () => store.provider
      setGlobalProviders = setGlobal
    })

    try {
      if (!manager || !readProviders || !setGlobalProviders) throw new Error("global provider accessors required")
      expect(readProviders().all.size).toBe(0)

      setGlobalProviders(globalProvider)

      expect(readProviders().all.size).toBe(1)
    } finally {
      providerQueryData = provider
      dispose()
    }
  })

  test("keeps the global catalog during pending or failed discovery, then adopts recovered project data", () => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined
    const projectProvider = {
      ...provider,
      all: new Map([["project", {}]]),
    } as unknown as NormalizedProviderListResponse
    providerQueryData = undefined
    providerQueryLoading = true
    providerQueryFetching = true

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap() {},
        onMcp() {},
        onDispose() {},
        initialSessionLimit: () => 4,
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider: () => globalProvider },
      })
    })

    try {
      if (!manager) throw new Error("manager required")
      const [store] = manager.child("/project", { bootstrap: false })

      expect(store.provider_ready).toBe(false)
      expect(store.provider).toBe(globalProvider)
      expect(store.provider_error).toBe(false)

      providerQueryLoading = false
      providerQueryFetching = true
      providerQueryData = projectProvider
      expect(store.provider_ready).toBe(true)
      expect(store.provider).toBe(projectProvider)

      providerQueryFetching = false
      providerQueryError = true
      expect(store.provider_ready).toBe(true)
      expect(store.provider_error).toBe(true)
      expect(store.provider).toBe(projectProvider)

      // TanStack keeps status='error' while isFetching during an explicit
      // retry, so the stored error hides only after isFetching clears. The
      // last good catalog stays visible in-flight.
      providerQueryError = true
      providerQueryFetching = true
      expect(store.provider_ready).toBe(true)
      expect(store.provider_error).toBe(false)
      expect(store.provider).toBe(projectProvider)

      providerQueryFetching = false
      expect(store.provider).toBe(projectProvider)
    } finally {
      providerQueryData = provider
      providerQueryLoading = false
      providerQueryFetching = false
      providerQueryError = false
      dispose()
    }
  })

  test("reuses a Windows child store across event path casing and separators", () => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined
    const disposed: string[] = []

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap() {},
        onMcp() {},
        onDispose(directory) {
          disposed.push(directory)
        },
        initialSessionLimit: () => 4,
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider: () => provider },
      })
    })

    try {
      if (!manager) throw new Error("manager required")

      const first = manager.child("C:\\Repo-A\\Project", { bootstrap: false })
      const fromEvent = manager.child("c:/repo-a/project/", { bootstrap: false })

      expect(fromEvent[0]).toBe(first[0])
      expect(Object.keys(manager.children)).toEqual(["c:/repo-a/project"])
      expect(manager.sourceDirectory("c:/repo-a/project")).toBe("C:\\Repo-A\\Project")
      expect(manager.disposeDirectory(directoryKey("c:/repo-a/project"))).toBe(true)
      expect(disposed).toEqual(["C:\\Repo-A\\Project"])
    } finally {
      dispose()
    }
  })

  test("metadata lookups for many inactive tabs do not materialize directory stores", () => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined
    const bootstrapped: string[] = []

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap(directory) {
          bootstrapped.push(directory)
        },
        onMcp() {},
        onDispose() {},
        initialSessionLimit: () => 4,
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider: () => provider },
      })
    })

    try {
      if (!manager) throw new Error("manager required")
      const storeManager = manager
      const inactive = Array.from({ length: 48 }, (_, index) => `C:/repo/inactive-${index}`)

      expect(inactive.every((directory) => storeManager.existing(directory) === undefined)).toBe(true)
      const active = storeManager.peek("C:/repo/active", { bootstrap: false })

      expect(active[0].message).toEqual({})
      expect(active[0].part).toEqual({})
      expect(Object.keys(storeManager.children)).toEqual(["c:/repo/active"])
      expect(bootstrapped).toEqual([])
    } finally {
      dispose()
    }
  })

  test("keeps workspace queries disabled until bootstrap access", () => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined
    const offset = querySingles.length

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap() {},
        onMcp() {},
        onDispose() {},
        initialSessionLimit: () => 4,
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider: () => provider },
      })
    })

    try {
      if (!manager) throw new Error("manager required")

      manager.child("/project", { bootstrap: false })
      const pathQuery = querySingles[offset]
      const lspQuery = querySingles[offset + 2]
      const providerQuery = querySingles[offset + 3]
      if (!pathQuery || !lspQuery || !providerQuery) throw new Error("queries required")

      expect(manager.bootstrapped("/project")).toBe(false)
      expect(pathQuery().enabled).toBe(false)
      expect(lspQuery().enabled).toBe(false)
      expect(providerQuery().enabled).toBe(false)

      manager.child("/project")

      expect(manager.bootstrapped("/project")).toBe(true)
      expect(pathQuery().enabled).toBe(true)
      expect(lspQuery().enabled).toBe(true)
      expect(providerQuery().enabled).toBe(true)
    } finally {
      dispose()
    }
  })

  test("keeps provider query options stable across observer updates", () => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined
    const offset = querySingles.length
    const created = providerQueryOptionsCreated

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap() {},
        onMcp() {},
        onDispose() {},
        initialSessionLimit: () => 4,
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider: () => provider },
      })
      manager.child("/project", { bootstrap: false })
    })

    try {
      const providerQuery = querySingles[offset + 3]
      if (!manager || !providerQuery) throw new Error("provider query observer required")
      const first = providerQuery()
      const second = providerQuery()

      expect(providerQueryOptionsCreated - created).toBe(1)
      expect(first.queryFn).toBe(second.queryFn)
    } finally {
      dispose()
    }
  })

  test("enables MCP only when requested for the directory", () => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined
    const offset = querySingles.length
    const mcpLoads: string[] = []

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap() {},
        onMcp(directory) {
          mcpLoads.push(directory)
        },
        onDispose() {},
        initialSessionLimit: () => 4,
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider: () => provider },
      })
    })

    try {
      if (!manager) throw new Error("manager required")
      const [store, setStore] = manager.child("/project", { bootstrap: false })
      expect(querySingles.length - offset).toBe(4)
      const query = querySingles[offset + 1]
      if (!query) throw new Error("query required")
      expect(query().enabled).toBe(false)
      expect(store.mcp_ready).toBe(false)

      setStore("status", "complete")
      manager.child("/project", { bootstrap: false, mcp: true })
      expect(query().enabled).toBe(true)
      expect(store.mcp_ready).toBe(true)
      expect(store.mcp).toEqual({ demo: { status: "disabled" } })
      expect(mcpLoads).toEqual(["/project"])

      manager.disableMcp("/project")
      expect(query().enabled).toBe(false)
      expect(manager.mcp("/project")).toBe(false)
    } finally {
      dispose()
    }
  })
})
