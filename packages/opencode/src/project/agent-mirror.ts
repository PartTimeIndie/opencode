import fs from "fs/promises"
import { constants } from "fs"
import path from "path"
import { createHash, randomUUID } from "crypto"

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

/**
 * Host-only workspace boundary. Creates an independent local repository and
 * private working files, never worktrees or writable hardlinks. This is not an
 * OS sandbox and does not grant authority to start a Session in the mirror.
 * Failures retain the task-owned directory for diagnosis; no recursive cleanup.
 */
export async function create(input: Input): Promise<Mirror> {
  if (
    !input.taskID.trim() ||
    !input.sourceSessionID.trim() ||
    !Number.isSafeInteger(input.throughSeq) ||
    input.throughSeq < 0
  )
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
  const paths = await selectedPaths(directory, input.untracked)
  const owned = await fs.mkdtemp(path.join(root, "opencode-agent-"))
  const id = randomUUID()
  await fs.writeFile(
    path.join(owned, "owner.json"),
    JSON.stringify({
      version: 1,
      id,
      taskID: input.taskID,
      sourceSessionID: input.sourceSessionID,
      directory,
    }),
    { flag: "wx" },
  )
  const destination = path.join(owned, "workspace")
  await git(root, ["clone", "--local", "--dissociate", "--no-hardlinks", "--no-checkout", "--", directory, destination])
  await git(destination, ["remote", "remove", "origin"])
  // Child-side Git must keep the byte basis even under a global autocrlf=true.
  await git(destination, ["config", "core.autocrlf", "false"])
  if (await Bun.file(path.join(destination, ".git", "objects", "info", "alternates")).exists())
    throw new Error("Mirror object store is not independent")
  // Seed an independent index, not the Main checkout. No checkout/filter hooks
  // run, and all working content below comes from the current dirty Main files.
  await git(destination, ["read-tree", "HEAD"])
  const files: File[] = []
  for (const relative of paths) {
    const source = path.join(directory, relative)
    const stat = await fs.lstat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!stat) continue // A tracked deletion is represented by absence in B.
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Mirror only supports regular files: ${relative}`)
    const resolved = await fs.realpath(source)
    if (!inside(directory, resolved)) throw new Error(`Mirror source escapes checkout: ${relative}`)
    const before = await fs.readFile(source)
    const target = path.join(destination, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    // FICLONE is only a request for OS-managed COW; Node safely copies when it
    // is unsupported. There is deliberately no hardlink fallback.
    await fs.copyFile(source, target, constants.COPYFILE_FICLONE)
    await fs.chmod(target, stat.mode & 0o777)
    if (((await fs.stat(target)).mode & 0o777) !== (stat.mode & 0o777))
      throw new Error(`Mirror file mode could not be preserved: ${relative}`)
    const copied = await fs.readFile(target)
    if (digest(before) !== digest(copied)) throw new Error(`Main changed during mirror copy: ${relative}`)
    files.push({ path: relative, sha256: digest(before), bytes: before.byteLength, mode: stat.mode & 0o777 })
  }
  const afterPaths = await selectedPaths(directory, input.untracked)
  if (
    JSON.stringify(paths) !== JSON.stringify(afterPaths) ||
    (await git(directory, ["rev-parse", "HEAD"])).trim() !== commit
  )
    throw new Error("Main changed during mirror snapshot")
  const captured = new Map(files.map((file) => [file.path, file]))
  for (const relative of paths) {
    const content = await fs.readFile(path.join(directory, relative)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    const basis = captured.get(relative)
    if ((content === undefined) !== (basis === undefined) || (content && digest(content) !== basis?.sha256))
      throw new Error(`Main changed after mirror snapshot: ${relative}`)
    if (basis && ((await fs.stat(path.join(directory, relative))).mode & 0o777) !== basis.mode)
      throw new Error(`Main mode changed after mirror snapshot: ${relative}`)
  }
  const basis: Basis = {
    version: 1,
    id,
    taskID: input.taskID,
    sourceSessionID: input.sourceSessionID,
    throughSeq: input.throughSeq,
    directory,
    commit,
    files,
    deletedPaths: paths.filter((file) => !captured.has(file)),
    excludedUntracked: input.untracked.filter((file) => !paths.includes(file)),
  }
  await fs.writeFile(path.join(destination, ".git", "opencode-mirror.json"), JSON.stringify(basis), { flag: "wx" })
  return {
    directory: destination,
    basis,
    metrics: {
      setupMs: performance.now() - started,
      logicalBytes: files.reduce((total, file) => total + file.bytes, 0),
      copyMode: "private-files",
      cloneRequested: true,
      physicalBytes: null,
    },
  }
}

async function selectedPaths(directory: string, untracked: readonly string[]) {
  const stages = (await git(directory, ["ls-files", "--stage", "-z"])).split("\0").filter(Boolean)
  if (stages.some((entry) => entry.startsWith("120000 ") || entry.startsWith("160000 ")))
    throw new Error("Mirrors do not support tracked symlinks or submodules")
  if ((await git(directory, ["ls-files", "-v", "-z"])).split("\0").some((entry) => /^[Ss] /.test(entry)))
    throw new Error("Mirrors do not support sparse checkout")
  const tracked = (await git(directory, ["ls-files", "--cached", "-z"])).split("\0").filter(Boolean)
  const available = new Set(
    (await git(directory, ["ls-files", "--others", "--exclude-standard", "-z"], true)).split("\0").filter(Boolean),
  )
  const selected = untracked
    .map((file) => {
      if (!validPath(file)) throw new Error("Untracked mirror paths must be repository-relative regular paths")
      return file
    })
    .filter((file) => available.has(file))
  const paths = [...new Set([...tracked, ...selected])].sort()
  const invalid = paths.find((file) => !validPath(file))
  if (invalid) throw new Error(`Unsupported Git path in mirror snapshot: ${invalid}`)
  if (
    (process.platform === "win32" || process.platform === "darwin") &&
    new Set(paths.map((file) => file.toLowerCase())).size !== paths.length
  )
    throw new Error("Case-colliding paths in mirror snapshot")
  return paths
}

function validPath(file: string) {
  return (
    file.length > 0 &&
    !file.includes("\\") &&
    !file.includes(":") &&
    !file.includes("\0") &&
    !file.startsWith("/") &&
    file
      .split("/")
      .every(
        (part) =>
          !!part &&
          part !== "." &&
          part !== ".." &&
          part.toLowerCase() !== ".git" &&
          (process.platform !== "win32" ||
            (!/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))),
      )
  )
}

function inside(root: string, file: string) {
  const relative = path.relative(root, file)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

function digest(content: Uint8Array) {
  return createHash("sha256").update(content).digest("hex")
}

async function git(directory: string, args: readonly string[], readUserIgnores = false) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
  // Git for Windows understands /dev/null, not Node's \\.\nul device path.
  const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", ...args], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...env,
      // Only read-only untracked-file selection loads the user's ignore policy.
      // No hooks, checkout filters, credentials or network operations run there.
      GIT_CONFIG_GLOBAL: readUserIgnores ? process.env.GIT_CONFIG_GLOBAL : "/dev/null",
      GIT_CONFIG_NOSYSTEM: readUserIgnores ? process.env.GIT_CONFIG_NOSYSTEM : "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
    },
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`Local mirror Git command failed (${code}): ${stderr.slice(-4000)}`)
  // Unsupported byte filenames must not become U+FFFD paths/false deletions.
  return new TextDecoder("utf-8", { fatal: true }).decode(stdout)
}

export * as AgentMirror from "./agent-mirror"
