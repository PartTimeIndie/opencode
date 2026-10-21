import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Schema, Stream, Scope, Schedule } from "effect"
import { formatPatch, structuredPatch } from "diff"
import path from "node:path"
import { lstat, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Git } from "@/git"
import { HeadlessAI } from "@/headless-ai"
import { Provider } from "@/provider/provider"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { ConfigCommit } from "@opencode-ai/core/config/commit"
import { AIChain } from "@opencode-ai/core/ai-chain"
import { ModelRequest } from "@opencode-ai/core/model-request"
import { Flock } from "@opencode-ai/core/util/flock"

const PATCH_CONTEXT_LINES = 2_147_483_647
const MAX_PATCH_BYTES = 10_000_000
const MAX_TOTAL_PATCH_BYTES = 10_000_000

const generationFailureReason = (error: unknown) => {
  if (Provider.NoProvidersError.isInstance(error)) return "No model provider available"
  if (Provider.NoModelsError.isInstance(error)) return `No models available for provider ${error.providerID}`
  if (Provider.ModelNotFoundError.isInstance(error))
    return `Model ${error.providerID}/${error.modelID} is not available`
  if (error instanceof Error && error.message) return error.message
  return String(error) || "Unknown error"
}

type DiffOptions = {
  readonly context?: number
}

const emptyPatch = (file: string) => formatPatch(structuredPatch(file, file, "", "", "", "", { context: 0 }))

const nums = (list: Git.Stat[]) =>
  new Map(list.map((item) => [item.file, { additions: item.additions, deletions: item.deletions }] as const))

const merge = (...lists: Git.Item[][]) => {
  const out = new Map<string, Git.Item>()
  lists.flat().forEach((item) => {
    if (!out.has(item.file)) out.set(item.file, item)
  })
  return [...out.values()]
}

const emptyBatch = () => ({ patches: new Map<string, string>(), capped: false })

const parseQuotedPath = (value: string) => {
  let out = ""
  for (let idx = 1; idx < value.length; idx++) {
    const char = value[idx]
    if (char === '"') return { value: out, end: idx + 1 }
    if (char !== "\\") {
      out += char
      continue
    }

    const next = value[++idx]
    if (next === "t") out += "\t"
    else if (next === "n") out += "\n"
    else if (next === "r") out += "\r"
    else if (next === '"' || next === "\\") out += next
    else out += next ?? ""
  }
}

const parsePathToken = (value: string) => {
  if (!value.startsWith('"')) return value.split("\t")[0]
  return parseQuotedPath(value)?.value ?? value
}

const fileFromDiffPath = (value: string | undefined) => {
  if (!value || value === "/dev/null") return
  const file = parsePathToken(value)
  if (file.startsWith("a/") || file.startsWith("b/")) return file.slice(2)
  return file
}

const fileFromGitHeader = (header: string) => {
  if (header.startsWith('"')) {
    const first = parseQuotedPath(header)
    const second = first ? header.slice(first.end).trimStart() : undefined
    if (!second) return
    if (!second.startsWith('"')) return fileFromDiffPath(second)
    return fileFromDiffPath(parseQuotedPath(second)?.value)
  }

  const separator = header.indexOf(" b/")
  if (separator === -1) return
  return fileFromDiffPath(header.slice(separator + 1))
}

const fileFromPatchChunk = (chunk: string) => {
  const next = /^\+\+\+ (.+)$/m.exec(chunk)?.[1]
  const before = /^--- (.+)$/m.exec(chunk)?.[1]
  const file = fileFromDiffPath(next) ?? fileFromDiffPath(before)
  if (file) return file

  const header = /^diff --git (.+)$/m.exec(chunk)?.[1]
  return fileFromGitHeader(header ?? "")
}

const splitGitPatch = (patch: Git.Patch) => {
  const starts = [...patch.text.matchAll(/(?:^|\n)diff --git /g)].map((match) =>
    match[0].startsWith("\n") ? match.index + 1 : match.index,
  )
  const chunks = starts.map((start, index) => patch.text.slice(start, starts[index + 1] ?? patch.text.length))
  if (!patch.truncated) return chunks
  return chunks.slice(0, -1)
}

const batchPatches = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string,
  list: Git.Item[],
  options?: DiffOptions,
) {
  if (list.length === 0) return { patches: new Map<string, string>(), capped: false }

  const result = yield* git.patchAll(cwd, ref, {
    context: options?.context ?? PATCH_CONTEXT_LINES,
    maxOutputBytes: MAX_TOTAL_PATCH_BYTES,
  })

  return {
    patches: splitGitPatch(result).reduce((acc, patch, index) => {
      const file = fileFromPatchChunk(patch) ?? list[index]?.file
      if (!file) return acc
      acc.set(file, (acc.get(file) ?? "") + patch)
      return acc
    }, new Map<string, string>()),
    capped: result.truncated,
  }
})

const nativePatch = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  item: Git.Item,
  options?: DiffOptions,
) {
  const result =
    item.code === "??" || !ref
      ? yield* git.patchUntracked(cwd, item.file, {
          context: options?.context ?? PATCH_CONTEXT_LINES,
          maxOutputBytes: MAX_PATCH_BYTES,
        })
      : yield* git.patch(cwd, ref, item.file, {
          context: options?.context ?? PATCH_CONTEXT_LINES,
          maxOutputBytes: MAX_PATCH_BYTES,
        })
  if (!result.truncated && result.text) return result.text

  return emptyPatch(item.file)
})

const totalPatch = (file: string, patch: string, total: number) => {
  if (total + Buffer.byteLength(patch) <= MAX_TOTAL_PATCH_BYTES) return { patch, capped: false }
  return { patch: emptyPatch(file), capped: true }
}

const patchForItem = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  item: Git.Item,
  batch: { patches: Map<string, string>; capped: boolean },
  capped: boolean,
  options?: DiffOptions,
) {
  if (capped) return emptyPatch(item.file)

  const batched = batch.patches.get(item.file)
  if (batched !== undefined) return batched
  if (item.code !== "??" && batch.capped) return emptyPatch(item.file)
  return yield* nativePatch(git, cwd, ref, item, options)
})

const files = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  list: Git.Item[],
  map: Map<string, { additions: number; deletions: number }>,
  batch: { patches: Map<string, string>; capped: boolean },
  options?: DiffOptions,
) {
  const next: FileDiff[] = []
  let total = 0
  let capped = false

  for (const item of list.toSorted((a, b) => a.file.localeCompare(b.file))) {
    const stat = map.get(item.file) ?? (item.status === "added" ? yield* git.statUntracked(cwd, item.file) : undefined)
    const patch = yield* patchForItem(git, cwd, ref, item, batch, capped, options)
    const result: { patch: string; capped: boolean } = capped
      ? { patch, capped: true }
      : totalPatch(item.file, patch, total)
    capped = capped || result.capped
    if (!capped) {
      total += Buffer.byteLength(result.patch)
      capped = total >= MAX_TOTAL_PATCH_BYTES
    }
    next.push({
      file: item.file,
      patch: result.patch,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      status: item.status,
    })
  }

  return next
})

const diffAgainstRef = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string,
  options?: DiffOptions,
) {
  const [list, stats, extra] = yield* Effect.all([git.diff(cwd, ref), git.stats(cwd, ref), git.status(cwd)], {
    concurrency: 3,
  })
  return yield* files(
    git,
    cwd,
    ref,
    merge(
      list,
      extra.filter((item) => item.code === "??"),
    ),
    nums(stats),
    yield* batchPatches(git, cwd, ref, list, options),
    options,
  )
})

const track = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  options?: DiffOptions,
) {
  if (!ref) return yield* files(git, cwd, ref, yield* git.status(cwd), new Map(), emptyBatch(), options)
  return yield* diffAgainstRef(git, cwd, ref, options)
})

export const Mode = Schema.Literals(["git", "branch"])
export type Mode = Schema.Schema.Type<typeof Mode>

export const Event = {
  BranchUpdated: EventV2.define({
    type: "vcs.branch.updated",
    schema: {
      branch: Schema.optional(Schema.String),
    },
  }),
}

export const Info = Schema.Struct({
  branch: Schema.optional(Schema.String),
  default_branch: Schema.optional(Schema.String),
  worktree: Schema.optional(Schema.String),
}).annotate({ identifier: "VcsInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export const FileDiff = Schema.Struct({
  file: Schema.String,
  // Mirrors Snapshot.FileDiff (see #26574). The current producer always
  // populates patch, but loosening matches the sibling schema so a
  // future code path that omits it can't crash /instance/vcs/diff.
  patch: Schema.optional(Schema.String),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.optional(Schema.Literals(["added", "deleted", "modified"])),
}).annotate({ identifier: "VcsFileDiff" })
export type FileDiff = Schema.Schema.Type<typeof FileDiff>

export const FileStatus = Schema.Struct({
  file: Schema.String,
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.Literals(["added", "deleted", "modified"]),
}).annotate({ identifier: "VcsFileStatus" })
export type FileStatus = Schema.Schema.Type<typeof FileStatus>

