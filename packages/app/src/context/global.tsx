import { createSimpleContext } from "@opencode-ai/ui/context"
import { batch, createEffect, createMemo, createRoot, createSignal, getOwner, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createServerProjects, ServerConnection, useServer } from "./server"
import { useServerHealth } from "@/utils/server-health"
import { createServerSdkContext } from "./server-sdk"
import { createServerSyncContext } from "./server-sync"
import { QueryClient } from "@tanstack/solid-query"
import type { ServerScope } from "@/utils/server-scope"
import type { ProjectDirectoryIconUpdate, ProjectResolvedDirectory } from "@opencode-ai/sdk/v2/client"
import { projectWorktreeKey } from "@/utils/path-key"
import { createProjectInventoryRefresh, enrichProject, navigatorDirectoriesByWorktree, projectInventoryEntries, projectInventoryMetadata } from "./project-inventory"
import type { LocalProject } from "./layout"

export const { use: useGlobal, provider: GlobalProvider } = createSimpleContext({
  name: "Global",
  init: () => {
    const server = useServer()
    const serverHealth = useServerHealth(
      () => server.list,
      () => true,
    )
    const [store, setStore] = createStore({
      settings: {
        serverKey: undefined as ServerConnection.Key | undefined,
      },
    })

    const settingsServer = createMemo(() => {
      const list = server.list
      return list.find((conn) => ServerConnection.key(conn) === store.settings.serverKey) ?? list[0]
    })

    createEffect(() => {
      const conn = settingsServer()
      const key = conn ? ServerConnection.key(conn) : undefined
      if (store.settings.serverKey !== key) setStore("settings", "serverKey", key)
    })

    const serverCtxs = new Map<
      ServerConnection.Key,
      { dispose: () => void; serverCtx: ReturnType<typeof createServerCtx> }
    >()

    const owner = getOwner()

    const ensureServerCtx = (conn: ServerConnection.Any) => {
      const key = ServerConnection.key(conn)
      const existing = serverCtxs.get(key)
      if (existing) return existing.serverCtx
      const root = createRoot((dispose) => {
        const serverCtx = createServerCtx(conn, server.scope(key), server.projects.forServer(key))
        return { dispose, serverCtx }
      }, owner ?? undefined)
      serverCtxs.set(key, root)
      return root.serverCtx
    }

    createMemo(() => {
      for (const conn of server.list) {
        ensureServerCtx(conn)
      }
    })

    createEffect(() => {
      for (const [key] of serverCtxs) {
        if (!server.list.find((conn) => ServerConnection.key(conn) === key)) {
          const { dispose } = serverCtxs.get(key)!
          dispose()
          serverCtxs.delete(key)
        }
      }
    })

    return {
      servers: {
        list: () => server.list,
        health: serverHealth,
      },
      settings: {
        server: {
          get key() {
            return store.settings.serverKey
          },
          selected: settingsServer,
          set(key: ServerConnection.Key) {
            if (store.settings.serverKey !== key) setStore("settings", "serverKey", key)
          },
        },
      },
      createServerCtx(conn: ServerConnection.Any) {
        return ensureServerCtx(conn)
      },
    }
  },
})

