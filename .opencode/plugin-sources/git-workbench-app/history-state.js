/**
 * Pure state transitions for the Git Workbench branch-filtered history view.
 *
 * The controller keeps the loaded history strictly separate from working-tree
 * snapshot metadata: pages are appended only for the matching request
 * generation, errors keep previously loaded commits, and no cursor state is
 * ever persisted.
 */

export const HISTORY_FILTER_KEY_PREFIX = "historyFilter:"

export function createHistoryState() {
  return {
    selector: "head",
    ref: "",
    firstParent: false,
    commits: [],
    byHash: new Map(),
    cursor: "",
    hasMore: true,
    loaded: false,
    loading: false,
    error: null,
    generation: 0,
    headOid: "",
    refLabels: [],
    messageTexts: new Map(),
  }
}

export function persistedFilterKey(repoKey) {
  return `${HISTORY_FILTER_KEY_PREFIX}${repoKey}`
}

export function parsePersistedFilter(value) {
  if (!value || typeof value !== "object") return null
  const selector = value.selector
  if (selector !== "all" && selector !== "head" && selector !== "branch") return null
  if (selector === "branch" && (typeof value.ref !== "string" || !value.ref.startsWith("refs/"))) return null
  return {
    selector,
    ref: selector === "branch" ? value.ref : "",
    firstParent: value.firstParent === true,
  }
}

export function selectHistoryBranch(state, filter) {
  return {
    ...state,
    selector: filter.selector,
    ref: filter.ref ?? "",
    firstParent: filter.selector === "all" ? false : filter.firstParent === true,
    commits: [],
    byHash: new Map(),
    cursor: "",
    hasMore: true,
    loaded: false,
    loading: false,
    error: null,
    messageTexts: new Map(),
    scrollTop: 0,
    generation: state.generation + 1,
  }
}

export function beginHistoryLoad(state) {
  if (state.loading) return state
  return { ...state, loading: true, error: null }
}

export function applyHistoryPage(state, page, generation) {
  if (generation !== state.generation) return { applied: false, state }
  const commits = [...state.commits]
  const byHash = new Map(state.byHash)
  for (const commit of page.commits ?? []) {
    if (!commit || typeof commit.hash !== "string" || byHash.has(commit.hash)) continue
    byHash.set(commit.hash, commit)
    commits.push(commit)
  }
  // Anchor metadata (HEAD oid, ref labels) belongs to the current generation:
  // the first page (re)initializes it and continuations keep it stable.
  const firstPage = state.commits.length === 0
  return {
    applied: true,
    state: {
      ...state,
      commits,
      byHash,
      cursor: typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : "",
      hasMore: page.hasMore === true && Boolean(page.nextCursor),
      loaded: true,
      loading: false,
      error: null,
      headOid: firstPage ? (typeof page.headOid === "string" ? page.headOid : "") : state.headOid,
      refLabels: firstPage ? (Array.isArray(page.refLabels) ? page.refLabels : []) : state.refLabels,
    },
  }
}

export function applyHistoryError(state, error, generation) {
  if (generation !== state.generation) return { applied: false, state }
  const code = typeof error?.code === "string" ? error.code : "process_failed"
  const recovery = typeof error?.recovery === "string" ? error.recovery : "retry"
  return {
    applied: true,
    state: {
      ...state,
      loading: false,
      error: {
        code,
        recovery,
        message: typeof error?.message === "string" && error.message ? error.message : "History failed to load",
      },
    },
  }
}

/**
 * A saved branch reference that no longer exists must fall back visibly:
 * reset to the checked-out branch and surface a notice instead of guessing.
 */
export function resetToHead(state, notice) {
  return {
    ...selectHistoryBranch(state, { selector: "head", firstParent: false }),
    error: null,
    notice: notice ?? "",
  }
}

export function appendMessageChunk(state, hash, chunk) {
  const existing = state.messageTexts.get(hash) ?? { text: "", cursor: "", truncated: true }
  const text = existing.text + (chunk.text ?? "")
  return {
    ...state,
    messageTexts: new Map(state.messageTexts).set(hash, {
      text,
      cursor: typeof chunk.nextCursor === "string" ? chunk.nextCursor : "",
      truncated: chunk.truncated === true,
    }),
  }
}
