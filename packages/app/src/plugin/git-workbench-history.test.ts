import { describe, expect, test } from "bun:test"

type HistoryStateModule = {
  createHistoryState: () => {
    selector: string
    ref: string
    firstParent: boolean
    commits: unknown[]
    byHash: Map<string, unknown>
    cursor: string
    hasMore: boolean
    loaded: boolean
    loading: boolean
    error: { code: string; recovery: string; message: string } | null
    generation: number
    headOid: string
    refLabels: { hash: string; label: string }[]
    messageTexts: Map<string, { text: string; cursor: string; truncated: boolean }>
    scrollTop?: number
  }
  HISTORY_FILTER_KEY_PREFIX: string
  persistedFilterKey: (repoKey: string) => string
  parsePersistedFilter: (value: unknown) => { selector: string; ref: string; firstParent: boolean } | null
  selectHistoryBranch: (state: ReturnType<HistoryStateModule["createHistoryState"]>, filter: { selector: string; ref?: string; firstParent?: boolean }) => ReturnType<HistoryStateModule["createHistoryState"]>
  beginHistoryLoad: (state: ReturnType<HistoryStateModule["createHistoryState"]>) => ReturnType<HistoryStateModule["createHistoryState"]>
  applyHistoryPage: (
    state: ReturnType<HistoryStateModule["createHistoryState"]>,
    page: { commits?: { hash: string }[]; hasMore?: boolean; nextCursor?: string; headOid?: string; refLabels?: { hash: string; label: string }[] },
    generation: number,
  ) => { applied: boolean; state: ReturnType<HistoryStateModule["createHistoryState"]> }
  applyHistoryError: (
    state: ReturnType<HistoryStateModule["createHistoryState"]>,
    error: { code?: string; recovery?: string; message?: string },
    generation: number,
  ) => { applied: boolean; state: ReturnType<HistoryStateModule["createHistoryState"]> }
  resetToHead: (state: ReturnType<HistoryStateModule["createHistoryState"]>, notice?: string) => ReturnType<HistoryStateModule["createHistoryState"]> & { notice?: string }
  appendMessageChunk: (
    state: ReturnType<HistoryStateModule["createHistoryState"]>,
    hash: string,
    chunk: { text?: string; nextCursor?: string; truncated?: boolean },
  ) => ReturnType<HistoryStateModule["createHistoryState"]>
}

const state = (await import(new URL("../../../../.opencode/plugins/git-workbench-app/history-state.js", import.meta.url).href)) as unknown as HistoryStateModule

const commit = (hash: string) => ({ hash, subject: hash, body: "", bodyTruncated: false, parents: [], boundary: "none" })

