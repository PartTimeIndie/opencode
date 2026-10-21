const STORE_VERSION = 1
const DEFAULT_LIMIT = 200

export function repositoryKey(worktree) {
  if (typeof worktree !== "string" || !worktree) return ""
  const windows = /^[a-z]:[\\/]/i.test(worktree) || worktree.startsWith("\\\\")
  const normalized = windows ? worktree.replaceAll("\\", "/") : worktree
  const trimmed = normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized
  return windows ? trimmed.toLowerCase() : trimmed
}

export function repositoryWithin(container, worktree) {
  const parent = repositoryKey(container)
  const child = repositoryKey(worktree)
  return Boolean(parent && child && (parent === child || child.startsWith(`${parent}/`)))
}

export function normalizeCommitTargetStore(input, limit = DEFAULT_LIMIT) {
  const entries = input?.version === STORE_VERSION && Array.isArray(input.entries) ? input.entries : []
  const latest = new Map()
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry.sessionID !== "string" ||
      !entry.sessionID ||
      typeof entry.container !== "string" ||
      !entry.container ||
      typeof entry.worktree !== "string" ||
      !entry.worktree ||
      !Number.isFinite(entry.updatedAt)
    )
      continue
    const previous = latest.get(entry.sessionID)
    if (!previous || previous.updatedAt < entry.updatedAt) latest.set(entry.sessionID, { ...entry })
  }
  return {
    version: STORE_VERSION,
    entries: [...latest.values()]
      .toSorted((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, Math.max(1, Math.floor(limit))),
  }
}

export function commitTargetForSession(store, sessionID, container) {
  if (!sessionID) return
  const entry = normalizeCommitTargetStore(store).entries.find((item) => item.sessionID === sessionID)
  if (!entry || !repositoryWithin(container, entry.worktree)) return
  return entry
}

export function rememberCommitTarget(store, entry, limit = DEFAULT_LIMIT) {
  if (!entry?.sessionID || !repositoryWithin(entry.container, entry.worktree))
    return normalizeCommitTargetStore(store, limit)
  const current = normalizeCommitTargetStore(store, limit).entries.filter((item) => item.sessionID !== entry.sessionID)
  return normalizeCommitTargetStore(
    {
      version: STORE_VERSION,
      entries: [{ ...entry, updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now() }, ...current],
    },
    limit,
  )
}

export function forgetCommitTarget(store, sessionID, limit = DEFAULT_LIMIT) {
  const current = normalizeCommitTargetStore(store, limit)
  return { ...current, entries: current.entries.filter((entry) => entry.sessionID !== sessionID) }
}

export function snapshotWorktree(snapshot, directory) {
  const worktree = snapshot?.info?.worktree
  if (typeof worktree === "string" && worktree) return worktree
  if (typeof directory !== "string" || !directory) return
  if (Array.isArray(snapshot?.status) && snapshot.status.length) return directory
  if (typeof snapshot?.info?.branch === "string" || typeof snapshot?.info?.default_branch === "string") return directory
}

export function resolveCommitTarget(input) {
  if (input.directWorktree) return { kind: "selected", directory: input.directWorktree, source: "direct" }
  if (input.rememberedWorktree) return { kind: "selected", directory: input.rememberedWorktree, source: "session" }

  const candidates = Array.isArray(input.candidates)
    ? input.candidates
        .filter((candidate) => candidate && typeof candidate.worktree === "string" && candidate.worktree)
        .filter(
          (candidate, index, list) =>
            list.findIndex((item) => repositoryKey(item.worktree) === repositoryKey(candidate.worktree)) === index,
        )
        .filter((candidate) => Number(candidate.changeCount) > 0)
        .toSorted((left, right) =>
          String(left.name || left.worktree).localeCompare(String(right.name || right.worktree)),
        )
    : []

  if (!candidates.length)
    return {
      kind: "none",
      reason: input.discoveryTruncated
        ? "Repository discovery was truncated before a safe commit target could be selected."
        : "No open changes were found in this project or its discovered repositories.",
    }
  if (candidates.length === 1 && !input.discoveryTruncated)
    return { kind: "selected", directory: candidates[0].worktree, source: "single-dirty" }
  return { kind: "choose", candidates, discoveryTruncated: input.discoveryTruncated === true }
}