export const ApplyInput = Schema.Struct({
  patch: Schema.String,
})
export type ApplyInput = Schema.Schema.Type<typeof ApplyInput>

export const ApplyResult = Schema.Struct({
  applied: Schema.Boolean,
})
export type ApplyResult = Schema.Schema.Type<typeof ApplyResult>

export const GitHistoryQuery = Schema.Struct({
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
})
export type GitHistoryQuery = Schema.Schema.Type<typeof GitHistoryQuery>

export const GitFileStatus = Schema.Struct({
  file: Schema.String,
  code: Schema.String,
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.Literals(["added", "deleted", "modified"]),
  staged: Schema.Boolean,
  unstaged: Schema.Boolean,
  untracked: Schema.Boolean,
  conflicted: Schema.Boolean,
}).annotate({ identifier: "VcsGitFileStatus" })
export type GitFileStatus = Schema.Schema.Type<typeof GitFileStatus>

export const GitCommit = Schema.Struct({
  hash: Schema.String,
  short: Schema.String,
  parents: Schema.Array(Schema.String),
  author: Schema.String,
  email: Schema.String,
  date: Schema.String,
  refs: Schema.Array(Schema.String),
  subject: Schema.String,
  body: Schema.String,
}).annotate({ identifier: "VcsGitCommit" })
export type GitCommit = Schema.Schema.Type<typeof GitCommit>

export const GitBranch = Schema.Struct({
  name: Schema.String,
  current: Schema.Boolean,
  remote: Schema.Boolean,
  upstream: Schema.optional(Schema.String),
  tracking: Schema.optional(Schema.String),
  hash: Schema.optional(Schema.String),
  date: Schema.optional(Schema.String),
}).annotate({ identifier: "VcsGitBranch" })
export type GitBranch = Schema.Schema.Type<typeof GitBranch>

export const GitRemote = Schema.Struct({
  name: Schema.String,
  fetch: Schema.optional(Schema.String),
  push: Schema.optional(Schema.String),
}).annotate({ identifier: "VcsGitRemote" })
export type GitRemote = Schema.Schema.Type<typeof GitRemote>

export const GitTag = Schema.Struct({
  name: Schema.String,
  hash: Schema.optional(Schema.String),
  date: Schema.optional(Schema.String),
}).annotate({ identifier: "VcsGitTag" })
export type GitTag = Schema.Schema.Type<typeof GitTag>

export const GitStash = Schema.Struct({
  selector: Schema.String,
  hash: Schema.optional(Schema.String),
  message: Schema.String,
}).annotate({ identifier: "VcsGitStash" })
export type GitStash = Schema.Schema.Type<typeof GitStash>

export const GitConflict = Schema.Struct({
  file: Schema.String,
}).annotate({ identifier: "VcsGitConflict" })
export type GitConflict = Schema.Schema.Type<typeof GitConflict>

export const GitOperation = Schema.Struct({
  inProgress: Schema.Boolean,
  type: Schema.optional(Schema.Literals(["merge", "cherry-pick", "rebase", "revert"])),
}).annotate({ identifier: "VcsGitOperation" })
export type GitOperation = Schema.Schema.Type<typeof GitOperation>

export const GitSnapshot = Schema.Struct({
  info: Info,
  status: Schema.Array(GitFileStatus),
  history: Schema.Array(GitCommit),
  branches: Schema.Array(GitBranch),
  remotes: Schema.Array(GitRemote),
  tags: Schema.Array(GitTag),
  stashes: Schema.Array(GitStash),
  conflicts: Schema.Array(GitConflict),
  operation: GitOperation,
}).annotate({ identifier: "VcsGitSnapshot" })
export type GitSnapshot = Schema.Schema.Type<typeof GitSnapshot>

export const GitDiscoverQuery = Schema.Struct({
  maxDepth: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(3)),
  ),
})
export type GitDiscoverQuery = Schema.Schema.Type<typeof GitDiscoverQuery>

export const DiscoveredRepo = Schema.Struct({
  worktree: Schema.String,
  name: Schema.String,
}).annotate({ identifier: "VcsDiscoveredRepo" })
export type DiscoveredRepo = Schema.Schema.Type<typeof DiscoveredRepo>

export const GitDiscoverResult = Schema.Struct({
  repositories: Schema.Array(DiscoveredRepo),
  truncated: Schema.Boolean,
}).annotate({ identifier: "VcsGitDiscoverResult" })
export type GitDiscoverResult = Schema.Schema.Type<typeof GitDiscoverResult>

export const GitAction = Schema.Literals([
  "stage",
  "unstage",
  "discard",
  "commit",
  "commitAuto",
  "fetch",
  "pull",
  "push",
  "sync",
  "merge",
  "cherryPick",
  "squashRange",
  "stashSave",
  "stashApply",
  "stashPop",
  "stashDrop",
  "checkoutBranch",
  "createBranch",
  "deleteBranch",
  "ignore",
  "continueOperation",
  "abortOperation",
])
export type GitAction = Schema.Schema.Type<typeof GitAction>

export const GitActionInput = Schema.Struct({
  action: GitAction,
  files: Schema.optional(Schema.Array(Schema.String)),
  message: Schema.optional(Schema.String),
  remote: Schema.optional(Schema.String),
  commitModel: Schema.optional(Schema.String),
  // Validated model-chain snapshot from the app settings store. AI commit message
  // generation runs the chain steps in order; a present chain wins over commitModel.
  commitChain: Schema.optional(Schema.Unknown),
  // Set by the Git Workbench plugin when the user did not opt out of the default
  // model chain. The server only reads commitChain, never resolves chains itself.
  useChain: Schema.optional(Schema.Boolean),
  branch: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  start: Schema.optional(Schema.String),
  end: Schema.optional(Schema.String),
  force: Schema.optional(Schema.Boolean),
  pattern: Schema.optional(Schema.String),
}).annotate({ identifier: "VcsGitActionInput" })
export type GitActionInput = Schema.Schema.Type<typeof GitActionInput>

export type CommitChainResolution =
  | { status: "none" }
  | { status: "chain"; steps: AIChain.AIChainStep[] }
  | { status: "invalid"; reason: string }

/**
 * Validates the commit model-chain snapshot clients may attach to git actions.
 * The snapshot is accepted as a bare step array or as `{ steps: [...] }` and must
 * satisfy the same core chain contract as every other chain consumer. An invalid
 * snapshot fails closed: commit message generation must never silently fall back
 * to a single hard-coded model instead of the user's configured fallback path.
 */
export function resolveCommitChain(value: unknown): CommitChainResolution {
  if (value === undefined) return { status: "none" }
  const steps = typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as { steps?: unknown }).steps
    : value
  const normalized = AIChain.normalizeAIChainSteps(steps)
  const valid = normalized.steps
  if (normalized.error || !valid?.length)
    return { status: "invalid", reason: normalized.error ?? "chain must contain at least one step" }
  return { status: "chain", steps: valid }
}

export const GitActionResult = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.optional(Schema.String),
  output: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.String),
}).annotate({ identifier: "VcsGitActionResult" })
export type GitActionResult = Schema.Schema.Type<typeof GitActionResult>

export class PatchApplyError extends Schema.TaggedErrorClass<PatchApplyError>()("VcsPatchApplyError", {
  message: Schema.String,
  reason: Schema.Literals(["non-git", "not-clean"]),
}) {}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly branch: () => Effect.Effect<string | undefined>
  readonly defaultBranch: () => Effect.Effect<string | undefined>
  readonly status: () => Effect.Effect<FileStatus[]>
  readonly diff: (mode: Mode, options?: DiffOptions) => Effect.Effect<FileDiff[]>
  readonly diffRaw: () => Effect.Effect<string>
  readonly apply: (input: ApplyInput) => Effect.Effect<ApplyResult, PatchApplyError>
  readonly discoverRepositories: (input?: GitDiscoverQuery) => Effect.Effect<GitDiscoverResult>
  readonly gitSnapshot: (input?: GitHistoryQuery) => Effect.Effect<GitSnapshot>
  readonly gitAction: (input: GitActionInput) => Effect.Effect<GitActionResult>
}

