export * as AgentMirror from "./agent-mirror"

import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"

export type Input = {
  readonly directory: string
  readonly mirrorRoot: string
  readonly taskID: string
  readonly sourceSessionID: string
  readonly throughSeq: number
  /** Only these non-ignored untracked files may join the tracked snapshot. */
  readonly untracked: readonly string[]
}
export type File = { readonly path: string; readonly sha256: string; readonly bytes: number; readonly mode: number }
export type Basis = {
  readonly version: 1
  readonly id: string
  readonly taskID: string
  readonly sourceSessionID: string
  readonly throughSeq: number
  readonly directory: string
  readonly commit: string
  readonly files: readonly File[]
  readonly deletedPaths: readonly string[]
  readonly excludedUntracked: readonly string[]
}
export type Mirror = {
  readonly directory: string
  readonly basis: Basis
  readonly metrics: {
    readonly setupMs: number
    readonly logicalBytes: number
    readonly copyMode: "private-files"
    readonly cloneRequested: true
    /** Reflink support and physical space savings are not inferred from success. */
    readonly physicalBytes: null
  }
}

/** Read-only preflight before reserving standalone storage. Creation rechecks
 * all of these conditions; this does not freeze a source or grant ownership. */
export async function preflight(directory: string, untracked: readonly string[]) {
  const source = await fs.realpath(directory)
  if (await fs.realpath((await git(source, ["rev-parse", "--show-toplevel"])).trim()) !== source)
    throw new Error("Mirror source must be the repository root")
  if ((await git(source, ["ls-files", "--unmerged", "-z"])).length)
    throw new Error("Cannot snapshot an unresolved Git index")
  await git(source, ["rev-parse", "HEAD"])
  await selectedPaths(source, [...untracked])
}

/** Host-only independent local repository and private working files, never
 * worktrees or writable hardlinks. Not an OS sandbox or Session admission.
 * Failures retain the task-owned directory for diagnosis; no recursive cleanup. */
