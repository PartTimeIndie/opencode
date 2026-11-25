import { expect, test } from "bun:test"
import type { Project, ProjectResolvedDirectory } from "@opencode-ai/sdk/v2/client"
import { createProjectInventoryRefresh, enrichProject, navigatorDirectoriesByWorktree, projectInventoryEntries } from "./project-inventory"

test("coalesces inventory changes without aborting the pending request or publishing its stale result", async () => {
  const requests: { directories: string[]; signal: AbortSignal; complete: (data: ProjectResolvedDirectory[]) => void }[] = []
  const results: ProjectResolvedDirectory[][] = []
  const inventory = createProjectInventoryRefresh((directories, signal) => {
    const pending = Promise.withResolvers<ProjectResolvedDirectory[]>()
    requests.push({ directories, signal, complete: pending.resolve })
    return pending.promise
  }, (resolved) => results.push([...resolved.values()]))

  const running = inventory.update(["/original"])
  await Promise.resolve()
  inventory.update(["/intermediate"])
  inventory.update(["/z", "/a", "/a"])
  expect(inventory.update(["/a", "/z"])).toBeUndefined()
  expect(inventory.refresh()).toBe(running)
  expect(requests.map((request) => request.directories)).toEqual([["/original"]])
  expect(requests[0].signal.aborted).toBe(false)

  requests[0].complete([{ directory: "/original", real: "/stale", exists: true }])
  await Promise.resolve()
  expect(results).toEqual([])
  expect(requests.map((request) => request.directories)).toEqual([["/original"], ["/a", "/z"]])
  const current = [
    { directory: "/a", real: "/canonical", exists: true },
    { directory: "/z", real: "/z", exists: false },
  ]
  requests[1].complete(current)
  await running
  expect(results).toEqual([current])

  const periodic = inventory.refresh()
  await Promise.resolve()
  requests[2].complete([...current].reverse())
  await periodic
  expect(results).toEqual([current])
  expect(requests).toHaveLength(3)
})

test("retries a failed resolve on the next refresh, not in a loop or on equivalent input", async () => {
  const row = { directory: "/a", real: "/canonical", exists: true }
  const results: ProjectResolvedDirectory[][] = []
  let calls = 0
  const inventory = createProjectInventoryRefresh(async () => {
    if (++calls === 1) throw new Error("temporary failure")
    return [row]
  }, (resolved) => results.push([...resolved.values()]))

  await inventory.update(["/a"])
  await inventory.update(["/a", "/a"])
  expect(calls).toBe(1)
  expect(results).toEqual([])
  await inventory.refresh()
  expect(calls).toBe(2)
  expect(results).toEqual([[row]])
})

test("aborts the request on disposal and ignores late results and queued updates", async () => {
  const pending = Promise.withResolvers<ProjectResolvedDirectory[]>()
  const signals: AbortSignal[] = []
  const results: ProjectResolvedDirectory[][] = []
  const inventory = createProjectInventoryRefresh((_, signal) => {
    signals.push(signal)
    return pending.promise
  }, (resolved) => results.push([...resolved.values()]))

  const running = inventory.update(["/original"])
  await Promise.resolve()
  inventory.update(["/queued"])
  inventory.dispose()
  expect(signals[0].aborted).toBe(true)
  pending.resolve([{ directory: "/original", real: "/original", exists: true }])
  await running
  await inventory.refresh()
  expect(signals).toHaveLength(1)
  expect(results).toEqual([])
})

test("shows the physical worktree once and retains the aliases and expanded state", () => {
  const alias = "C:/GitRepros/Repo"
  const real = "E:/GitRepros/Repo"
  const gone = "E:/task/workspace"
  const entries = projectInventoryEntries(
    [{ worktree: alias, expanded: false }, { worktree: real.toLowerCase(), expanded: true }, { worktree: gone }],
    new Map([
      [alias, { directory: alias, real, exists: true }],
      [gone, { directory: gone, real: gone, exists: false }],
    ]),
  )
  expect(entries).toEqual([{ worktree: real, expanded: true, aliases: [alias, real.toLowerCase()] }])
})

test("indexes raw session directories by resolved workspace, not by the project row that supplied them", () => {
  const primary = "E:/GitRepros/Repo"
  const alias = "C:/GitRepros/Repo"
  const clone = "E:/Other/Repo"
  const missing = "C:/task/workspace"
  const resolved = new Map([
    [alias, { directory: alias, real: primary, exists: true }],
    [clone, { directory: clone, real: clone, exists: true }],
    [missing, { directory: missing, real: missing, exists: false }],
  ])
  const directories = [primary, alias, clone, missing]
  const grouped = navigatorDirectoriesByWorktree(directories, resolved)
  expect(grouped).toEqual(new Map([[primary.toLowerCase(), [primary, alias]], [clone.toLowerCase(), [clone]]]))
  expect(navigatorDirectoriesByWorktree(directories, new Map()).get(primary.toLowerCase())).toEqual([primary])
})

test("keeps the stored color and artwork when neither the server nor the cache supplies an icon", () => {
  const project = { worktree: "/projects/one", icon: { color: "lime", url: "/art.svg", generated: "art" } }
  expect(enrichProject(project, undefined, undefined, undefined).icon).toEqual(project.icon)
  expect(enrichProject(project, undefined, undefined, { name: "Cached name" }).icon).toEqual(project.icon)
  expect(enrichProject(project, { worktree: project.worktree } as Project, undefined, undefined).icon).toEqual(project.icon)
})

test("applies a directory override or clear without discarding stored artwork or reviving a stale override", () => {
  const artwork = { color: "lime", url: "/art.svg", generated: "art" }
  const project = { worktree: "/projects/one", icon: { ...artwork, override: "stored" } }
  const cache = { icon: { override: "cached" } }
  expect(enrichProject(project, undefined, "new", cache).icon).toEqual({ ...artwork, override: "new" })
  expect(enrichProject(project, undefined, null, cache).icon).toEqual({ ...artwork, override: undefined })
  expect(enrichProject(project, undefined, null, undefined).icon).toEqual({ ...artwork, override: undefined })
  const server = { worktree: project.worktree, icon: { url: "/server.svg" } } as Project
  expect(enrichProject(project, server, null, cache).icon).toEqual(server.icon)
})

test("prefers the server project icon and does not resurrect a cleared directory override", () => {
  const project = { worktree: "/projects/one" }
  const local = { icon: { override: "old", color: "pink" } }
  const server = { ...project, icon: { override: "project" } } as Project
  expect(enrichProject(project, server, "directory", local).icon).toEqual(server.icon)
  expect(enrichProject(project, undefined, "directory", local).icon).toEqual({ override: "directory", color: "pink" })
  expect(enrichProject(project, undefined, undefined, local).icon).toEqual(local.icon)
  expect(enrichProject(project, undefined, null, local).icon).toEqual({ override: undefined, color: "pink" })
})