interface State {
  current: string | undefined
  root: Git.Base | undefined
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Vcs") {}

const fields = (text: string) => text.split("\x1f")
const records = (text: string) =>
  text
    .split("\x1e")
    .map((item) => item.trim())
    .filter(Boolean)

const output = (result: Git.Result) => [result.text(), result.stderr.toString("utf8")].filter(Boolean).join("\n").trim()
const exists = (file: string) =>
  stat(file)
    .then(() => true)
    .catch(() => false)

const gitResult = (result: Git.Result, fallback: string): GitActionResult => ({
  ok: result.exitCode === 0,
  message: result.exitCode === 0 ? undefined : fallback,
  output: output(result),
})

const staged = (code: string) => code[0] !== " " && code[0] !== "?"
const unstaged = (code: string) => code[1] !== " " || code === "??"
const conflicted = (code: string) => code.includes("U") || code === "AA" || code === "DD"

const parseTracking = (value: string | undefined) => {
  if (!value) return undefined
  const trimmed = value.trim()
  return trimmed.length ? trimmed : undefined
}

const COMMIT_DIFF_CONTEXT_BYTES = 180_000
const COMMIT_DIFF_CAPTURE_BYTES = 2_000_000
const COMMIT_DIFF_MIN_FILE_BYTES = 700
const COMMIT_DIFF_MAX_FILE_BYTES = 16_000
const COMMIT_DIFF_RETRY_CONTEXT_BYTES = 40_000
const COMMIT_SUMMARY_CHUNK_FILES = 10
const COMMIT_SUMMARY_CHUNK_BYTES = 55_000

type CommitDiffCapture = {
  stat: string
  patch: string
  patchTruncated: boolean
  truncated: boolean
}

const stagedStats = (text: string) =>
  new Map(
    text
      .split("\0")
      .filter(Boolean)
      .flatMap((item) => {
        const first = item.indexOf("\t")
        const second = item.indexOf("\t", first + 1)
        if (first === -1 || second === -1) return []
        const file = item.slice(second + 1)
        if (!file) return []
        const additions = item.slice(0, first) === "-" ? 0 : Number.parseInt(item.slice(0, first) || "0", 10)
        const deletions =
          item.slice(first + 1, second) === "-" ? 0 : Number.parseInt(item.slice(first + 1, second) || "0", 10)
        return [
          [
            file,
            {
              additions: Number.isFinite(additions) ? additions : 0,
              deletions: Number.isFinite(deletions) ? deletions : 0,
            },
          ] as const,
        ]
      }),
  )

const stagedDiffContext = (
  status: GitFileStatus[],
  stat: string,
  patch: string,
  patchTruncated: boolean,
  truncated: boolean,
) => {
  const patches = splitGitPatch({ text: patch, truncated: patchTruncated })
  const byFile = patches.reduce((acc, item) => {
    const file = fileFromPatchChunk(item)
    if (!file) return acc
    acc.set(file, (acc.get(file) ?? "") + item)
    return acc
  }, new Map<string, string>())
  const fileBudget = Math.min(
    COMMIT_DIFF_MAX_FILE_BYTES,
    Math.max(
      COMMIT_DIFF_MIN_FILE_BYTES,
      Math.floor((COMMIT_DIFF_CONTEXT_BYTES - stat.length) / Math.max(status.length, 1)) - 220,
    ),
  )
  const files = status.map((item) => {
    const header = `### ${item.file}\n${item.code} ${item.status} +${item.additions} -${item.deletions}`
    const text = byFile.get(item.file)
    if (!text) return `${header}\n(no textual staged patch available; likely binary, mode-only, or too large)`
    if (text.length <= fileBudget) return `${header}\n${text.trim()}`
    return `${header}\n${text.slice(0, fileBudget).trim()}\n[patch clipped for this file]`
  })
  return [
    "Staged diff stat:",
    stat.trim() || "No stat available.",
    "",
    truncated
      ? "Per-file staged patches (all changed files are listed; captured patch output was truncated):"
      : "Per-file staged patches (all changed files are listed; very large per-file patches may be clipped):",
    files.join("\n\n") || "No textual patches available.",
  ].join("\n")
}

const genericCommitSubject = (subject: string) =>
  /^(?:\w+(?:\([^)]+\))?:\s*)?update\s+\d+\s+files?$/i.test(subject) ||
  /^(?:\w+(?:\([^)]+\))?:\s*)?(?:change|modify|touch)(?:es|ed)?\s+\d+\s+files?$/i.test(subject)

const commitHistorySample = (history: GitCommit[]) =>
  history
    .slice(0, 20)
    .map((item) => {
      const body = item.body
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 2)
        .join(" ")
      return body ? `- ${item.subject}\n  ${body.slice(0, 180)}` : `- ${item.subject}`
    })
    .join("\n")

const fallbackCommitAreas = (status: GitFileStatus[]) => {
  const areas = new Set(
    status.flatMap((item) => {
      const segments = item.file.split(/[\\/]/).filter(Boolean)
      if (!segments.length) return []
      // The area is the directory path (capped at two levels); root-level files use their own name.
      const directory = segments.length > 1 ? segments.slice(0, -1) : segments
      return [directory.slice(0, 2).join("/")]
    }),
  )
  const list = [...areas]
  if (!list.length) return "project files"
  return list.length === 1 ? list[0] : `${list[0]} and ${list.length - 1} more areas`
}

const fallbackCommitMessage = (status: GitFileStatus[]) => {
  const packages = Array.from(
    new Set(
      status.flatMap((item) => {
        const match = /^packages[\\/]([^\\/]+)/i.exec(item.file)
        return match ? [match[1]] : []
      }),
    ),
  )
  const scope = packages.length === 1 ? `(${packages[0]})` : ""
  const areas = fallbackCommitAreas(status)
  if (status.every((item) => /(^|[\\/])(docs?|specs?)[\\/]|\.md$/.test(item.file))) return `docs${scope}: update ${areas}`
  if (status.every((item) => /(^|[\\/])(test|tests|e2e)[\\/]|\.test\.|\.spec\./.test(item.file)))
    return `test${scope}: update ${areas}`
  if (status.every((item) => item.status === "added" || item.untracked)) return `feat${scope}: add ${areas}`
  return `chore${scope}: update ${areas}`
}

