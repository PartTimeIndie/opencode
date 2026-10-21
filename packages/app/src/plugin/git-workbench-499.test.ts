import { describe, expect, test, vi } from "bun:test"

type Snapshot = {
  info: { worktree: string; branch: string }
  status: { file: string; code: string }[]
  history: { hash: string; subject: string }[]
  branches: unknown[]
  remotes: unknown[]
  tags: unknown[]
  stashes: unknown[]
  conflicts: unknown[]
  operation: { inProgress: boolean }
}

type WorkbenchState = {
  panels: Set<() => void>
  directory: string
  navigationDirectory: string
  navigationSessionID: string
  settings: { historyLimit: number; defaultRemote: string; syncMode: string; commitChain?: string }
  busy: string
  commitBusy: boolean
  error: string
  notice: string
  selectedCommit: string
  selectedFile: string
  snapshot: Snapshot
  diffByFile: Map<string, unknown>
  diffBusy: string
  diffError: string
  commitTargets: { version: number; entries: unknown[] }
  discoveredProjects: { worktree: string; name: string }[]
  discoveryTruncated: boolean
  syncComposerToolbar: ReturnType<typeof vi.fn>
}

function snapshot(file = "src/kept.ts"): Snapshot {
  return {
    info: { worktree: "C:/repo", branch: "main" },
    status: [{ file, code: " M" }],
    history: [],
    branches: [],
    remotes: [],
    tags: [],
    stashes: [],
    conflicts: [],
    operation: { inProgress: false },
  }
}

function state(previous = snapshot()): WorkbenchState {
  return {
    panels: new Set(),
    directory: "C:/repo",
    navigationDirectory: "C:/repo",
    navigationSessionID: "session-1",
    settings: { historyLimit: 25, defaultRemote: "", syncMode: "pull-merge-push" },
    busy: "",
    commitBusy: false,
    error: "",
    notice: "",
    selectedCommit: "",
    selectedFile: "src/kept.ts",
    snapshot: previous,
    diffByFile: new Map(),
    diffBusy: "",
    diffError: "",
    commitTargets: { version: 1, entries: [] },
    discoveredProjects: [],
    discoveryTruncated: false,
    syncComposerToolbar: vi.fn(),
  }
}

function api() {
  return {
    host: {
      git: {
        snapshot: async (_input: { directory: string; limit: number }) => snapshot(),
        diff: async (_input: { directory: string; mode: string; context: number }) => [],
        action: async (_input: Record<string, unknown>) => ({ ok: true, message: "ok" }),
        discover: async (_input: { directory: string; maxDepth: number }) => ({ repositories: [], truncated: false }),
      },
      navigation: { current: () => ({ directory: "C:/repo", sessionID: "session-1" }) },
    },
    kv: { set: vi.fn() },
    dock: { open: { item: vi.fn() } },
  }
}

type Api = ReturnType<typeof api>

const workbench = (await import(
  new URL("../../../../.opencode/plugins/git-workbench-app/index.js", import.meta.url).href
)) as unknown as {
  refreshSnapshot: (api: Api, state: WorkbenchState, options?: { force?: boolean; quiet?: boolean }) => Promise<void>
  loadFileDiff: (api: Api, state: WorkbenchState, file: string, options?: { force?: boolean }) => Promise<void>
  runGitAction: (api: Api, state: WorkbenchState, input: Record<string, unknown>, title: string) => Promise<void>
  runCommitAllOpenChanges: (api: Api, state: WorkbenchState, context?: { directory?: string }) => Promise<void>
  runAutomation: (api: Api, state: WorkbenchState, input: Record<string, unknown>) => Promise<unknown>
}

describe("Git Workbench 499 cancellation", () => {
  test("keeps the previous snapshot and clears busy state on an HTTP 499 refresh", async () => {
    const current = state()
    const host = api()
    vi.spyOn(host.host.git, "snapshot").mockRejectedValueOnce(
      new Error("opencode server GET /vcs/git/snapshot → 499 unknown: (empty response body)"),
    )

    await workbench.refreshSnapshot(host, current)

    expect(current.snapshot).toEqual(snapshot())
    expect(current.busy).toBe("")
    expect(current.error).toBe("")
  })

  test("keeps a previously loaded diff and clears busy state on AbortError", async () => {
    const current = state()
    const previousDiff = { file: "src/kept.ts", patch: "-old\n+kept", additions: 1, deletions: 1 }
    current.diffByFile.set("src/kept.ts", previousDiff)
    const host = api()
    vi.spyOn(host.host.git, "diff").mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"))

    await workbench.loadFileDiff(host, current, "src/kept.ts", { force: true })

    expect(current.diffByFile.get("src/kept.ts")).toBe(previousDiff)
    expect(current.diffBusy).toBe("")
    expect(current.diffError).toBe("")
  })

  test("keeps the previous snapshot and clears busy state when a Git action is cancelled", async () => {
    const current = state()
    const host = api()
    vi.spyOn(host.host.git, "action").mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"))

    await workbench.runGitAction(host, current, { action: "stage" }, "Stage all")

    expect(current.snapshot).toEqual(snapshot())
    expect(current.busy).toBe("")
    expect(current.error).toBe("")
  })

  test("silently resolves a cancelled commit lookup and clears both busy states", async () => {
    const current = state()
    const host = api()
    vi.spyOn(host.host.git, "snapshot").mockRejectedValueOnce(
      new Error("opencode server GET /vcs/git/snapshot → 499 unknown: (empty response body)"),
    )

    await workbench.runCommitAllOpenChanges(host, current, { directory: "C:/repo" })

    expect(current.busy).toBe("")
    expect(current.commitBusy).toBe(false)
    expect(current.error).toBe("")
    expect(current.snapshot).toEqual(snapshot())
  })

  test("returns a cancelled automation result without replacing the previous snapshot", async () => {
    const current = state()
    const host = api()
    vi.spyOn(host.host.git, "snapshot").mockResolvedValueOnce(snapshot("src/before.ts"))
    vi.spyOn(host.host.git, "action").mockRejectedValueOnce(
      new Error("opencode server POST /vcs/git/action → 499 unknown: (empty response body)"),
    )

    const result = await workbench.runAutomation(host, current, {
      directory: "C:/repo",
      action: { action: "fetch" },
      openDock: false,
    })

    expect(result).toEqual({ ok: false, cancelled: true })
    expect(current.snapshot).toEqual(snapshot())
    expect(current.busy).toBe("")
  })
})
