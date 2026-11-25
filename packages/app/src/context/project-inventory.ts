import type { Project, ProjectResolvedDirectory } from "@opencode-ai/sdk/v2/client"
import type { ProjectMeta } from "./global-sync/types"
import { projectWorktreeKey } from "@/utils/path-key"

export function createProjectInventoryRefresh(
  resolve: (directories: string[], signal: AbortSignal) => Promise<ProjectResolvedDirectory[]>,
  publish: (resolved: Map<string, ProjectResolvedDirectory>) => void,
) {
  const controller = new AbortController()
  const sameDirectories = (a: string[], b: string[]) => a.length === b.length && a.every((dir, index) => dir === b[index])
  let latest: string[] = []
  let published = new Map<string, ProjectResolvedDirectory>()
  let inFlight: Promise<void> | undefined

  function refresh() {
    if (controller.signal.aborted) return
    // Timer ticks join the current run. Only an actual input change earns a follow-up request.
    return (inFlight ??= Promise.resolve().then(async () => {
      try {
        while (!controller.signal.aborted) {
          const directories = latest
          let data: ProjectResolvedDirectory[] = []
          if (directories.length) {
            try {
              data = await resolve(directories, controller.signal)
            } catch {
              // Keep the last good result and retry on the next tick or input change.
            }
          }
          if (controller.signal.aborted) return
          if (!sameDirectories(directories, latest)) continue
          if (data.length || !directories.length) {
            const next = new Map(data.map((item) => [item.directory, item]))
            const unchanged = next.size === published.size && [...next].every(([directory, item]) => {
              const previous = published.get(directory)
              return previous?.real === item.real && previous.exists === item.exists
            })
            if (!unchanged) {
              published = next
              publish(next)
            }
          }
          if (sameDirectories(directories, latest)) return
        }
      } finally {
        inFlight = undefined
      }
    }))
  }

  return {
    update(directories: string[]) {
      const next = [...new Set(directories)].sort()
      if (sameDirectories(latest, next)) return
      latest = next
      return refresh()
    },
    refresh,
    dispose: () => controller.abort(),
  }
}

export function projectInventoryEntries<T extends { worktree: string; expanded?: boolean; time?: { updated: number } }>(
  entries: readonly T[],
  resolved: ReadonlyMap<string, ProjectResolvedDirectory>,
) {
  const results = new Map<string, T & { aliases: string[] }>()
  for (const entry of entries) {
    const resolution = resolved.get(entry.worktree)
    if (resolution?.exists === false) continue
    const worktree = resolution?.real ?? entry.worktree
    const key = projectWorktreeKey(worktree)
    const previous = results.get(key)
    if (!previous) {
      results.set(key, { ...entry, worktree, aliases: [entry.worktree] })
      continue
    }
    const preferred = (entry.time?.updated ?? 0) > (previous.time?.updated ?? 0) ? entry : previous
    results.set(key, {
      ...preferred,
      worktree: previous.worktree,
      ...(entry.expanded || previous.expanded ? { expanded: true } : {}),
      aliases: [...previous.aliases, entry.worktree],
    })
  }
  return [...results.values()]
}

// Project rows aggregate session paths by repository ID, which independent clones can share.
export function navigatorDirectoriesByWorktree(
  directories: readonly string[],
  resolved: ReadonlyMap<string, ProjectResolvedDirectory>,
) {
  const byWorktree = new Map<string, string[]>()
  for (const directory of directories) {
    const resolution = resolved.get(directory)
    if (resolution?.exists === false) continue
    const key = projectWorktreeKey(resolution?.real ?? directory)
    const entries = byWorktree.get(key)
    if (entries) entries.push(directory)
    else byWorktree.set(key, [directory])
  }
  return byWorktree
}

export function enrichProject<T extends { worktree: string; icon?: Project["icon"] }>(
  project: T,
  server: Project | undefined,
  directoryIcon: string | null | undefined,
  local: ProjectMeta | undefined,
) {
  const { icon: storedIcon, ...storedProject } = project
  const fallbackIcon =
    directoryIcon === undefined
      ? local?.icon ?? storedIcon
      : { ...storedIcon, ...local?.icon, override: directoryIcon ?? undefined }
  return {
    ...local,
    ...server,
    ...storedProject,
    icon: server?.icon ?? fallbackIcon,
  }
}

export function projectInventoryMetadata(
  server: Project | undefined,
  directories: readonly string[],
  existing: (directory: string) => readonly [{ projectMeta?: ProjectMeta }, unknown] | undefined,
) {
  if (server) return undefined
  for (const directory of directories) {
    const metadata = existing(directory)?.[0].projectMeta
    if (metadata) return metadata
  }
}