describe("git workbench history state", () => {
  test("defaults to the checked-out branch", () => {
    const fresh = state.createHistoryState()
    expect(fresh.selector).toBe("head")
    expect(fresh.firstParent).toBe(false)
    expect(fresh.generation).toBe(0)
  })

  test("validates persisted filters instead of guessing", () => {
    expect(state.parsePersistedFilter({ selector: "branch", ref: "refs/heads/main", firstParent: true })).toEqual({
      selector: "branch",
      ref: "refs/heads/main",
      firstParent: true,
    })
    expect(state.parsePersistedFilter({ selector: "branch", ref: "main" })).toBeNull()
    expect(state.parsePersistedFilter({ selector: "nope" })).toBeNull()
    expect(state.parsePersistedFilter(undefined)).toBeNull()
  })

  test("filter changes bump the generation and clear pages", () => {
    let current = state.createHistoryState()
    current = state.applyHistoryPage(current, { commits: [commit("a")], hasMore: true, nextCursor: "c1" }, 0).state
    current.scrollTop = 240
    current.headOid = "old-head"
    current.refLabels = [{ hash: "a", label: "old" }]
    current = state.selectHistoryBranch(current, { selector: "all" })
    expect(current.generation).toBe(1)
    expect(current.commits).toHaveLength(0)
    expect(current.cursor).toBe("")
    expect(current.hasMore).toBe(true)
    expect(current.selector).toBe("all")
    expect(current.firstParent).toBe(false)
    expect(current.scrollTop).toBe(0)
    expect(current.headOid).toBe("old-head")
  })

  test("the first page of a generation initializes anchor metadata; continuations keep it", () => {
    let current = state.createHistoryState()
    current = state.applyHistoryPage(current, { commits: [commit("a")], hasMore: true, nextCursor: "c1", headOid: "h1", refLabels: [{ hash: "a", label: "main" }] }, 0).state
    expect(current.headOid).toBe("h1")
    expect(current.refLabels).toEqual([{ hash: "a", label: "main" }])
    const continuation = state.applyHistoryPage(current, { commits: [commit("b")], hasMore: false, headOid: "changed", refLabels: [{ hash: "b", label: "moved" }] }, 0).state
    expect(continuation.headOid).toBe("h1")
    expect(continuation.refLabels).toEqual([{ hash: "a", label: "main" }])
    // After a filter/refresh generation bump the new first page wins again.
    const reset = state.selectHistoryBranch(current, { selector: "head" })
    const reanchored = state.applyHistoryPage(reset, { commits: [commit("z")], hasMore: false, headOid: "h2", refLabels: [{ hash: "z", label: "new" }] }, reset.generation).state
    expect(reanchored.headOid).toBe("h2")
    expect(reanchored.refLabels).toEqual([{ hash: "z", label: "new" }])
  })

  test("load-more is single-flight and stale pages are rejected", () => {
    let current = state.createHistoryState()
    const loading = state.beginHistoryLoad(current)
    expect(loading.loading).toBe(true)
    expect(state.beginHistoryLoad(loading)).toBe(loading)
    const stale = state.applyHistoryPage(loading, { commits: [commit("x")] }, 99)
    expect(stale.applied).toBe(false)
    const applied = state.applyHistoryPage(loading, { commits: [commit("a"), commit("a"), commit("b")], hasMore: true, nextCursor: "c2" }, loading.generation)
    expect(applied.applied).toBe(true)
    expect(applied.state.commits.map((entry) => (entry as { hash: string }).hash)).toEqual(["a", "b"])
    expect(applied.state.cursor).toBe("c2")
    expect(applied.state.loading).toBe(false)
  })

  test("errors keep the loaded commits and carry the recovery hint", () => {
    let current = state.createHistoryState()
    current = state.applyHistoryPage(current, { commits: [commit("a")], hasMore: true, nextCursor: "c1" }, 0).state
    const failed = state.applyHistoryError(current, { code: "shallow_changed", recovery: "refresh", message: "moved" }, 0)
    expect(failed.applied).toBe(true)
    expect(failed.state.commits).toHaveLength(1)
    expect(failed.state.error?.code).toBe("shallow_changed")
    expect(failed.state.loading).toBe(false)
    const stale = state.applyHistoryError(current, { code: "process_failed" }, 7)
    expect(stale.applied).toBe(false)
  })

  test("deleted saved branches fall back visibly to head", () => {
    let current = state.createHistoryState()
    current = state.selectHistoryBranch(current, { selector: "branch", ref: "refs/heads/gone", firstParent: true })
    const fallback = state.resetToHead(current, "Saved branch not found")
    expect(fallback.selector).toBe("head")
    expect(fallback.ref).toBe("")
    expect(fallback.generation).toBe(current.generation + 1)
    expect(fallback.notice).toBe("Saved branch not found")
  })

  test("message chunks concatenate", () => {
    let current = state.createHistoryState()
    current = state.appendMessageChunk(current, "h", { text: "part one ", nextCursor: "m1", truncated: true })
    current = state.appendMessageChunk(current, "h", { text: "part two", truncated: false })
    expect(current.messageTexts.get("h")?.text).toBe("part one part two")
    expect(current.messageTexts.get("h")?.truncated).toBe(false)
  })

  test("persisted filter keys are repo-scoped", () => {
    expect(state.persistedFilterKey("c:/repo")).toBe(`${state.HISTORY_FILTER_KEY_PREFIX}c:/repo`)
  })
})
