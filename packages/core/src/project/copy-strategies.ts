import path from "path"
import fs from "fs/promises"
import { constants } from "fs"
import { createHash } from "crypto"
import { Cause, Effect, Exit } from "effect"
import { AbsolutePath } from "../schema"
import { Git } from "../git"
import {
  CopyRemovalError,
  CopyUnavailableError,
  DirectoryUnavailableError,
  StrategyID,
  type ListEntry,
  type Strategy,
} from "./copy"

export function makeGitWorktreeStrategy(input: {
  git: Git.Interface
  canonical: (directory: AbsolutePath) => Effect.Effect<AbsolutePath, DirectoryUnavailableError>
}) {
  const repo = (sourceDirectory: AbsolutePath) =>
    ({ directory: sourceDirectory, store: sourceDirectory }) satisfies Git.Repo

  return {
    id: StrategyID.make("git_worktree"),
    create: Effect.fn("ProjectCopy.GitWorktree.create")(function* (options) {
      yield* input.git.worktreeCreate({ repo: repo(options.sourceDirectory), directory: options.directory })
      return { directory: yield* input.canonical(options.directory) }
    }),
    remove: Effect.fn("ProjectCopy.GitWorktree.remove")(function* (options) {
      const found = yield* input.git.find(options.directory)
      if (!found) return yield* new DirectoryUnavailableError({ directory: options.directory })
      yield* input.git.worktreeRemove({ repo: found, directory: options.directory, force: options.force })
    }),
    list: Effect.fn("ProjectCopy.GitWorktree.list")(function* (directory) {
      const found = yield* input.git.find(directory)
      if (!found) return yield* new DirectoryUnavailableError({ directory })
      const core = path.basename(found.store) === ".git" ? path.dirname(found.store) : found.store
      const entries = yield* input.git.worktreeList(found)
      return yield* Effect.forEach(entries, (entry) =>
        input.canonical(entry).pipe(
          Effect.map((directory) => ({ directory, type: entry === core ? "root" : "copy" }) as const),
          Effect.catchTag("ProjectCopy.DirectoryUnavailableError", () => Effect.succeed(undefined)),
        ),
      ).pipe(Effect.map((items) => items.filter((item): item is ListEntry => item !== undefined)))
    }),
  } satisfies Strategy
}

const legacyMarkerName = ".opencode-isolation.json"
const copyReserve = 64 * 1024 * 1024