function createServerCtx(
  conn: ServerConnection.Any,
  scope: ServerScope,
  projects: ReturnType<typeof createServerProjects>,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnReconnect: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
      },
    },
  })
  const sdk = createServerSdkContext(conn, scope)
  const sync = createServerSyncContext(sdk)

  const [icons, setIcons] = createSignal(new Map<string, string | null>())
  let iconRevision = 0
  const iconChanges = new Map<string, number>()
  function applyIcon(item: ProjectDirectoryIconUpdate) {
    const key = projectWorktreeKey(item.directory)
    iconChanges.set(key, ++iconRevision)
    setIcons((current) => {
      const next = new Map(current)
      next.set(key, item.icon?.override ?? null)
      return next
    })
  }
  onCleanup(sdk.event.listen(({ name, details }) => {
    if (name === "global" && details.type === "project.directoryIcon.updated") applyIcon(details.properties)
  }))
  createEffect(() => {
    sdk.event.reconnect()
    const controller = new AbortController()
    const revision = iconRevision
    onCleanup(() => controller.abort())
    void sdk.client.project.directoryIcons({}, { signal: controller.signal }).then(({ data }) => {
      if (!Array.isArray(data) || controller.signal.aborted) return
      setIcons((current) => {
        const next = new Map<string, string | null>(data.map((item) => [projectWorktreeKey(item.directory), item.icon.override]))
        for (const [key, value] of current) {
          if ((iconChanges.get(key) ?? 0) > revision || (value === null && !next.has(key))) next.set(key, value)
        }
        return next
      })
    }).catch(() => {})
  })
  const [resolved, setResolved] = createSignal(new Map<string, ProjectResolvedDirectory>())
  const serverProjects = createMemo(() => sync.data.project.filter((item) => item.id !== "global"))
  const sessionDirectories = createMemo(() => [...new Set(sync.data.project.flatMap((item) => [
    ...(item.sessionDirectories ?? []),
    ...(item.sandboxes ?? []),
  ]))])
  async function resolve(directories: string[], signal?: AbortSignal) {
    const { data } = await sdk.client.project.resolve({ projectResolveDirectoriesInput: { directories } }, { signal })
    return Array.isArray(data) ? data : []
  }
  const inventoryRefresh = createProjectInventoryRefresh(resolve, setResolved)
  createEffect(() => {
    void inventoryRefresh.update([
      ...[...projects.list(), ...serverProjects()].map((item) => item.worktree),
      ...sessionDirectories(),
    ])
  })
  const inventoryTimer = setInterval(inventoryRefresh.refresh, 30_000)
  onCleanup(() => {
    clearInterval(inventoryTimer)
    inventoryRefresh.dispose()
  })
  const catalog = createMemo(() => new Map(projectInventoryEntries(serverProjects(), resolved())
    .map((item) => [projectWorktreeKey(item.worktree), item])))
  const sessionDirectoriesByWorktree = createMemo(() => navigatorDirectoriesByWorktree(sessionDirectories(), resolved()))
  function enrich(project: { worktree: string; expanded: boolean; aliases: string[] }) {
    const key = projectWorktreeKey(project.worktree)
    const metadata = catalog().get(key)
    const aliases = [...new Set([...project.aliases, ...(metadata?.aliases ?? [])])]
    // Listing projects must not allocate directory stores or churn their eviction/persistence lifecycle.
    const local = projectInventoryMetadata(metadata, [project.worktree, ...aliases], sync.existing)
    return {
      ...enrichProject(project, metadata, icons().get(key), metadata ? undefined : local),
      aliases,
      sessionDirectories: sessionDirectoriesByWorktree().get(key) ?? [],
    }
  }
  const projectsList = createMemo<LocalProject[]>(() => projectInventoryEntries(projects.list(), resolved()).map(enrich))
  const inventory = createMemo<LocalProject[]>(() => {
    const open = projectsList()
    const keys = new Set(open.map((item) => projectWorktreeKey(item.worktree)))
    return [...open, ...[...catalog()].flatMap(([key, item]) => keys.has(key) ? [] : [enrich({ ...item, expanded: true })])]
  })
  const storedAliases = (directory: string) => {
    const key = projectWorktreeKey(directory)
    return projects.list().filter((item) => {
      const real = resolved().get(item.worktree)?.real ?? item.worktree
      return projectWorktreeKey(item.worktree) === key || projectWorktreeKey(real) === key
    }).map((item) => item.worktree)
  }
  const isLocal =
    (conn?.type === "sidecar" && conn.variant === "base") || (conn?.type === "http" && isLocalHost(conn.http.url))

  return {
    queryClient,
    sdk,
    sync,
    isLocal,
    async setDirectoryIcon(directory: string, url?: string) {
      const { data } = await sdk.client.project.directoryIcon(
        { projectDirectoryIconInput: { directory, url } },
        { throwOnError: true },
      )
      applyIcon(data)
      // The server now owns this override. Do not retain an older browser copy.
      for (const alias of new Set([directory, ...storedAliases(directory)])) {
        sync.project.meta(alias, { icon: { override: undefined } })
      }
      return data
    },
    projects: {
      ...projects,
      async register(directory: string) {
        const [result] = await resolve([directory]).catch(() => [])
        if (result?.exists === false) return
        const real = result?.real ?? directory
        if (!storedAliases(real).length) projects.open(real)
        return real
      },
      close(directory: string) {
        batch(() => storedAliases(directory).forEach(projects.close))
      },
      expand(directory: string) {
        batch(() => storedAliases(directory).forEach(projects.expand))
      },
      collapse(directory: string) {
        batch(() => storedAliases(directory).forEach(projects.collapse))
      },
      move(directory: string, toIndex: number) {
        const from = storedAliases(directory)[0]
        const to = projectsList()[toIndex]?.worktree
        if (!from || !to) return
        const target = storedAliases(to)[0]
        const index = projects.list().findIndex((item) => item.worktree === target)
        if (index !== -1) projects.move(from, index)
      },
      list: projectsList,
      inventory,
    },
  }
}

export type ServerCtx = ReturnType<typeof createServerCtx>

function isLocalHost(url: string) {
  const host = url.replace(/^https?:\/\//, "").split(":")[0]
  if (host === "localhost" || host === "127.0.0.1") return "local"
}