const cleanCommitMessage = (message: string): string | undefined => {
  const lines = message
    .replace(/```[a-zA-Z]*\n?/g, "")
    .replace(/```/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !/^(here(?:'s| is)?|commit message|sure|the (?:new )?commit message is?)[:\-]?\s*$/i.test(line))
  const meaningful = lines.filter(Boolean)
  const subject = meaningful[0]?.replace(/^["'*\s]+|["'*\s]+$/g, "")
  if (!subject) return undefined
  if (genericCommitSubject(subject)) return undefined
  const body = meaningful.slice(1, 10).filter((line) => !/^[-*]\s*$/i.test(line))
  return body.length ? [subject.slice(0, 100), ...body].join("\n") : subject.slice(0, 100)
}

const commitRetrySchedule = Schedule.exponential("500 millis").pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(1)),
)

const isQuotaCommitError = (error: unknown): boolean => {
  const text = commitErrorMessage(error)
  return /\b(resource_exhausted|usage limit|quota|insufficient credits|insufficient balance|insufficient funds|payment required|billing|402|403)\b/i.test(
    text,
  )
}

const isRetryableCommitError = (error: unknown): boolean => {
  // Quota, billing, and permission failures stay exhausted for hours or days; retrying them only burns more attempts.
  if (isQuotaCommitError(error)) return false
  const text = commitErrorMessage(error)
  return /\b(429|503|504|529|rate.?limit|timeout|timed?\s*out|temporarily|overloaded|service\s+unavailable|econnreset|socket\s+hang)\b/i.test(
    text,
  )
}

const commitErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const shouldRetryWithCompactContext = (error: unknown): boolean =>
  /\b(context|token|tokens|payload|too large|request size|maximum length|input length|413)\b/i.test(
    commitErrorMessage(error),
  )

const compactCommitDiffContext = (diffContext: string) => {
  if (diffContext.length <= COMMIT_DIFF_RETRY_CONTEXT_BYTES) return diffContext
  return [
    diffContext.slice(0, COMMIT_DIFF_RETRY_CONTEXT_BYTES),
    "",
    `...diff context truncated from ${diffContext.length} characters after the full request was rejected. Use the file manifest and visible hunks above to write the commit message.`,
  ].join("\n")
}

const commitChunkStat = (status: GitFileStatus[]) =>
  status.map((item) => `${item.code} ${item.status} +${item.additions} -${item.deletions}\t${item.file}`).join("\n")

const commitContextChunks = (status: GitFileStatus[], diff: CommitDiffCapture) => {
  const chunks: GitFileStatus[][] = []
  const push = (items: GitFileStatus[]) => {
    if (items.length) chunks.push(items)
  }
  const result = status.reduce(
    (acc, item) => {
      const itemContext = stagedDiffContext(
        [item],
        commitChunkStat([item]),
        diff.patch,
        diff.patchTruncated,
        diff.truncated,
      )
      if (
        acc.items.length &&
        (acc.items.length >= COMMIT_SUMMARY_CHUNK_FILES || acc.bytes + itemContext.length > COMMIT_SUMMARY_CHUNK_BYTES)
      ) {
        push(acc.items)
        return { items: [item], bytes: itemContext.length }
      }
      return { items: [...acc.items, item], bytes: acc.bytes + itemContext.length }
    },
    { items: [] as GitFileStatus[], bytes: 0 },
  )
  push(result.items)
  return chunks.map((items) => ({
    items,
    context: stagedDiffContext(items, commitChunkStat(items), diff.patch, diff.patchTruncated, diff.truncated),
  }))
}

export const llmCommitMessage = Effect.fnUntraced(function* (
  headlessAI: HeadlessAI.Interface,
  status: GitFileStatus[],
  diff: CommitDiffCapture,
  history: string,
  commit?: ConfigCommit.Commit,
  chain?: AIChain.AIChainStep[],
) {
  const modelRef = commit?.model ?? ConfigCommit.DEFAULT_COMMIT_MODEL
  const manifest = status
    .map((item) => `${item.code} ${item.status} +${item.additions} -${item.deletions}\t${item.file}`)
    .join("\n")
  const system = [
    "You are an expert software engineer writing a git commit message.",
    "Read the staged diff and recent commit history, infer the repository's commit style, then produce ONE commit message that a senior engineer would write.",
    "Describe what changed and why it matters, not just which files changed.",
  ].join(" ")
  const commitUser = (context: string) =>
    [
      "Write ONE commit message for these staged changes. Rules:",
      "- Output ONLY the commit message: no preamble, no explanation, no markdown fences, no surrounding quotes.",
      '- Subject (first line): imperative mood ("add", "fix", "refactor"), lowercase, no trailing period, <= 72 chars.',
      "- Use Conventional Commits when the history uses them: a type, optionally followed by (scope). Pick the type matching the PRIMARY change:",
      "  feat=new capability, fix=bug fix, refactor=no behavior change, perf=performance, docs=documentation only, test=tests only, build/ci=tooling & pipeline, style=formatting only, chore=maintenance/cleanup.",
      "- Infer the scope from the affected package/module or common directory; omit it if unclear.",
      "- Mirror the existing repo style exactly (capitalization, scope usage, emoji/keyword conventions).",
      '- Add a blank line then a short body ONLY when it adds useful context. Keep body lines <= 72 chars; use "- " bullets for several notable changes and explain the WHY for non-obvious edits.',
      "- For a trivial change (config bump, one-liner) a subject alone is best.",
      '- Never describe the commit by file count. Avoid generic messages like "update 71 files" or "modify files".',
      "",
      "Recent commit history (mimic this style):",
      history || "No recent commit history available.",
      "",
      "Staged file manifest (git-code  status  +additions -deletions  path):",
      manifest || "No files available.",
      "",
      "Staged diff context:",
      context || "No diff available.",
    ].join("\n")
  const summarySystem = [
    "You are a commit-analysis subagent.",
    "Read one safe chunk of staged git changes and report only the important semantic changes.",
    "Do not write the final commit message.",
  ].join(" ")
  const summaryUser = (chunk: { items: GitFileStatus[]; context: string }, index: number, total: number) =>
    [
      `Analyze staged change chunk ${index + 1} of ${total}.`,
      "Return 3-7 concise bullets covering what changed and why it matters.",
      "Mention module/package scope when clear. Avoid file-count summaries.",
      "",
      "Chunk file manifest:",
      chunk.items
        .map((item) => `${item.code} ${item.status} +${item.additions} -${item.deletions}\t${item.file}`)
        .join("\n"),
      "",
      "Chunk diff context:",
      chunk.context,
    ].join("\n")
  const summaryCommitUser = (reports: string) =>
    [
      "Write ONE commit message from these subagent reports. Rules:",
      "- Output ONLY the commit message: no preamble, no explanation, no markdown fences, no surrounding quotes.",
      "- Subject (first line): imperative mood, lowercase, no trailing period, <= 72 chars.",
      "- Use Conventional Commits when the history uses them; choose the type matching the PRIMARY change.",
      "- Infer scope from the affected package/module; omit if unclear.",
      "- Add a short body ONLY when it adds useful context. Keep body lines <= 72 chars.",
      "- Never describe the commit by file count.",
      "",
      "Recent commit history (mimic this style):",
      history || "No recent commit history available.",
      "",
      "Full staged file manifest:",
      manifest || "No files available.",
      "",
      "Subagent reports:",
      reports,
    ].join("\n")
  const repairCommitUser = (draft: string, prompt: string) =>
    [
      "The previous answer was rejected as an unusable git commit message.",
      "Rewrite it into ONE specific, useful commit message. Rules:",
      "- Output ONLY the commit message: no preamble, no explanation, no markdown fences, no surrounding quotes.",
      "- Subject: imperative mood, lowercase, no trailing period, <= 72 chars.",
      "- Use Conventional Commits when appropriate.",
      "- Do not mention file counts. Do not say update/modify/change N files.",
      "- Describe the primary semantic change, not the mechanics.",
      "",
      "Rejected answer:",
      draft.trim() || "<empty>",
      "",
      "Original request and context:",
      prompt,
    ].join("\n")
  const generate = (systemPrompt: string, userPrompt: string, maxOutputTokens = ModelRequest.helperGeneration(commit?.generation).maxTokens) =>
    headlessAI
      .text({
        // A present chain replaces the single model for commit generation; the
        // chain walk itself owns quota/transient advancement between steps.
        model: chain ? undefined : modelRef,
        variant: chain ? undefined : commit?.variant,
        ...(chain ? { chain } : {}),
        generation: {
          ...commit?.generation,
          temperature: commit?.generation?.temperature ?? 0.2,
          maxTokens: maxOutputTokens,
        },
        options: commit?.options,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        metadata: { kind: "vcs.commit_message" },
        // One transport retry is enough; quota and billing failures fail fast to the fallback path.
        maxRetries: 1,
      })
      .pipe(Effect.retry({ while: isRetryableCommitError, schedule: commitRetrySchedule }))
  const generateWithCompactContext = (
    systemPrompt: string,
    userFromContext: (context: string) => string,
    context: string,
    maxOutputTokens?: number,
  ) =>
    generate(systemPrompt, userFromContext(context), maxOutputTokens).pipe(
      Effect.catch((error) => {
        const compact = compactCommitDiffContext(context)
        if (compact === context || !shouldRetryWithCompactContext(error)) return Effect.fail(error)
        return Effect.gen(function* () {
          yield* Effect.logWarning("ai commit generation retrying with compact diff context", {
            model: modelRef,
            error: commitErrorMessage(error),
            originalBytes: context.length,
            compactBytes: compact.length,
          })
          return yield* generate(systemPrompt, userFromContext(compact), maxOutputTokens).pipe(
            Effect.catch((compactError) =>
              Effect.fail(
                new Error(`${commitErrorMessage(error)}; compact retry failed: ${commitErrorMessage(compactError)}`),
              ),
            ),
          )
        })
      }),
    )
  const diffContext = stagedDiffContext(status, diff.stat, diff.patch, diff.patchTruncated, diff.truncated)
  const chunks = commitContextChunks(status, diff)
  yield* Effect.logInfo("ai commit generation starting", {
    model: modelRef,
    chain: chain?.map(AIChain.aiChainStepKey),
    files: status.length,
    chunks: chunks.length,
    statBytes: diff.stat.length,
    patchBytes: diff.patch.length,
    patchTruncated: diff.patchTruncated,
    truncated: diff.truncated,
  })
  const summarizeChunks = Effect.gen(function* () {
    const reports = yield* Effect.forEach(
      chunks,
      (chunk, index) =>
        generateWithCompactContext(
          summarySystem,
          (context) => summaryUser({ ...chunk, context }, index, chunks.length),
          chunk.context,
        ).pipe(Effect.map((report) => `Chunk ${index + 1}:\n${report.text.trim().slice(0, 1_500)}`)),
      { concurrency: 3 },
    )
    const prompt = summaryCommitUser(reports.join("\n\n"))
    return { prompt, result: yield* generate(system, prompt) }
  })
  const generated =
    chunks.length > 1
      ? yield* summarizeChunks.pipe(
          // One compact single-shot request is cheaper than re-running every chunk; quota failures fail fast instead.
          Effect.catch((error) => {
            if (isQuotaCommitError(error)) return Effect.fail(error)
            return Effect.gen(function* () {
              yield* Effect.logWarning("ai commit chunk summarization failed, retrying once with a compact request", {
                model: modelRef,
                error: commitErrorMessage(error),
                chunks: chunks.length,
              })
              const compact = compactCommitDiffContext(diffContext)
              const prompt = commitUser(compact)
              return { prompt, result: yield* generate(system, prompt) }
            })
          }),
        )
      : { prompt: commitUser(diffContext), result: yield* generateWithCompactContext(system, commitUser, diffContext) }
  const cleaned = cleanCommitMessage(generated.result.text)
  if (cleaned) return { message: cleaned }
  yield* Effect.logWarning("ai commit message rejected, retrying repair", {
    model: modelRef,
    sample: generated.result.text.trim().slice(0, 200),
  })
  const repaired = yield* generate(system, repairCommitUser(generated.result.text, generated.prompt))
  const repairedCleaned = cleanCommitMessage(repaired.text)
  if (repairedCleaned) return { message: repairedCleaned }
  const fallback = fallbackCommitMessage(status)
  yield* Effect.logWarning("ai commit message repair failed, using local fallback", {
    model: modelRef,
    fallback,
    sample: repaired.text.trim().slice(0, 200),
  })
  return {
    message: fallback,
    notice: "The model message was unusable; committed with a local fallback message.",
  }
})

const DISCOVERY_REPOSITORY_LIMIT = 200
const DISCOVERY_PRUNED_DIRECTORIES = new Set([
  "__pycache__",
  "bower_components",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
])

async function discoverRepositories(root: string, maxDepth: number): Promise<GitDiscoverResult> {
  const repositories: DiscoveredRepo[] = []

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (repositories.length > DISCOVERY_REPOSITORY_LIMIT) return
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git") continue
      const worktree = path.join(directory, entry.name)
      const marker = await lstat(path.join(worktree, ".git"))
        .then(() => true)
        .catch(() => false)
      if (marker) {
        repositories.push({ worktree, name: entry.name })
        if (repositories.length > DISCOVERY_REPOSITORY_LIMIT) return
        if (
          depth < maxDepth &&
          !entry.name.startsWith(".") &&
          !DISCOVERY_PRUNED_DIRECTORIES.has(entry.name.toLowerCase())
        )
          await walk(worktree, depth + 1)
        continue
      }
      if (depth >= maxDepth || entry.name.startsWith(".") || DISCOVERY_PRUNED_DIRECTORIES.has(entry.name.toLowerCase()))
        continue
      await walk(worktree, depth + 1)
    }
  }

  await walk(root, 1)
  return {
    repositories: repositories
      .slice(0, DISCOVERY_REPOSITORY_LIMIT)
      .toSorted((a, b) => a.worktree.localeCompare(b.worktree)),
    truncated: repositories.length > DISCOVERY_REPOSITORY_LIMIT,
  }
}

const live: Layer.Layer<Service, never, Git.Service | EventV2Bridge.Service | HeadlessAI.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const events = yield* EventV2Bridge.Service
    const headlessAI = yield* HeadlessAI.Service
    const config = yield* Effect.serviceOption(Config.Service)
    const scope = yield* Scope.Scope

    const state = yield* InstanceState.make<State>(
      Effect.fn("Vcs.state")(function* (ctx) {
        if (ctx.project.vcs !== "git") {
          return { current: undefined, root: undefined }
        }

        const get = Effect.fnUntraced(function* () {
          return yield* git.branch(ctx.directory)
        })
        const [current, root] = yield* Effect.all([git.branch(ctx.directory), git.defaultBranch(ctx.directory)], {
          concurrency: 2,
        })
        const value = { current, root }

        const unsubscribe = yield* events.listen((event) => {
          if (event.type !== Watcher.Event.Updated.type || event.location?.directory !== ctx.directory)
            return Effect.void
          const data = event.data as EventV2.Data<typeof Watcher.Event.Updated>
          if (!data.file.endsWith("HEAD")) return Effect.void
          return Effect.gen(function* () {
            const next = yield* get()
            if (next !== value.current) {
              value.current = next
              yield* events.publish(Event.BranchUpdated, { branch: next })
            }
          })
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        return value
      }),
    )

    return Service.of({
      init: Effect.fn("Vcs.init")(function* () {
        yield* InstanceState.get(state).pipe(Effect.forkIn(scope))
      }),
      branch: Effect.fn("Vcs.branch")(function* () {
        return yield* InstanceState.use(state, (x) => x.current)
      }),
      defaultBranch: Effect.fn("Vcs.defaultBranch")(function* () {
        return yield* InstanceState.use(state, (x) => x.root?.name)
      }),
      status: Effect.fn("Vcs.status")(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return []
        const ref = (yield* git.hasHead(ctx.directory)) ? "HEAD" : undefined
        const [list, stats] = yield* Effect.all(
          [git.status(ctx.directory), ref ? git.stats(ctx.directory, ref) : Effect.succeed([])],
          { concurrency: 2 },
        )
        const map = nums(stats)
        return yield* Effect.forEach(
          list.toSorted((a, b) => a.file.localeCompare(b.file)),
          (item) =>
            Effect.gen(function* () {
              const stat =
                map.get(item.file) ??
                (item.status === "added" ? yield* git.statUntracked(ctx.worktree, item.file) : undefined)
              return {
                file: item.file,
                additions: stat?.additions ?? 0,
                deletions: stat?.deletions ?? 0,
                status: item.status,
              } satisfies FileStatus
            }),
        )
      }),
      diff: Effect.fn("Vcs.diff")(function* (mode: Mode, options?: DiffOptions) {
        const value = yield* InstanceState.get(state)
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return []
        if (mode === "git") {
          return yield* track(git, ctx.directory, (yield* git.hasHead(ctx.directory)) ? "HEAD" : undefined, options)
        }

        if (!value.root) return []
        if (value.current && value.current === value.root.name) return []
        const ref = yield* git.mergeBase(ctx.directory, value.root.ref)
        if (!ref) return []
        return yield* diffAgainstRef(git, ctx.directory, ref, options)
      }),
      diffRaw: Effect.fn("Vcs.diffRaw")(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return ""
        const [hasHead, status] = yield* Effect.all([git.hasHead(ctx.directory), git.status(ctx.directory)], {
          concurrency: 2,
        })
        const tracked = hasHead ? (yield* git.patchAll(ctx.directory, "HEAD")).text : ""
        const untracked = yield* Effect.forEach(
          status.filter((item) => item.code === "??"),
          (item) => git.patchUntracked(ctx.directory, item.file).pipe(Effect.map((patch) => patch.text)),
        )
        return [tracked, ...untracked].filter(Boolean).join("\n")
      }),
      apply: Effect.fn("Vcs.apply")(function* (input: ApplyInput) {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") {
          return yield* new PatchApplyError({
            message: "Patch can't be applied because the project is not git-based",
            reason: "non-git",
          })
        }
        const applied = yield* git.applyPatch(ctx.directory, input.patch)
        if (applied.exitCode !== 0) {
          return yield* new PatchApplyError({
            message: "Patch can't be applied",
            reason: "not-clean",
          })
        }
        return { applied: true }
      }),
      discoverRepositories: Effect.fn("Vcs.discoverRepositories")(function* (input?: GitDiscoverQuery) {
        const ctx = yield* InstanceState.context
        return yield* Effect.promise(() =>
          discoverRepositories(ctx.directory, Math.min(Math.max(input?.maxDepth ?? 3, 1), 3)),
        )
      }),
      gitSnapshot: Effect.fn("Vcs.gitSnapshot")(function* (input?: GitHistoryQuery) {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") {
          return {
            info: {},
            status: [],
            history: [],
            branches: [],
            remotes: [],
            tags: [],
            stashes: [],
            conflicts: [],
            operation: { inProgress: false },
          }
        }

        const ref = (yield* git.hasHead(ctx.directory)) ? "HEAD" : undefined
        const [
          branch,
          default_branch,
          statusList,
          stats,
          history,
          branches,
          remotes,
          tags,
          stashes,
          conflicts,
          operation,
        ] = yield* Effect.all(
          [
            git.branch(ctx.directory),
            git.defaultBranch(ctx.directory).pipe(Effect.map((item) => item?.name)),
            git.status(ctx.directory),
            ref ? git.stats(ctx.directory, ref) : Effect.succeed([]),
            gitHistory(git, ctx.directory, input?.limit ?? 200),
            gitBranches(git, ctx.directory),
            gitRemotes(git, ctx.directory),
            gitTags(git, ctx.directory),
            gitStashes(git, ctx.directory),
            gitConflicts(git, ctx.directory),
            gitOperation(git, ctx.directory),
          ],
          { concurrency: "unbounded" },
        )
        const map = nums(stats)
        return {
          info: { branch, default_branch, worktree: ctx.worktree },
          status: statusList
            .toSorted((a, b) => a.file.localeCompare(b.file))
            .map((item) => {
              const stat = map.get(item.file)
              return {
                file: item.file,
                code: item.code,
                additions: stat?.additions ?? 0,
                deletions: stat?.deletions ?? 0,
                status: item.status,
                staged: staged(item.code),
                unstaged: unstaged(item.code),
                untracked: item.code === "??",
                conflicted: conflicted(item.code),
              } satisfies GitFileStatus
            }),
          history,
          branches,
          remotes,
          tags,
          stashes,
          conflicts,
          operation,
        } satisfies GitSnapshot
      }),
      gitAction: Effect.fn("Vcs.gitAction")(function* (input: GitActionInput) {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return { ok: false, message: "Project is not a git repository" }
        const commit =
          config._tag === "Some" ? yield* config.value.get().pipe(Effect.map((cfg) => cfg.commit)) : undefined
        return yield* gitAction(git, headlessAI, ctx.directory, input, commit)
      }),
    })
  }),
)