export function makeIsolatedWorkspaceStrategy(input: {
  git: Git.Interface
  canonical: (directory: AbsolutePath) => Effect.Effect<AbsolutePath, DirectoryUnavailableError>
  cloneFile?: (source: string, destination: string) => Promise<void>
  availableBytes?: (destination: string) => Promise<number>
  platform?: NodeJS.Platform
}) {
  const isolatedWorkspace = StrategyID.make("isolated_cow")
  const isolatedCopy = StrategyID.make("isolated_copy")
  const gitWorktree = StrategyID.make("git_worktree")
  const cloneFile =
    input.cloneFile ?? ((source, destination) => fs.copyFile(source, destination, constants.COPYFILE_FICLONE_FORCE))
  const markerDirectory = (directory: AbsolutePath) =>
    path.join(path.dirname(directory), `.${path.basename(directory)}.opencode-isolation`)
  const marker = (directory: AbsolutePath) => path.join(markerDirectory(directory), "metadata.json")
  const readMarker = async (directory: AbsolutePath) => {
    const current = await fs.readFile(marker(directory), "utf8").catch(() => undefined)
    if (current)
      return {
        ...(JSON.parse(current) as {
          effectiveStrategy?: string
          ownership?: { dev: number; ino: number; birthtimeMs: number }
        }),
        legacy: false as const,
      }
    const legacy = await fs.readFile(path.join(directory, legacyMarkerName), "utf8").catch(() => undefined)
    if (!legacy) return undefined
    return { ...(JSON.parse(legacy) as { effectiveStrategy?: string }), legacy: true as const }
  }
  const writeMarker = async (directory: AbsolutePath, metadata: object) => {
    const identity = await fs.stat(directory)
    await fs.writeFile(
      `${marker(directory)}.tmp`,
      JSON.stringify({
        ...metadata,
        ownership: { dev: identity.dev, ino: identity.ino, birthtimeMs: identity.birthtimeMs },
      }),
    )
    await fs.rename(`${marker(directory)}.tmp`, marker(directory))
  }
  const claim = async (directory: AbsolutePath) => {
    await fs.mkdir(markerDirectory(directory))
    await fs.mkdir(directory).catch(async (cause) => {
      await fs.rm(markerDirectory(directory), { recursive: true, force: true })
      throw cause
    })
  }
  const clearDirectory = async (directory: AbsolutePath) =>
    Promise.all(
      (await fs.readdir(directory)).map((entry) =>
        fs.rm(path.join(directory, entry), { recursive: true, force: true }),
      ),
    ).then(() => undefined)
  const cleanupClaim = (directory: AbsolutePath) =>
    Effect.promise(async () => {
      await fs.rm(directory, { recursive: true, force: true })
      await fs.rm(markerDirectory(directory), { recursive: true, force: true })
    })
  const copyTree = async (
    source: string,
    destination: string,
    copy: (source: string, destination: string) => Promise<void>,
    excludedRootEntries: ReadonlySet<string>,
    root = true,
  ) => {
    await fs.mkdir(destination, { recursive: true })
    const entries = (await fs.readdir(source, { withFileTypes: true }))
      .filter((entry) => !(root && excludedRootEntries.has(entry.name)))
      .toSorted((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries.filter((item) => item.isDirectory()))
      await copyTree(
        path.join(source, entry.name),
        path.join(destination, entry.name),
        copy,
        excludedRootEntries,
        false,
      )
    const leaves = entries.filter((entry) => !entry.isDirectory())
    for (let offset = 0; offset < leaves.length; offset += 16)
      await Promise.all(
        leaves.slice(offset, offset + 16).map(async (entry) => {
          const from = path.join(source, entry.name)
          const to = path.join(destination, entry.name)
          if (entry.isSymbolicLink()) return fs.symlink(await fs.readlink(from), to)
          if (!entry.isFile()) throw new globalThis.Error(`Unsupported filesystem entry: ${from}`)
          await copy(from, to)
          const metadata = await fs.stat(from)
          await fs.chmod(to, metadata.mode)
          await fs.utimes(to, metadata.atime, metadata.mtime)
        }),
      )
    const metadata = await fs.stat(source)
    await fs.chmod(destination, metadata.mode)
    await fs.utimes(destination, metadata.atime, metadata.mtime)
  }
  const treeBytes = async (source: string, excludedRootEntries: ReadonlySet<string>, root = true): Promise<number> =>
    (await fs.readdir(source, { withFileTypes: true })).reduce(async (total, entry) => {
      const accumulated = await total
      if (root && excludedRootEntries.has(entry.name)) return accumulated
      if (entry.isDirectory())
        return accumulated + (await treeBytes(path.join(source, entry.name), excludedRootEntries, false))
      if (entry.isFile()) return accumulated + (await fs.stat(path.join(source, entry.name))).size
      return accumulated
    }, Promise.resolve(0))
  const sourceSignature = async (
    source: string,
    excludedRootEntries: ReadonlySet<string>,
    extras: ReadonlyArray<string>,
  ) => {
    const hash = createHash("sha256")
    const visit = async (base: string, current: string, root = true): Promise<void> => {
      const metadata = await fs.lstat(current, { bigint: true })
      hash.update(
        `${path.relative(base, current)}\0${metadata.mode}\0${metadata.size}\0${metadata.mtimeNs}\0${metadata.ctimeNs}\0`,
      )
      if (metadata.isSymbolicLink()) {
        hash.update(await fs.readlink(current))
        return
      }
      if (!metadata.isDirectory()) return
      await (
        await fs.readdir(current, { withFileTypes: true })
      )
        .filter((entry) => !(root && excludedRootEntries.has(entry.name)))
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .reduce(async (previous, entry) => {
          await previous
          await visit(base, path.join(current, entry.name), false)
        }, Promise.resolve())
    }
    await visit(source, source)
    await [...new Set(extras)]
      .filter((extra) => {
        const relative = path.relative(source, extra)
        return relative.startsWith("..") || path.isAbsolute(relative)
      })
      .toSorted()
      .reduce(async (previous, extra) => {
        await previous
        await visit(extra, extra)
      }, Promise.resolve())
    return hash.digest("hex")
  }
  const linkedGitDirectories = async (source: string): Promise<string[]> =>
    (await fs.readdir(source, { withFileTypes: true })).reduce(async (found, entry) => {
      const accumulated = await found
      if (entry.name === ".git") return entry.isDirectory() ? accumulated : [...accumulated, source]
      if (!entry.isDirectory()) return accumulated
      return [...accumulated, ...(await linkedGitDirectories(path.join(source, entry.name)))]
    }, Promise.resolve<string[]>([]))
  const alternateObjectStores = async (gitDirectory: string) => {
    const found: string[] = []
    const visited = new Set<string>()
    const visit = async (objects: string): Promise<void> => {
      const canonical = await fs.realpath(objects)
      if (visited.has(canonical)) return
      visited.add(canonical)
      const content = await fs.readFile(path.join(objects, "info", "alternates"), "utf8").catch(() => "")
      await content
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .reduce(async (previous, entry) => {
          await previous
          const alternate = path.resolve(objects, entry)
          found.push(alternate)
          await visit(alternate)
        }, Promise.resolve())
    }
    await visit(path.join(gitDirectory, "objects"))
    return [...new Set(found)]
  }
  const materializeAlternates = async (
    sourceGitDirectory: string,
    targetGitDirectory: string,
    copy: (source: string, destination: string) => Promise<void>,
  ) => {
    const targetObjects = path.join(targetGitDirectory, "objects")
    await (
      await alternateObjectStores(sourceGitDirectory)
    ).reduce(async (previous, alternate) => {
      await previous
      await copyTree(alternate, targetObjects, copy, new Set(["info"]))
    }, Promise.resolve())
    await fs.rm(path.join(targetObjects, "info", "alternates"), { force: true })
  }
  const materializeGit = async (
    sourceDirectory: AbsolutePath,
    destination: AbsolutePath,
    metadata: ReadonlyArray<{ directory: string; store: AbsolutePath; gitDirectory: AbsolutePath }>,
    copy: (source: string, destination: string) => Promise<void>,
    rootStore: AbsolutePath | undefined,
  ) => {
    await metadata.reduce(async (previous, item) => {
      await previous
      const target = path.join(destination, path.relative(sourceDirectory, item.directory), ".git")
      await fs.rm(target, { recursive: true, force: true })
      await copyTree(item.store, target, copy, new Set(["worktrees"]))
      if (item.gitDirectory !== item.store)
        await copyTree(item.gitDirectory, target, copy, new Set(["commondir", "gitdir", "worktrees"]))
      await fs.rm(path.join(target, "worktrees"), { recursive: true, force: true })
      const config = path.join(target, "config")
      const content = await fs.readFile(config, "utf8").catch(() => undefined)
      if (content)
        await fs.writeFile(
          config,
          content.replace(/(\[core\][\s\S]*?)(?=\r?\n\[|$)/i, (section) =>
            section.replace(/^\s*worktree\s*=.*(?:\r?\n|$)/gim, ""),
          ),
        )
      await materializeAlternates(item.store, target, copy)
    }, Promise.resolve())
    await fs.rm(path.join(destination, ".git", "worktrees"), { recursive: true, force: true })
    if (rootStore) await materializeAlternates(rootStore, path.join(destination, ".git"), copy)
  }
  const unavailable = (directory: AbsolutePath) => new DirectoryUnavailableError({ directory })
  const copyUnavailable = (directory: AbsolutePath, cause: unknown) =>
    new CopyUnavailableError({
      directory,
      message: cause instanceof globalThis.Error ? cause.message : String(cause),
    })

  return {
    id: isolatedWorkspace,
    create: Effect.fn("ProjectCopy.IsolatedWorkspace.create")(function* (options) {
      const hasProjectSettings = yield* Effect.promise(() =>
        fs
          .access(path.join(options.sourceDirectory, "ProjectSettings", "ProjectVersion.txt"))
          .then(() => true)
          .catch(() => false),
      )
      const hasAssets = yield* Effect.promise(() =>
        fs
          .stat(path.join(options.sourceDirectory, "Assets"))
          .then((item) => item.isDirectory())
          .catch(() => false),
      )
      const unity = hasProjectSettings && hasAssets
      const repository = yield* input.git.find(options.sourceDirectory)
      const links = yield* Effect.promise(() => linkedGitDirectories(options.sourceDirectory))
      const gitMetadata = yield* Effect.forEach(links, (directory) =>
        Effect.gen(function* () {
          const found = yield* input.git.find(AbsolutePath.make(directory))
          const gitDirectory = yield* input.git.dir(directory)
          if (!found || !gitDirectory)
            return yield* copyUnavailable(options.directory, `Cannot materialize linked Git metadata at ${directory}`)
          return { directory, store: found.store, gitDirectory: AbsolutePath.make(gitDirectory) }
        }),
      )
      const gitStores = [
        ...new Set([
          ...gitMetadata.map((item) => item.store),
          ...(repository?.directory === options.sourceDirectory ? [repository.store] : []),
        ]),
      ]
      const alternates = yield* Effect.tryPromise({
        try: () => Promise.all(gitStores.map((store) => alternateObjectStores(store))).then((items) => items.flat()),
        catch: (cause) => copyUnavailable(options.directory, cause),
      })
      const metadataPaths = [
        ...new Set([...gitMetadata.flatMap((item) => [item.store, item.gitDirectory]), ...alternates]),
      ].filter((directory) => {
        const relative = path.relative(options.sourceDirectory, directory)
        return relative.startsWith("..") || path.isAbsolute(relative)
      })
      const beforeClone = yield* Effect.tryPromise({
        try: () => sourceSignature(options.sourceDirectory, new Set(), metadataPaths),
        catch: (cause) => copyUnavailable(options.directory, cause),
      })
      yield* Effect.tryPromise({
        try: () => claim(options.directory),
        catch: (cause) => copyUnavailable(options.directory, cause),
      })
      const cloned = yield* Effect.exit(
        Effect.tryPromise({
          try: async () => {
            if (!input.cloneFile && (input.platform ?? process.platform) === "win32")
              throw new globalThis.Error(
                "Reflink copy is unavailable because Bun does not guarantee clone semantics on Windows",
              )
            await copyTree(options.sourceDirectory, options.directory, cloneFile, new Set())
            await materializeGit(
              options.sourceDirectory,
              options.directory,
              gitMetadata,
              cloneFile,
              repository?.directory === options.sourceDirectory ? repository.store : undefined,
            )
            if ((await sourceSignature(options.sourceDirectory, new Set(), metadataPaths)) !== beforeClone)
              throw new globalThis.Error("Source changed while creating the isolated workspace")
          },
          catch: (cause) => (cause instanceof globalThis.Error ? cause : new globalThis.Error(String(cause))),
        }),
      )
      if (Exit.isSuccess(cloned)) {
        yield* Effect.tryPromise({
          try: () =>
            writeMarker(options.directory, {
              requestedStrategy: isolatedWorkspace,
              effectiveStrategy: isolatedWorkspace,
            }),
          catch: (cause) => copyUnavailable(options.directory, cause),
        }).pipe(Effect.tapError(() => cleanupClaim(options.directory)))
        const directory = yield* input
          .canonical(options.directory)
          .pipe(Effect.tapError(() => cleanupClaim(options.directory)))
        return {
          directory,
          requestedStrategy: isolatedWorkspace,
          effectiveStrategy: isolatedWorkspace,
          isolation: "reflink_copy" as const,
          cow: { attempted: true, achieved: true, verified: true, mechanism: "reflink" as const },
          safety: {
            unityLibrary: unity ? ("reflinked" as const) : ("not_detected" as const),
            gitObjects: repository ? ("independent" as const) : ("not_detected" as const),
          },
        }
      }

      yield* Effect.promise(() => clearDirectory(options.directory))
      const reason = Cause.pretty(cloned.cause)
      const copied = yield* Effect.exit(
        Effect.gen(function* () {
          const baseExcluded = new Set<string>()
          const metadataBytes = yield* Effect.tryPromise({
            try: () =>
              metadataPaths.reduce(
                async (total, directory) => (await total) + (await treeBytes(directory, new Set(["worktrees"]))),
                Promise.resolve(0),
              ),
            catch: (cause) => copyUnavailable(options.directory, cause),
          })
          const available = yield* Effect.tryPromise({
            try: () =>
              input.availableBytes
                ? input.availableBytes(options.directory)
                : fs
                    .statfs(path.dirname(options.directory))
                    .then((volume) => Number(volume.bavail) * Number(volume.bsize)),
            catch: (cause) => copyUnavailable(options.directory, cause),
          })
          const fits = (bytes: number) => available >= bytes + Math.max(copyReserve, Math.ceil(bytes * 0.02))
          const bytes = yield* Effect.tryPromise({
            try: () => treeBytes(options.sourceDirectory, baseExcluded),
            catch: (cause) => copyUnavailable(options.directory, cause),
          })
          const excluded = yield* Effect.gen(function* () {
            if (fits(bytes + metadataBytes))
              return { entries: baseExcluded, unityLibrary: unity ? ("copied" as const) : ("not_detected" as const) }
            if (unity) {
              const entries = new Set([...baseExcluded, "Library"])
              const reduced = yield* Effect.tryPromise({
                try: () => treeBytes(options.sourceDirectory, entries),
                catch: (cause) => copyUnavailable(options.directory, cause),
              })
              if (fits(reduced + metadataBytes)) return { entries, unityLibrary: "excluded" as const }
            }
            return yield* copyUnavailable(
              options.directory,
              `Insufficient free space for an isolated physical copy: ${available} bytes available, ${bytes + metadataBytes} bytes of project and Git data plus reserve required`,
            )
          })
          const beforeCopy = yield* Effect.tryPromise({
            try: () => sourceSignature(options.sourceDirectory, excluded.entries, metadataPaths),
            catch: (cause) => copyUnavailable(options.directory, cause),
          })
          yield* Effect.tryPromise({
            try: async () => {
              await copyTree(options.sourceDirectory, options.directory, fs.copyFile, excluded.entries)
              await materializeGit(
                options.sourceDirectory,
                options.directory,
                gitMetadata,
                fs.copyFile,
                repository?.directory === options.sourceDirectory ? repository.store : undefined,
              )
              if ((await sourceSignature(options.sourceDirectory, excluded.entries, metadataPaths)) !== beforeCopy)
                throw new globalThis.Error("Source changed while creating the isolated workspace")
            },
            catch: (cause) => copyUnavailable(options.directory, cause),
          })
          return excluded.unityLibrary
        }),
      )
      if (Exit.isFailure(copied)) {
        yield* cleanupClaim(options.directory)
        return yield* Effect.failCause(copied.cause)
      }
      yield* Effect.tryPromise({
        try: () =>
          writeMarker(options.directory, {
            requestedStrategy: isolatedWorkspace,
            effectiveStrategy: isolatedCopy,
            fallbackReason: reason,
          }),
        catch: (cause) => copyUnavailable(options.directory, cause),
      }).pipe(Effect.tapError(() => cleanupClaim(options.directory)))
      const directory = yield* input
        .canonical(options.directory)
        .pipe(Effect.tapError(() => cleanupClaim(options.directory)))
      return {
        directory,
        requestedStrategy: isolatedWorkspace,
        effectiveStrategy: isolatedCopy,
        isolation: "physical_copy" as const,
        cow: { attempted: true, achieved: false, verified: true, mechanism: "none" as const, reason },
        safety: {
          unityLibrary: copied.value,
          gitObjects: repository ? ("independent" as const) : ("not_detected" as const),
        },
        fallback: { from: isolatedWorkspace, to: isolatedCopy, reason },
      }
    }),
    remove: Effect.fn("ProjectCopy.IsolatedWorkspace.remove")(function* (options) {
      const metadata = yield* Effect.tryPromise({
        try: () => readMarker(options.directory),
        catch: () => unavailable(options.directory),
      })
      if (!metadata) return yield* unavailable(options.directory)
      if (metadata.effectiveStrategy === gitWorktree) {
        const found = yield* input.git.find(options.directory)
        if (!found) return yield* unavailable(options.directory)
        yield* input.git.worktreeRemove({ repo: found, directory: options.directory, force: options.force })
        return
      }
      if (!metadata.legacy) {
        const identity = yield* Effect.tryPromise({
          try: () => fs.stat(options.directory),
          catch: () => unavailable(options.directory),
        })
        if (
          !metadata.ownership ||
          metadata.ownership.dev !== identity.dev ||
          metadata.ownership.ino !== identity.ino ||
          metadata.ownership.birthtimeMs !== identity.birthtimeMs
        )
          return yield* unavailable(options.directory)
      }
      if (!options.force)
        return yield* new CopyRemovalError({
          directory: options.directory,
          message:
            "Removing an isolated filesystem copy requires force because it may contain work created after isolation",
          forceRequired: true,
        })
      yield* Effect.tryPromise({
        try: async () => {
          await fs.rm(options.directory, { recursive: true, force: true })
          await fs.rm(markerDirectory(options.directory), { recursive: true, force: true })
        },
        catch: () => unavailable(options.directory),
      })
    }),
    handback: (directory) => Effect.promise(() => fs.rm(markerDirectory(directory), { recursive: true, force: true })),
    list: () => Effect.succeed([]),
  } satisfies Strategy
}
