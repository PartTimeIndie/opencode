import { createSimpleContext } from "@opencode-ai/ui/context"
import { type Accessor, batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { ServerScope } from "@/utils/server-scope"
import { readAppState, writeAppState } from "@/utils/app-state"
import { projectWorktreeKey } from "@/utils/path-key"

type StoredProject = { worktree: string; expanded: boolean }
type StoredServer = string | ServerConnection.HttpBase | ServerConnection.Http
type ServerProjectState = { projects: Record<string, StoredProject[]>; lastProject: Record<string, string> }
const HEALTH_POLL_INTERVAL_MS = 10_000
const SHARED_PROJECT_STATE_KEY = "server-projects.v1"

export function normalizeServerUrl(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  return withProtocol.replace(/\/+$/, "")
}

export function serverName(conn?: ServerConnection.Any, ignoreDisplayName = false) {
  if (!conn) return ""
  if (conn.displayName && !ignoreDisplayName) return conn.displayName
  return conn.http.url.replace(/^https?:\/\//, "").replace(/\/+$/, "")
}

function isLocalHost(url: string) {
  const host = url.replace(/^https?:\/\//, "").split(":")[0]
  if (host === "localhost" || host === "127.0.0.1") return "local"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeStoredProjects(value: unknown): StoredProject[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.worktree !== "string" || !item.worktree) return []
    return [{ worktree: item.worktree, expanded: item.expanded !== false }]
  })
}

function mergeStoredProjects(primary: StoredProject[], secondary: StoredProject[]) {
  const seen = new Set<string>()
  return [...primary, ...secondary].filter((project) => {
    const key = projectWorktreeKey(project.worktree)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function parseSharedProjectState(value: unknown) {
  if (!isRecord(value)) return { projects: [], lastProject: undefined as string | undefined }
  return {
    projects: normalizeStoredProjects(value.projects),
    lastProject: typeof value.lastProject === "string" ? value.lastProject : undefined,
  }
}

export function migrateCanonicalLocalServerState(value: unknown, canonicalLocalServer?: ServerConnection.Key) {
  if (!canonicalLocalServer || canonicalLocalServer === "local") return value
  if (!isRecord(value)) return value
  const projects = isRecord(value.projects) ? value.projects : undefined
  const lastProject = isRecord(value.lastProject) ? value.lastProject : undefined
  const previousProjects = projects?.[canonicalLocalServer]
  const previousLastProject = lastProject?.[canonicalLocalServer]
  if (!Array.isArray(previousProjects) && typeof previousLastProject !== "string") return value

  const next = { ...value }
  if (projects && Array.isArray(previousProjects)) {
    const local = Array.isArray(projects.local) ? projects.local : []
    const worktrees = new Set(
      local.flatMap((project) => (isRecord(project) && typeof project.worktree === "string" ? [project.worktree] : [])),
    )
    const migrated = previousProjects.filter((project) => {
      if (!isRecord(project) || typeof project.worktree !== "string") return true
      if (worktrees.has(project.worktree)) return false
      worktrees.add(project.worktree)
      return true
    })
    const nextProjects: Record<string, unknown> = { ...projects, local: [...local, ...migrated] }
    delete nextProjects[canonicalLocalServer]
    next.projects = nextProjects
  }
  if (lastProject && typeof previousLastProject === "string") {
    const nextLastProject = { ...lastProject }
    if (typeof nextLastProject.local !== "string") nextLastProject.local = previousLastProject
    delete nextLastProject[canonicalLocalServer]
    next.lastProject = nextLastProject
  }
  return next
}

export function createServerProjects<T extends ServerProjectState>(input: {
  scope: Accessor<ServerScope>
  store: Store<T>
  setStore: SetStoreFunction<T>
}) {
  const setStore = input.setStore as unknown as SetStoreFunction<ServerProjectState>
  const stored = () => input.store.projects[input.scope()] ?? []
  const current = () => mergeStoredProjects(stored(), [])
  return {
    list: current,
    open(directory: string) {
      const scope = input.scope()
      const key = projectWorktreeKey(directory)
      if (current().some((project) => projectWorktreeKey(project.worktree) === key)) return
      setStore("projects", scope, [{ worktree: directory, expanded: true }, ...current()])
    },
    close(directory: string) {
      const key = projectWorktreeKey(directory)
      setStore(
        "projects",
        input.scope(),
        stored().filter((project) => projectWorktreeKey(project.worktree) !== key),
      )
    },
    expand(directory: string) {
      const key = projectWorktreeKey(directory)
      const index = stored().findIndex((project) => projectWorktreeKey(project.worktree) === key)
      if (index !== -1) setStore("projects", input.scope(), index, "expanded", true)
    },
    collapse(directory: string) {
      const key = projectWorktreeKey(directory)
      const index = stored().findIndex((project) => projectWorktreeKey(project.worktree) === key)
      if (index !== -1) setStore("projects", input.scope(), index, "expanded", false)
    },
    move(directory: string, toIndex: number) {
      const key = projectWorktreeKey(directory)
      const fromIndex = current().findIndex((project) => projectWorktreeKey(project.worktree) === key)
      if (fromIndex === -1 || fromIndex === toIndex) return
      const next = [...current()]
      const [item] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, item)
      setStore("projects", input.scope(), next)
    },
    last() {
      return input.store.lastProject[input.scope()]
    },
    touch(directory: string) {
      setStore("lastProject", input.scope(), directory)
    },
  }
}

export function resolveServerList(input: {
  props?: Array<ServerConnection.Any>
  stored: StoredServer[]
}): Array<ServerConnection.Any> {
  const deduped = new Map<ServerConnection.Key, ServerConnection.Any>(
    input.props?.map((v) => [ServerConnection.key(v), v]) ?? [],
  )

  for (const value of input.stored) {
    const conn: ServerConnection.Http =
      typeof value === "string"
        ? {
            type: "http" as const,
            http: { url: value },
          }
        : "http" in value
          ? value
          : { type: "http", http: value }
    const key = ServerConnection.key(conn)

    const existing = deduped.get(key)
    if (existing)
      deduped.set(key, {
        ...existing,
        ...conn,
        http: { ...existing.http, ...conn.http },
      })
    else deduped.set(key, conn)
  }

  return [...deduped.values()]
}

export function reuseStableServerConnections(
  next: Array<ServerConnection.Any>,
  previous: Array<ServerConnection.Any> = [],
) {
  const byKey = new Map(previous.map((conn) => [ServerConnection.key(conn), conn]))
  const stable = next.map((conn) => {
    const existing = byKey.get(ServerConnection.key(conn))
    return existing && sameServerConnection(existing, conn) ? existing : conn
  })
  if (stable.length === previous.length && stable.every((conn, index) => conn === previous[index])) return previous
  return stable
}

function sameHttpBase(a: ServerConnection.HttpBase, b: ServerConnection.HttpBase) {
  return a.url === b.url && a.username === b.username && a.password === b.password
}

function sameServerConnection(a: ServerConnection.Any, b: ServerConnection.Any) {
  if (a.type !== b.type) return false
  if (a.displayName !== b.displayName || a.label !== b.label) return false
  if (a.type === "http" && b.type === "http") return a.authToken === b.authToken && sameHttpBase(a.http, b.http)
  if (a.type === "ssh" && b.type === "ssh") return a.host === b.host && sameHttpBase(a.http, b.http)
  if (a.type !== "sidecar" || b.type !== "sidecar") return false
  if (a.variant !== b.variant || !sameHttpBase(a.http, b.http)) return false
  if (a.variant !== "wsl" || b.variant !== "wsl") return true
  return a.distro === b.distro
}

export namespace ServerConnection {
  type Base = { displayName?: string; label?: string }

  export type HttpBase = {
    url: string
    username?: string
    password?: string
  }

  // Regular web connections
  export type Http = {
    type: "http"
    http: HttpBase
    authToken?: boolean
  } & Base

  export type Sidecar = {
    type: "sidecar"
    http: HttpBase
  } & (
    | // Regular desktop server
    { variant: "base" }
    // WSL server (windows only)
    | {
        variant: "wsl"
        distro: string
      }
  ) &
    Base

  // Remote server desktop can SSH into
  export type Ssh = {
    type: "ssh"
    host: string
    // SSH client exposes an HTTP server for the app to use as a proxy
    http: HttpBase
  } & Base

  export type Any =
    | Http
    // All these are desktop-only
    | (Sidecar | Ssh)

  export const key = (conn: Any): Key => {
    switch (conn.type) {
      case "http":
        return Key.make(conn.http.url)
      case "sidecar": {
        if (conn.variant === "wsl") return Key.make(`wsl:${conn.distro}`)
        return Key.make("sidecar")
      }
      case "ssh":
        return Key.make(`ssh:${conn.host}`)
    }
  }

  export type Key = string & { _brand: "Key" }
  export const Key = { make: (v: string) => v as Key }

  export const builtin = (conn: Any) => conn.type === "sidecar" && conn.variant === "base"
  export const local = (conn?: Any) =>
    !!conn && (builtin(conn) || (conn.type === "http" && isLocalHost(conn.http.url) === "local"))
}

export function nextServerAfterRemoval(
  servers: ServerConnection.Any[],
  removed: ServerConnection.Key,
  fallback: ServerConnection.Key,
) {
  const remaining = servers.filter((server) => ServerConnection.key(server) !== removed)
  const next = remaining.find((server) => ServerConnection.key(server) === fallback) ?? remaining[0]
  return next ? ServerConnection.key(next) : fallback
}

export const { use: useServer, provider: ServerProvider } = createSimpleContext({
  name: "Server",
  gate: true,
  init: (props: {
    defaultServer: ServerConnection.Key
    canonicalLocalServer?: ServerConnection.Key
    servers?: Array<ServerConnection.Any>
  }) => {
    const [store, setStore, _, ready] = persisted(
      {
        ...Persist.global("server", ["server.v3"]),
        migrate: (value) => migrateCanonicalLocalServerState(value, props.canonicalLocalServer),
      },
      createStore({
        list: [] as StoredServer[],
        projects: {} as Record<string, StoredProject[]>,
        lastProject: {} as Record<string, string>,
      }),
    )

    const url = (x: StoredServer) => (typeof x === "string" ? x : "type" in x ? x.http.url : x.url)

    const allServers = createMemo<Array<ServerConnection.Any>>((previous) => {
      return reuseStableServerConnections(resolveServerList({ stored: store.list, props: props.servers }), previous)
    }, [])

    const [state, setState] = createStore({
      active: props.defaultServer,
    })

    function setActive(input: ServerConnection.Key) {
      if (state.active !== input) setState("active", input)
    }

    function add(input: ServerConnection.Http) {
      const url_ = normalizeServerUrl(input.http.url)
      if (!url_) return
      const conn: ServerConnection.Http = { ...input, authToken: undefined, http: { ...input.http, url: url_ } }
      return batch(() => {
        const existing = store.list.findIndex((x) => url(x) === url_)
        if (existing !== -1) {
          setStore("list", existing, conn)
        } else {
          setStore("list", store.list.length, conn)
        }
        setState("active", ServerConnection.key(conn))
        return conn
      })
    }

    function remove(key: ServerConnection.Key) {
      const next = nextServerAfterRemoval(allServers(), key, props.defaultServer)
      const list = store.list.filter((x) => url(x) !== key)
      batch(() => {
        setStore("list", list)
        if (state.active === key) setState("active", next)
      })
    }

    const isReady = createMemo(() => ready() && !!state.active)

    const scope = (key = state.active) => ServerScope.fromServerKey(key, props.canonicalLocalServer)
    const projects = createServerProjects({ scope, store, setStore })
    const projectStores = new Map<ServerConnection.Key, ReturnType<typeof createServerProjects>>()
    const projectsForServer = (key: ServerConnection.Key) => {
      const existing = projectStores.get(key)
      if (existing) return existing
      const next = createServerProjects({ scope: () => scope(key), store, setStore })
      projectStores.set(key, next)
      return next
    }
    const current: Accessor<ServerConnection.Any | undefined> = createMemo(
      () => allServers().find((s) => ServerConnection.key(s) === state.active) ?? allServers()[0],
    )
    const isLocal = createMemo(() => ServerConnection.local(current()))
    const loadedSharedProjects = new Set<ServerConnection.Key>()
    const loadingSharedProjects = new Set<ServerConnection.Key>()

    createEffect(() => {
      if (!ready()) return
      const conn = current()
      if (!conn) return
      const key = ServerConnection.key(conn)
      if (loadedSharedProjects.has(key) || loadingSharedProjects.has(key)) return
      loadingSharedProjects.add(key)

      void (async () => {
        const scopeKey = scope(key)
        const localProjects = store.projects[scopeKey] ?? []
        const localLastProject = store.lastProject[scopeKey]
        const remote = parseSharedProjectState(await readAppState(conn.http, SHARED_PROJECT_STATE_KEY))

        if (remote.projects.length === 0 && !remote.lastProject) {
          if (localProjects.length > 0 || localLastProject) {
            await writeAppState(conn.http, SHARED_PROJECT_STATE_KEY, {
              projects: localProjects,
              lastProject: localLastProject,
            })
          }
          return
        }

        const merged = mergeStoredProjects(remote.projects, localProjects)
        batch(() => {
          setStore("projects", scopeKey, merged)
          if (remote.lastProject || localLastProject) {
            setStore("lastProject", scopeKey, remote.lastProject ?? localLastProject)
          }
        })
      })()
        .catch((error) => console.warn("[app-state] failed to load shared projects", error))
        .finally(() => {
          loadedSharedProjects.add(key)
          loadingSharedProjects.delete(key)
        })
    })

    createEffect(() => {
      if (!ready()) return
      const conn = current()
      if (!conn) return
      const key = ServerConnection.key(conn)
      if (!loadedSharedProjects.has(key)) return
      const scopeKey = scope(key)
      const projectsSnapshot = store.projects[scopeKey] ?? []
      const lastProject = store.lastProject[scopeKey]
      const payload = { projects: projectsSnapshot, lastProject }
      const timer = setTimeout(() => {
        void writeAppState(conn.http, SHARED_PROJECT_STATE_KEY, payload).catch((error) =>
          console.warn("[app-state] failed to save shared projects", error),
        )
      }, 250)
      onCleanup(() => clearTimeout(timer))
    })

    return {
      ready: isReady,
      isLocal,
      get key() {
        return state.active
      },
      get name() {
        return serverName(current())
      },
      get list() {
        return allServers()
      },
      get current() {
        return current()
      },
      setActive,
      add,
      remove,
      scope,
      projects: {
        ...projects,
        forServer: projectsForServer,
      },
    }
  },
})