const gitHistory = Effect.fnUntraced(function* (git: Git.Interface, cwd: string, limit: number) {
  const result = yield* git.run(
    [
      "log",
      "--all",
      `--max-count=${Math.min(Math.max(limit, 1), 1000)}`,
      "--date=iso-strict",
      "--decorate=short",
      "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%D%x1f%s%x1f%b%x1e",
    ],
    { cwd, maxOutputBytes: 2_000_000 },
  )
  if (result.exitCode !== 0) return []
  return records(result.text()).flatMap((record) => {
    const item = fields(record)
    const hash = item[0]
    const short = item[1]
    if (!hash || !short) return []
    return [
      {
        hash,
        short,
        parents: (item[2] ?? "").split(" ").filter(Boolean),
        author: item[3] ?? "",
        email: item[4] ?? "",
        date: item[5] ?? "",
        refs: (item[6] ?? "")
          .split(",")
          .map((ref) => ref.trim())
          .filter(Boolean),
        subject: item[7] ?? "",
        body: item.slice(8).join("\x1f").trim(),
      } satisfies GitCommit,
    ]
  })
})

const gitBranches = Effect.fnUntraced(function* (git: Git.Interface, cwd: string) {
  const result = yield* git.run(
    [
      "for-each-ref",
      "--format=%(refname)\x1f%(refname:short)\x1f%(HEAD)\x1f%(upstream:short)\x1f%(upstream:track)\x1f%(objectname:short)\x1f%(committerdate:iso-strict)\x1e",
      "refs/heads",
      "refs/remotes",
    ],
    { cwd, maxOutputBytes: 600_000 },
  )
  if (result.exitCode !== 0) return []
  return records(result.text()).flatMap((record) => {
    const item = fields(record)
    const fullName = item[0]
    const name = item[1]
    if (!name || name.endsWith("/HEAD")) return []
    return [
      {
        name,
        current: item[2] === "*",
        remote: fullName.startsWith("refs/remotes/"),
        upstream: item[3] || undefined,
        tracking: parseTracking(item[4]),
        hash: item[5] || undefined,
        date: item[6] || undefined,
      } satisfies GitBranch,
    ]
  })
})