export async function create(request: Input): Promise<Mirror> {
  const input = structuredClone(request)
  if (!input.taskID.trim() || !input.sourceSessionID.trim() || !Number.isSafeInteger(input.throughSeq) || input.throughSeq < 0)
    throw new Error("Mirror requires a task and a stable conversation boundary")
  const started = performance.now()
  const directory = await fs.realpath(input.directory)
  const root = await fs.realpath(input.mirrorRoot)
  if (inside(directory, root)) throw new Error("Mirror root must be outside the source checkout")
  const repository = (await git(directory, ["rev-parse", "--show-toplevel"])).trim()
  if ((await fs.realpath(repository)) !== directory) throw new Error("Mirror source must be the repository root")
  if ((await git(directory, ["ls-files", "--unmerged", "-z"])).length > 0)
    throw new Error("Cannot snapshot an unresolved Git index")
  const commit = (await git(directory, ["rev-parse", "HEAD"])).trim()
  const selection = await selectedPaths(directory, input.untracked)
  const paths = selection.paths
  const owned = await fs.mkdtemp(path.join(root, "opencode-agent-"))
  const id = randomUUID()
  await fs.writeFile(path.join(owned, "owner.json"), JSON.stringify({ version: 1, id, taskID: input.taskID,
    sourceSessionID: input.sourceSessionID, directory }), { flag: "wx" })
  const destination = path.join(owned, "workspace")
  await git(root, ["clone", "--local", "--dissociate", "--no-hardlinks", "--no-checkout", "--", directory, destination])
  await git(destination, ["remote", "remove", "origin"])
  // Child-side Git must keep the byte basis even under a global autocrlf=true.
  await git(destination, ["config", "core.autocrlf", "false"])
  const alternates = await fs.lstat(path.join(destination, ".git", "objects", "info", "alternates")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (alternates) throw new Error("Mirror object store is not independent")
  // Seed only the private index. No checkout/filter hooks run; working content
  // below comes from the current dirty Main files, not the committed tree.
  await git(destination, ["read-tree", "HEAD"])
  for (const relative of selection.excludedWorktrees)
    await git(destination, ["update-index", "--force-remove", "--", relative])
  const files: File[] = []
  for (const relative of paths) {
    const source = path.join(directory, relative)
    const stat = await regularFile(directory, relative)
    if (!selection.readable.has(relative)) {
      if (stat) throw new Error(`HEAD-only mirror path appeared during snapshot: ${relative}`)
      continue
    }
    if (!stat) continue
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Mirror only supports regular files: ${relative}`)
    const resolved = await fs.realpath(source)
    if (!inside(directory, resolved)) throw new Error(`Mirror source escapes checkout: ${relative}`)
    const before = await fs.readFile(source)
    const target = path.join(destination, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    // OS-managed COW when supported, otherwise an independent copy. Never link.
    await fs.copyFile(source, target, constants.COPYFILE_FICLONE)
    await fs.chmod(target, stat.mode & 0o777)
    if (((await fs.stat(target)).mode & 0o777) !== (stat.mode & 0o777))
      throw new Error(`Mirror file mode could not be preserved: ${relative}`)
    const copied = await fs.readFile(target)
    if (digest(before) !== digest(copied)) throw new Error(`Main changed during mirror copy: ${relative}`)
    files.push({ path: relative, sha256: digest(before), bytes: before.byteLength, mode: stat.mode & 0o777 })
  }
  const afterPaths = await selectedPaths(directory, input.untracked)
  if (JSON.stringify(paths) !== JSON.stringify(afterPaths.paths) ||
    JSON.stringify(selection.excludedWorktrees) !== JSON.stringify(afterPaths.excludedWorktrees) ||
    JSON.stringify([...selection.readable].sort()) !== JSON.stringify([...afterPaths.readable].sort()) ||
    (await git(directory, ["rev-parse", "HEAD"])).trim() !== commit)
    throw new Error("Main changed during mirror snapshot")
  const captured = new Map(files.map((file) => [file.path, file]))
  for (const relative of paths) {
    const stat = await regularFile(directory, relative)
    if (!selection.readable.has(relative)) {
      if (stat) throw new Error(`HEAD-only mirror path appeared after snapshot: ${relative}`)
      continue
    }
    const content = await fs.readFile(path.join(directory, relative)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    const basis = captured.get(relative)
    if ((content === undefined) !== (basis === undefined) || (content && digest(content) !== basis?.sha256))
      throw new Error(`Main changed after mirror snapshot: ${relative}`)
    if (basis && (!stat || (stat.mode & 0o777) !== basis.mode))
      throw new Error(`Main mode changed after mirror snapshot: ${relative}`)
  }
  const basis: Basis = { version: 1, id, taskID: input.taskID, sourceSessionID: input.sourceSessionID,
    throughSeq: input.throughSeq, directory, commit, files,
    deletedPaths: paths.filter((file) => !captured.has(file)), excludedUntracked: input.untracked.filter((file) => !paths.includes(file)) }
  await fs.writeFile(path.join(destination, ".git", "opencode-mirror.json"), JSON.stringify(basis), { flag: "wx" })
  return { directory: destination, basis, metrics: { setupMs: performance.now() - started,
    logicalBytes: files.reduce((total, file) => total + file.bytes, 0), copyMode: "private-files", cloneRequested: true, physicalBytes: null } }
}

export type Orphan = { readonly directory: string; readonly taskID: string; readonly sourceSessionID: string }

/** Diagnosis only: failed preparations keep their private artifacts. Lists
 * mirror-root owner records without reading workspace content or implying any
 * authority over live tasks. */
export async function listArtifacts(mirrorRoot: string): Promise<readonly Orphan[]> {
  const root = await fs.realpath(mirrorRoot).catch(() => undefined)
  if (root === undefined) return []
  const entries = await fs.readdir(root, { withFileTypes: true })
  const found: Orphan[] = []
  for (const entry of entries) {
    if (!entry.name.startsWith("opencode-agent-") || !entry.isDirectory()) continue
    const ownerPath = path.join(root, entry.name, "owner.json")
    const parsed: unknown = JSON.parse(await fs.readFile(ownerPath, "utf8").catch(() => "null"))
    if (typeof parsed !== "object" || parsed === null) continue
    const record = parsed as { version?: unknown; taskID?: unknown; sourceSessionID?: unknown }
    if (record.version === 1 && typeof record.taskID === "string" && typeof record.sourceSessionID === "string")
      found.push({ directory: path.join(root, entry.name), taskID: record.taskID, sourceSessionID: record.sourceSessionID })
  }
  return found
}

/** Explicitly authorized discard of ONE failed preparation's private mirror
 * directory. The authorization is exact: caller-supplied taskID and source
 * session must match the host-written owner record, and `sessionExists` must
 * confirm no Session with that taskID was ever admitted. Never a general
 * cleanup service; live or ambiguous artifacts stay untouched. */
export async function discardArtifact(input: {
  readonly mirrorRoot: string
  readonly taskID: string
  readonly sourceSessionID: string
  readonly sessionExists: (taskID: string) => Promise<boolean>
}): Promise<void> {
  if (!input.taskID.trim()) throw new Error("Discard requires the exact failed task ID")
  const root = await fs.realpath(input.mirrorRoot)
  for (const artifact of await listArtifacts(root)) {
    if (artifact.taskID !== input.taskID) continue
    if (artifact.sourceSessionID !== input.sourceSessionID)
      throw new Error(`Mirror discard authorization mismatch for ${input.taskID}`)
    if (await input.sessionExists(input.taskID))
      throw new Error(`Refusing to discard a mirror for an admitted task: ${input.taskID}`)
    const resolved = await fs.realpath(artifact.directory)
    if (path.relative(root, resolved).startsWith("..")) throw new Error("Mirror artifact escapes its root")
    await fs.rm(resolved, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 })
    return
  }
  throw new Error(`No mirror artifact found for task ${input.taskID}`)
}

async function selectedPaths(directory: string, untracked: readonly string[]) {
  const stages = (await git(directory, ["ls-files", "--stage", "-z"])).split("\0").filter(Boolean)
  // Nested agent worktrees are independent repositories, not product submodules.
  // Exclude only this known storage root AND an explicit effective ignore rule;
  // never traverse it, grant read authority, or turn it into deletion evidence.
  const ignored = new Set((await git(directory, ["ls-files", "--cached", "--ignored", "--exclude-standard", "-z"], true)).split("\0").filter(Boolean))
  const excludedWorktrees = stages.filter((entry) => entry.startsWith("160000 "))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1))
    .filter((file) => /^\.claude\/worktrees\/[^/]+$/.test(file) && ignored.has(file)).sort()
  const excluded = new Set(excludedWorktrees)
  if (stages.some((entry) => entry.startsWith("120000 ") ||
    (entry.startsWith("160000 ") && !excluded.has(entry.slice(entry.indexOf("\t") + 1)))))
    throw new Error("Mirrors do not support tracked symlinks or submodules")
  if ((await git(directory, ["ls-files", "-v", "-z"])).split("\0").some((entry) => /^[Ss] /.test(entry)))
    throw new Error("Mirrors do not support sparse checkout")
  const tracked = (await git(directory, ["ls-files", "--cached", "-z"])).split("\0").filter(Boolean)
  // Index-only enumeration loses staged deletions and rename sources.
  const committed = (await git(directory, ["ls-tree", "-r", "--name-only", "-z", "HEAD"])).split("\0").filter(Boolean)
  const available = new Set((await git(directory, ["ls-files", "--others", "--exclude-standard", "-z"], true)).split("\0").filter(Boolean))
  const selected = untracked.map((file) => {
    if (!validPath(file)) throw new Error("Untracked mirror paths must be repository-relative regular paths")
    return file
  }).filter((file) => available.has(file))
  const paths = [...new Set([...committed, ...tracked, ...selected])].filter((file) => !excluded.has(file)).sort()
  const invalid = paths.find((file) => !validPath(file))
  if (invalid) throw new Error(`Unsupported Git path in mirror snapshot: ${invalid}`)
  // HEAD identifies deletion evidence, not permission to read a path removed
  // from the index. It may now hold ignored or unselected private content.
  const readable = new Set([...tracked, ...selected])
  for (const file of paths) {
    if (!readable.has(file) && await regularFile(directory, file))
      throw new Error(`HEAD-only mirror path requires explicit non-ignored untracked selection: ${file}`)
  }
  if ((process.platform === "win32" || process.platform === "darwin") && new Set(paths.map((file) => file.toLowerCase())).size !== paths.length)
    throw new Error("Case-colliding paths in mirror snapshot")
  return { paths, readable, excludedWorktrees }
}
function validPath(file: string) {
  return file.length > 0 && !/[\\:\0]/.test(file) && !file.startsWith("/") && file.split("/").every((part) =>
    !!part && part !== "." && part !== ".." && part.toLowerCase() !== ".git" &&
    (process.platform !== "win32" || (!/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))))
}
/** True when `file` is `root` itself or lies underneath it. Both sides must already be physical paths. */
export function inside(root: string, file: string) {
  const relative = path.relative(root, file)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}
function digest(content: Uint8Array) {
  return createHash("sha256").update(content).digest("hex")
}

async function regularFile(root: string, relative: string) {
  const parts = relative.split("/")
  for (const [index] of parts.entries()) {
    const current = path.join(root, ...parts.slice(0, index + 1))
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!stat) return undefined
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()))
      throw new Error(`Mirror only supports regular files and directories: ${relative}`)
    if (index === parts.length - 1) return stat
  }
}

async function git(directory: string, args: readonly string[], readUserIgnores = false) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")))
  // Git for Windows understands /dev/null, not Node's device path. Read-only Git
  // also needs callback/config fences against child-owned repository settings.
  const stdout = await new Promise<Buffer>((resolve, reject) => execFile("git",
    ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", ...args],
    { cwd: directory, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true,
      env: { ...env, GIT_CONFIG_GLOBAL: readUserIgnores ? process.env.GIT_CONFIG_GLOBAL : "/dev/null",
        GIT_CONFIG_NOSYSTEM: readUserIgnores ? process.env.GIT_CONFIG_NOSYSTEM : "1", GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" } },
    (error, stdout) => error ? reject(error) : resolve(stdout)))
  // Unsupported byte filenames must not become replacement paths/deletions.
  return new TextDecoder("utf-8", { fatal: true }).decode(stdout)
}
export async function untrackedPaths(directory: string) {
  return (await git(directory, ["ls-files", "--others", "--exclude-standard", "-z"], true)).split("\0").filter(Boolean)
}
/** Host-owned integration inspection uses the same non-executable Git boundary. */
export async function integrationPaths(directory: string) {
  return (await git(directory, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], true)).split("\0").filter(Boolean)
}