const gitRemotes = Effect.fnUntraced(function* (git: Git.Interface, cwd: string) {
  const result = yield* git.run(["remote", "-v"], { cwd, maxOutputBytes: 100_000 })
  if (result.exitCode !== 0) return []
  const map = new Map<string, GitRemote>()
  for (const line of result.text().split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim())
    if (!match) continue
    const current = map.get(match[1]) ?? { name: match[1] }
    map.set(match[1], { ...current, [match[3]]: match[2] })
  }
  return [...map.values()]
})

const gitTags = Effect.fnUntraced(function* (git: Git.Interface, cwd: string) {
  const result = yield* git.run(
    ["tag", "--list", "--format=%(refname:short)\x1f%(objectname:short)\x1f%(creatordate:iso-strict)\x1e"],
    {
      cwd,
      maxOutputBytes: 300_000,
    },
  )
  if (result.exitCode !== 0) return []
  return records(result.text()).flatMap((record) => {
    const item = fields(record)
    const name = item[0]
    if (!name) return []
    return [{ name, hash: item[1] || undefined, date: item[2] || undefined } satisfies GitTag]
  })
})

const gitStashes = Effect.fnUntraced(function* (git: Git.Interface, cwd: string) {
  const result = yield* git.run(["stash", "list", "--format=%gd%x1f%H%x1f%s%x1e"], { cwd, maxOutputBytes: 300_000 })
  if (result.exitCode !== 0) return []
  return records(result.text()).flatMap((record) => {
    const item = fields(record)
    const selector = item[0]
    if (!selector) return []
    return [{ selector, hash: item[1] || undefined, message: item[2] ?? "" } satisfies GitStash]
  })
})

const gitConflicts = Effect.fnUntraced(function* (git: Git.Interface, cwd: string) {
  const result = yield* git.run(["diff", "--name-only", "--diff-filter=U", "-z"], { cwd, maxOutputBytes: 200_000 })
  if (result.exitCode !== 0) return []
  return result
    .text()
    .split("\0")
    .filter(Boolean)
    .map((file) => ({ file }) satisfies GitConflict)
})

const gitOperation = Effect.fnUntraced(function* (git: Git.Interface, cwd: string) {
  const result = yield* git.run(["rev-parse", "--git-dir"], { cwd, maxOutputBytes: 4096 })
  if (result.exitCode !== 0) return { inProgress: false } satisfies GitOperation
  const raw = result.text().trim()
  const dir = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw)
  const checks = [
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REBASE_HEAD", "rebase"],
    ["REVERT_HEAD", "revert"],
  ] as const
  for (const [file, type] of checks) {
    if (yield* Effect.promise(() => exists(path.join(dir, file)))) return { inProgress: true, type }
  }
  return { inProgress: false } satisfies GitOperation
})

const runGitAction = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  args: string[],
  fallback: string,
  options?: { stdin?: string },
) {
  const encoder = new TextEncoder()
  const result = yield* git.run(args, {
    cwd,
    stdin: options?.stdin ? Stream.make(encoder.encode(options.stdin)) : undefined,
    maxOutputBytes: 1_000_000,
  })
  return gitResult(result, fallback)
})

const gitPathKey = (value: string) => {
  const normalized = path.resolve(value).replaceAll("\\", "/").replace(/\/+$/, "")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

type GitIdentity = {
  worktree: string
  commonDir: string
  realWorktree: string
  realCommonDir: string
  commonDirDevice: number
  commonDirInode: number
  head?: string
}

const gitIdentity = Effect.fnUntraced(function* (git: Git.Interface, cwd: string) {
  const [worktree, common, head] = yield* Effect.all(
    [
      git.run(["rev-parse", "--show-toplevel"], { cwd, maxOutputBytes: 16_384 }),
      git.run(["rev-parse", "--git-common-dir"], { cwd, maxOutputBytes: 16_384 }),
      git.run(["rev-parse", "--verify", "HEAD"], { cwd, maxOutputBytes: 16_384 }),
    ],
    { concurrency: 3 },
  )
  if (worktree.exitCode !== 0 || common.exitCode !== 0) return
  const root = worktree.text().trim()
  const commonDir = common.text().trim()
  if (!root || !commonDir) return
  const worktreePath = path.resolve(cwd, root)
  const commonDirPath = path.resolve(cwd, commonDir)
  const physical = yield* Effect.promise(() =>
    Promise.all([realpath(worktreePath), realpath(commonDirPath), stat(commonDirPath)]).catch(() => undefined),
  )
  if (!physical) return
  return {
    worktree: worktreePath,
    commonDir: commonDirPath,
    realWorktree: physical[0],
    realCommonDir: physical[1],
    commonDirDevice: physical[2].dev,
    commonDirInode: physical[2].ino,
    head: head.exitCode === 0 ? head.text().trim() || undefined : undefined,
  }
})

const sameGitIdentity = (left: GitIdentity, right: GitIdentity | undefined) =>
  Boolean(
    right &&
      gitPathKey(left.worktree) === gitPathKey(right.worktree) &&
      gitPathKey(left.commonDir) === gitPathKey(right.commonDir) &&
      gitPathKey(left.realWorktree) === gitPathKey(right.realWorktree) &&
      gitPathKey(left.realCommonDir) === gitPathKey(right.realCommonDir) &&
      left.commonDirDevice === right.commonDirDevice &&
      left.commonDirInode === right.commonDirInode &&
      left.head === right.head,
  )

const gitStatusSnapshot = Effect.fnUntraced(function* (git: Git.Interface, cwd: string) {
  const result = yield* git.run(
    ["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z", "--", "."],
    { cwd, maxOutputBytes: 1_000_000 },
  )
  if (result.exitCode !== 0) return { ok: false as const, result }
  const text = result.text()
  const entries = text.split("\0").filter(Boolean)
  return {
    ok: true as const,
    text,
    paths: entries.map((item) => item.slice(3)).toSorted(),
    unstaged: entries.some((item) => item.startsWith("??") || item[1] !== " "),
  }
})

const gitIndexFingerprint = Effect.fnUntraced(function* (git: Git.Interface, cwd: string) {
  const result = yield* git.run(["write-tree"], { cwd, maxOutputBytes: 16_384 })
  if (result.exitCode !== 0) return
  return result.text().trim()
})

export const commitAuto = Effect.fnUntraced(function* (
  git: Git.Interface,
  headlessAI: HeadlessAI.Interface,
  identity: GitIdentity,
  input: GitActionInput,
  commit: ConfigCommit.Commit | undefined,
) {
  const cwd = identity.worktree
  // Validate the chain request before touching the index. An explicit opt-out
  // (useChain=false) ignores any attached snapshot and keeps only the
  // deliberately configured single-model path. useChain=true promises the
  // client attached the validated default-chain snapshot; a missing or invalid
  // snapshot must fail visibly instead of re-activating the fixed single-model
  // fallback. useChain=undefined is the legacy shape: a valid attached snapshot
  // still wins.
  const commitChain = input.useChain === false ? { status: "none" as const } : resolveCommitChain(input.commitChain)
  if (commitChain.status === "invalid")
    return { ok: false, message: `AI commit model chain is invalid: ${commitChain.reason}` }
  if (input.useChain === true && commitChain.status !== "chain")
    return {
      ok: false,
      message: "AI commit requested the default model chain but no chain snapshot was provided",
    }
  const beforeIdentity = yield* gitIdentity(git, cwd)
  if (!sameGitIdentity(identity, beforeIdentity))
    return { ok: false, message: "Repository identity changed before staging; retry the commit." }

  const before = yield* gitStatusSnapshot(git, cwd)
  if (!before.ok) return gitResult(before.result, "Failed to inspect changes before staging")
  if (!before.text.trim()) return { ok: false, message: "No changes to commit" }

  const add = yield* runGitAction(git, cwd, ["add", "-A"], "Failed to stage all changes")
  if (!add.ok) return add

  const stagedIdentity = yield* gitIdentity(git, cwd)
  if (!sameGitIdentity(identity, stagedIdentity))
    return { ok: false, message: "Repository identity changed while staging; no commit was created." }
  const stagedStatus = yield* gitStatusSnapshot(git, cwd)
  if (!stagedStatus.ok) return gitResult(stagedStatus.result, "Failed to inspect staged changes")
  if (!stagedStatus.text.trim()) return { ok: false, message: "No changes to commit" }
  if (stagedStatus.unstaged)
    return { ok: false, message: "The working tree changed while staging; no commit was created." }
  if (before.paths.join("\0") !== stagedStatus.paths.join("\0"))
    return { ok: false, message: "The changed file set moved while staging; no commit was created." }
  const stagedTree = yield* gitIndexFingerprint(git, cwd)
  if (!stagedTree) return { ok: false, message: "Failed to fingerprint the staged changes" }

  const [stat, patch, numstat] = yield* Effect.all(
    [
      git.run(["diff", "--cached", "--stat", "--", "."], { cwd, maxOutputBytes: 80_000 }),
      git.run(["diff", "--cached", "--patch", "--no-ext-diff", "--no-renames", "--", "."], {
        cwd,
        maxOutputBytes: COMMIT_DIFF_CAPTURE_BYTES,
      }),
      git.run(["diff", "--cached", "--numstat", "-z", "--no-renames", "--", "."], {
        cwd,
        maxOutputBytes: 250_000,
      }),
    ],
    { concurrency: 3 },
  )
  const stats = stagedStats(numstat.text())
  const items = yield* git.status(cwd).pipe(
    Effect.map((list) =>
      list.map(
        (item) =>
          ({
            file: item.file,
            code: item.code,
            additions: stats.get(item.file)?.additions ?? 0,
            deletions: stats.get(item.file)?.deletions ?? 0,
            status: item.status,
            staged: staged(item.code),
            unstaged: unstaged(item.code),
            untracked: item.code === "??",
            conflicted: conflicted(item.code),
          }) satisfies GitFileStatus,
      ),
    ),
  )
  const stagedItems = items.filter((item) => item.staged || item.untracked)
  const history = yield* gitHistory(git, cwd, 20).pipe(
    Effect.map(commitHistorySample),
    Effect.catch(() => Effect.succeed("")),
  )
  const generated = yield* llmCommitMessage(
    headlessAI,
    stagedItems,
    {
      stat: stat.text(),
      patch: patch.text(),
      patchTruncated: patch.truncated,
      truncated: patch.truncated || stat.truncated || numstat.truncated,
    },
    history,
    input.commitModel ? { ...commit, model: input.commitModel } : commit,
    commitChain.status === "chain" ? commitChain.steps : undefined,
  ).pipe(
    Effect.map((result) => ({ ok: true as const, ...result })),
    Effect.catch((error) =>
      Effect.gen(function* () {
        const reason = generationFailureReason(error)
        yield* Effect.logWarning("ai commit message generation failed, using local fallback", {
          model: input.commitModel || commit?.model || ConfigCommit.DEFAULT_COMMIT_MODEL,
          files: stagedItems.length,
          reason,
        })
        return {
          ok: false as const,
          message: fallbackCommitMessage(stagedItems),
          notice: `AI commit message generation failed: ${reason}. Committed with a local fallback message.`,
        }
      }),
    ),
  )

  const [finalIdentity, finalStatus, finalTree] = yield* Effect.all(
    [gitIdentity(git, cwd), gitStatusSnapshot(git, cwd), gitIndexFingerprint(git, cwd)],
    { concurrency: 3 },
  )
  if (!sameGitIdentity(identity, finalIdentity))
    return { ok: false, message: "Repository identity changed before commit; no commit was created." }
  if (!finalStatus.ok) return gitResult(finalStatus.result, "Failed to re-check staged changes")
  if (finalStatus.text !== stagedStatus.text || finalTree !== stagedTree)
    return { ok: false, message: "Changes moved while the commit message was generated; no commit was created." }

  const message = generated.message
  const committed = yield* runGitAction(git, cwd, ["commit", "-m", message], "AI commit failed")
  if (!committed.ok) return committed
  return generated.notice ? { ...committed, commit: message, message: generated.notice } : { ...committed, commit: message }
})

const gitAction = Effect.fnUntraced(function* (
  git: Git.Interface,
  headlessAI: HeadlessAI.Interface,
  cwd: string,
  input: GitActionInput,
  commit?: ConfigCommit.Commit,
) {
  const files = input.files?.length ? ["--", ...input.files] : []
  if (input.action === "stage")
    return yield* runGitAction(
      git,
      cwd,
      input.files?.length ? ["add", ...files] : ["add", "-A"],
      "Failed to stage changes",
    )
  if (input.action === "unstage")
    return yield* runGitAction(
      git,
      cwd,
      input.files?.length ? ["restore", "--staged", ...files] : ["restore", "--staged", "."],
      "Failed to unstage changes",
    )
  if (input.action === "discard") {
    if (input.force && !input.files?.length) {
      const reset = yield* runGitAction(git, cwd, ["reset", "--hard"], "Failed to reset working tree")
      if (!reset.ok) return reset
      return yield* runGitAction(git, cwd, ["clean", "-fd"], "Failed to clean working tree")
    }
    if (input.files?.length) {
      const selected = new Set(input.files)
      const status = yield* git.status(cwd)
      const untracked = status
        .filter((item) => item.code === "??" && selected.has(item.file))
        .map((item) => item.file)
      const added = status
        .filter((item) => item.code.startsWith("A") && !conflicted(item.code) && selected.has(item.file))
        .map((item) => item.file)
      const removable = [...new Set([...untracked, ...added])]
      const tracked = input.files.filter((file) => !removable.includes(file))
      const unstage = added.length
        ? yield* runGitAction(
            git,
            cwd,
            ["--literal-pathspecs", "rm", "--cached", "-f", "--", ...added],
            "Failed to unstage added files",
          )
        : undefined
      if (unstage && !unstage.ok) return unstage
      const clean = removable.length
        ? yield* runGitAction(
            git,
            cwd,
            ["--literal-pathspecs", "clean", "-fdx", "--", ...removable],
            "Failed to delete untracked files",
          )
        : undefined
      if (clean && !clean.ok) return clean
      const restore = tracked.length
        ? yield* runGitAction(
            git,
            cwd,
            ["--literal-pathspecs", "restore", "--staged", "--worktree", "--", ...tracked],
            "Failed to discard changes",
          )
        : undefined
      if (restore && !restore.ok) return restore
      return {
        ok: true,
        output: [unstage?.output, clean?.output, restore?.output].filter(Boolean).join("\n"),
      }
    }
    return yield* runGitAction(git, cwd, ["restore", "--worktree", ...files], "Failed to discard changes")
  }
  if (input.action === "commit") {
    const message = input.message?.trim()
    if (!message) return { ok: false, message: "Commit message is required" }
    return yield* runGitAction(git, cwd, ["commit", "-m", message], "Commit failed")
  }
  if (input.action === "commitAuto") {
    const identity = yield* gitIdentity(git, cwd)
    if (!identity) return { ok: false, message: "Project is not a git repository" }
    return yield* Effect.acquireUseRelease(
      Effect.promise((signal) =>
        Flock.acquire(`git-commit:${gitPathKey(identity.commonDir)}`, {
          signal,
          staleMs: 5 * 60_000,
          timeoutMs: 5 * 60_000,
        }),
      ),
      () =>
        Effect.gen(function* () {
          const lockedIdentity = yield* gitIdentity(git, cwd)
          if (!lockedIdentity) return { ok: false, message: "Project is not a git repository" }
          if (gitPathKey(lockedIdentity.commonDir) !== gitPathKey(identity.commonDir))
            return { ok: false, message: "Repository identity changed while waiting for the commit lock; retry." }
          return yield* commitAuto(git, headlessAI, lockedIdentity, input, commit)
        }),
      (lease) => Effect.promise(() => lease.release()).pipe(Effect.ignore),
    )
  }
  if (input.action === "fetch")
    return yield* runGitAction(
      git,
      cwd,
      input.remote ? ["fetch", input.remote, "--prune"] : ["fetch", "--all", "--prune"],
      "Fetch failed",
    )
  if (input.action === "pull")
    return yield* runGitAction(
      git,
      cwd,
      input.remote && input.branch ? ["pull", input.remote, input.branch] : ["pull"],
      "Pull failed",
    )
  if (input.action === "push") {
    const args = [
      "push",
      ...(input.force ? ["--force-with-lease"] : []),
      ...(input.remote ? [input.remote] : []),
      ...(input.branch ? [input.branch] : []),
    ]
    return yield* runGitAction(git, cwd, args, "Push failed")
  }
  if (input.action === "sync") {
    const pull = yield* runGitAction(
      git,
      cwd,
      input.remote && input.branch ? ["pull", input.remote, input.branch] : ["pull"],
      "Pull failed",
    )
    if (!pull.ok) return pull
    const push = yield* runGitAction(
      git,
      cwd,
      [
        "push",
        ...(input.force ? ["--force-with-lease"] : []),
        ...(input.remote ? [input.remote] : []),
        ...(input.branch ? [input.branch] : []),
      ],
      "Push failed",
    )
    return { ...push, output: [pull.output, push.output].filter(Boolean).join("\n") }
  }
  if (input.action === "merge") {
    if (!input.ref) return { ok: false, message: "Merge ref is required" }
    return yield* runGitAction(git, cwd, ["merge", input.ref], "Merge failed")
  }
  if (input.action === "cherryPick") {
    if (!input.ref) return { ok: false, message: "Cherry-pick ref is required" }
    return yield* runGitAction(git, cwd, ["cherry-pick", input.ref], "Cherry-pick failed")
  }
  if (input.action === "squashRange") {
    const start = input.start?.trim()
    const message = input.message?.trim()
    if (!start) return { ok: false, message: "Squash base is required" }
    if (!message) return { ok: false, message: "Squash commit message is required" }
    const reset = yield* runGitAction(git, cwd, ["reset", "--soft", start], "Squash reset failed")
    if (!reset.ok) return reset
    return yield* runGitAction(git, cwd, ["commit", "-m", message], "Squash commit failed")
  }
  if (input.action === "stashSave")
    return yield* runGitAction(
      git,
      cwd,
      ["stash", "push", "-u", "-m", input.message?.trim() || "Git Workbench stash"],
      "Stash failed",
    )
  if (input.action === "stashApply") {
    if (!input.ref) return { ok: false, message: "Stash ref is required" }
    return yield* runGitAction(git, cwd, ["stash", "apply", input.ref], "Stash apply failed")
  }
  if (input.action === "stashPop")
    return yield* runGitAction(git, cwd, input.ref ? ["stash", "pop", input.ref] : ["stash", "pop"], "Stash pop failed")
  if (input.action === "stashDrop") {
    if (!input.ref) return { ok: false, message: "Stash ref is required" }
    return yield* runGitAction(git, cwd, ["stash", "drop", input.ref], "Stash drop failed")
  }
  if (input.action === "checkoutBranch") {
    if (!input.name) return { ok: false, message: "Branch name is required" }
    return yield* runGitAction(git, cwd, ["checkout", input.name], "Checkout failed")
  }
  if (input.action === "createBranch") {
    if (!input.name) return { ok: false, message: "Branch name is required" }
    return yield* runGitAction(
      git,
      cwd,
      ["checkout", "-b", input.name, ...(input.start ? [input.start] : [])],
      "Create branch failed",
    )
  }
  if (input.action === "deleteBranch") {
    if (!input.name) return { ok: false, message: "Branch name is required" }
    return yield* runGitAction(
      git,
      cwd,
      [input.force ? "branch" : "branch", input.force ? "-D" : "-d", input.name],
      "Delete branch failed",
    )
  }
  if (input.action === "ignore") {
    const pattern = validGitignorePattern(cwd, input.pattern)
    if (!pattern) return { ok: false, message: "A safe repository-relative .gitignore pattern is required" }
    return yield* Effect.promise(() => appendGitignore(cwd, pattern))
  }
  if (input.action === "continueOperation") {
    const operation = yield* gitOperation(git, cwd)
    if (operation.type === "merge")
      return yield* runGitAction(git, cwd, ["merge", "--continue"], "Merge continue failed")
    if (operation.type === "cherry-pick")
      return yield* runGitAction(git, cwd, ["cherry-pick", "--continue"], "Cherry-pick continue failed")
    if (operation.type === "rebase")
      return yield* runGitAction(git, cwd, ["rebase", "--continue"], "Rebase continue failed")
    if (operation.type === "revert")
      return yield* runGitAction(git, cwd, ["revert", "--continue"], "Revert continue failed")
    return { ok: false, message: "No Git operation in progress" }
  }
  if (input.action === "abortOperation") {
    const operation = yield* gitOperation(git, cwd)
    if (operation.type === "merge") return yield* runGitAction(git, cwd, ["merge", "--abort"], "Merge abort failed")
    if (operation.type === "cherry-pick")
      return yield* runGitAction(git, cwd, ["cherry-pick", "--abort"], "Cherry-pick abort failed")
    if (operation.type === "rebase") return yield* runGitAction(git, cwd, ["rebase", "--abort"], "Rebase abort failed")
    if (operation.type === "revert") return yield* runGitAction(git, cwd, ["revert", "--abort"], "Revert abort failed")
    return { ok: false, message: "No Git operation in progress" }
  }
  return { ok: false, message: `Unsupported Git action: ${input.action}` }
})

function validGitignorePattern(cwd: string, input: string | undefined) {
  if (!input || input !== input.trim() || /[\0\r\n]/.test(input)) return
  const pattern = input.replaceAll("\\", "/")
  if (path.posix.isAbsolute(pattern) || path.win32.isAbsolute(input)) return
  if (/^\*\.[^./*?\[\]\\]+$/.test(pattern)) return pattern
  if (pattern.startsWith("*.")) return
  const folder = pattern.endsWith("/")
  const target = folder ? pattern.slice(0, -1) : pattern
  if (!target) return
  const segments = target.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return
  const relative = path.relative(cwd, path.resolve(cwd, ...segments))
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return
  const escaped = segments.map((segment) => segment.replace(/[!#*?\[\] ]/g, "\\$&")).join("/")
  return `/${escaped}${folder ? "/" : ""}`
}

export async function appendGitignore(cwd: string, pattern: string): Promise<GitActionResult> {
  return realpath(cwd)
    .then((root) =>
      Flock.withProcessLock(`gitignore:${root}`, async (lease) => {
        const file = path.join(root, ".gitignore")
        const existing = await readGitignore(root, file)
        if (existing.content.split(/\r?\n/).includes(pattern))
          return { ok: true, message: `${pattern} is already in .gitignore` }

        const newline = existing.content.match(/\r\n|\n/)?.[0] ?? "\n"
        const prefix =
          existing.content.length === 0 || existing.content.endsWith("\n")
            ? existing.content
            : `${existing.content}${newline}`
        const temporary = path.join(root, `.gitignore.opencode-${process.pid}-${randomUUID()}.tmp`)
        try {
          await writeFile(temporary, `${prefix}${pattern}${newline}`, {
            encoding: "utf8",
            flag: "wx",
            mode: existing.mode,
          })
          await lease.assertOwned()
          await gitignoreTarget(root, file)
          await rename(temporary, file)
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined)
        }
        return {
          ok: true,
          message: `Added ${pattern} to .gitignore. This only affects untracked files; files already tracked by Git stay tracked.`,
        }
      }),
    )
    .catch((error: unknown) => ({
      ok: false,
      message: `Could not update .gitignore: ${gitignoreFailureReason(error)}`,
    }))
}

async function readGitignore(root: string, file: string) {
  const before = await gitignoreTarget(root, file)
  if (!before) return { content: "", mode: 0o666 }
  const handle = await open(file, "r")
  try {
    const opened = await handle.stat()
    const after = await gitignoreTarget(root, file)
    if (!after || !sameFile(opened, after)) throw new Error("The .gitignore file changed while it was being read")
    return { content: await handle.readFile("utf8"), mode: opened.mode & 0o777 }
  } finally {
    await handle.close()
  }
}

async function gitignoreTarget(root: string, file: string) {
  const info = await lstat(file).catch((error: unknown) => {
    if (gitignoreErrorCode(error) === "ENOENT") return
    throw error
  })
  if (!info) return
  if (info.isSymbolicLink())
    throw new Error("Refusing to follow a .gitignore symbolic link or Windows reparse point")
  if (!info.isFile()) throw new Error("Refusing to replace .gitignore because it is not a regular file")
  const resolved = await realpath(file)
  const relative = path.relative(root, resolved)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Refusing to follow .gitignore outside the repository worktree")
  return info
}

function sameFile(left: Awaited<ReturnType<typeof stat>>, right: Awaited<ReturnType<typeof lstat>>) {
  if (left.dev !== right.dev || left.ino !== right.ino) return false
  if (left.ino !== 0 || right.ino !== 0) return true
  return left.birthtimeMs === right.birthtimeMs && left.size === right.size && left.mode === right.mode
}

function gitignoreErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") return
  return error.code
}

function gitignoreFailureReason(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  return String(error) || "Unknown filesystem error"
}

export const layer: Layer.Layer<Service, never, Git.Service | EventV2Bridge.Service | Provider.Service> = live.pipe(
  Layer.provide(HeadlessAI.layer),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Git.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Provider.defaultLayer),
)

export const node = LayerNode.make(layer, [Git.node, EventV2Bridge.node, Provider.node])

export * as Vcs from "./vcs"
