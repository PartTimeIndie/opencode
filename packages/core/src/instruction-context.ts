export * as InstructionContext from "./instruction-context"

import { Array, Effect, Layer, Option, Schema } from "effect"
import { extname, isAbsolute, join, relative, sep } from "path"
import { FSUtil } from "./fs-util"
import { Flag } from "./flag/flag"
import { Global } from "./global"
import { Location } from "./location"
import { AbsolutePath } from "./schema"
import { SystemContext } from "./system-context/index"
import { SystemContextRegistry } from "./system-context/registry"

class File extends Schema.Class<File>("InstructionContext.File")({
  path: AbsolutePath,
  content: Schema.String,
}) {}

const Files = Schema.Array(File)
const key = SystemContext.Key.make("core/instructions")
export const contextKey = key

type PathSignature = {
  readonly path: string
  readonly value: string
  readonly exists: boolean
}

type CachedObservation = {
  readonly signature: string
  readonly files: ReadonlyArray<File>
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service
    const cache: { current?: CachedObservation } = {}

    const source = (value: ReadonlyArray<File> | SystemContext.Unavailable) =>
      SystemContext.make({
        key,
        codec: Schema.toCodecJson(Files),
        load: Effect.succeed(value),
        baseline: render,
        update: (_previous, current) =>
          `These instructions replace all previously loaded ambient instructions.\n\n${render(current)}`,
        removed: () => "Previously loaded instructions no longer apply.",
      })

    const observe = Effect.fn("InstructionContext.observe")(function* () {
      const start = FSUtil.resolve(location.directory)
      const stop = FSUtil.resolve(location.project.directory)
      const fromProject = relative(stop, start)
      const insideProject =
        fromProject === "" || (fromProject !== ".." && !fromProject.startsWith(`..${sep}`) && !isAbsolute(fromProject))
      const discovered = new Set(
        (Flag.OPENCODE_DISABLE_PROJECT_CONFIG || !insideProject
          ? []
          : yield* fs.up({
              targets: ["AGENTS.md"],
              start,
              stop,
            })
        ).map(FSUtil.resolve),
      )
      const paths = Array.dedupe([FSUtil.resolve(join(global.config, "AGENTS.md")), ...discovered])
      const signatures = yield* Effect.forEach(paths, signature, { concurrency: "unbounded" })
      // This intentionally treats stable file metadata as stable instruction content.
      const cacheKey = signatures.map((item) => item.value).join("\n")
      if (cache.current?.signature === cacheKey) return cache.current.files
      const files = yield* Effect.forEach(
        paths,
        (filePath) =>
          fs
            .readFileStringSafe(filePath)
            .pipe(
              Effect.map((content) =>
                content === undefined ? undefined : new File({ path: AbsolutePath.make(filePath), content }),
              ),
            ),
        { concurrency: "unbounded" },
      )
      if (files.some((file, index) => file === undefined && discovered.has(paths[index])))
        return SystemContext.unavailable
      const result = files.filter((file): file is File => file !== undefined)
      const existing = new Set(signatures.filter((item) => item.exists).map((item) => item.path))
      if (result.every((file) => existing.has(file.path))) cache.current = { signature: cacheKey, files: result }
      else delete cache.current
      return result
    })

    const signature = Effect.fn("InstructionContext.signature")(function* (filePath: string) {
      return yield* fs.stat(filePath).pipe(
        Effect.map((info): PathSignature => {
          const modified = Option.match(info.mtime, {
            onNone: () => "none",
            onSome: (mtime) => mtime.getTime().toString(),
          })
          return {
            path: filePath,
            value: [filePath, info.type, String(info.size), modified].join("\0"),
            exists: true,
          }
        }),
        Effect.catch(() =>
          Effect.succeed({ path: filePath, value: [filePath, "missing"].join("\0"), exists: false }),
        ),
      )
    })

    yield* registry.register({
      key,
      load: observe().pipe(
        Effect.map((files) =>
          files === SystemContext.unavailable
            ? source(files)
            : files.length === 0
              ? SystemContext.empty
              : source(files),
        ),
        Effect.catch(() => Effect.succeed(source(SystemContext.unavailable))),
        Effect.catchDefect(() => Effect.succeed(source(SystemContext.unavailable))),
      ),
    })
  }),
)

export const manual = Effect.fn("InstructionContext.manual")(function* (
  fs: FSUtil.Interface,
  directory: string,
  files: ReadonlyArray<string>,
  allowedRoots: ReadonlyArray<string>,
) {
  const requests = [
    ...new Map(
      files.map((file) => {
        const request = {
          path: FSUtil.resolve(isAbsolute(file) ? file : join(directory, file)),
          explicitlyAbsolute: isAbsolute(file),
        }
        return [request.path, request] as const
      }),
    ).values(),
  ]
  const paths = requests.map((request) => request.path)
  const canonicalRoots = yield* Effect.forEach(
    Array.dedupe(allowedRoots.map(FSUtil.resolve)),
    (root) => fs.realPath(root),
    { concurrency: "unbounded" },
  )
  const canonicalPaths = yield* Effect.forEach(paths, (filePath) => fs.realPath(filePath), {
    concurrency: "unbounded",
  })
  for (const [index, canonicalPath] of canonicalPaths.entries()) {
    const requested = paths[index]!
    const allowed = requests[index]!.explicitlyAbsolute || canonicalRoots.some((root) => FSUtil.contains(root, canonicalPath))
    const extension = extname(canonicalPath).toLowerCase()
    if (!allowed || (extension !== ".md" && extension !== ".txt" && extension !== ".prompt"))
      return yield* Effect.fail(
        new Error(`Instruction file is outside an allowed root or has an unsupported extension: ${requested}`),
      )
  }
  const loaded = yield* Effect.forEach(
    canonicalPaths,
    (filePath) =>
      fs.readFileStringSafe(filePath).pipe(
        Effect.map((content) =>
          content === undefined ? undefined : new File({ path: AbsolutePath.make(filePath), content }),
        ),
      ),
    { concurrency: "unbounded" },
  )
  const existing = loaded.filter((file): file is File => file !== undefined)
  if (existing.length === 0) return SystemContext.empty
  return SystemContext.make({
    key,
    codec: Schema.toCodecJson(Files),
    load: Effect.succeed(existing),
    baseline: render,
    update: (_previous, current) => `These instructions replace all previously loaded ambient instructions.\n\n${render(current)}`,
    removed: () => "Previously loaded instructions no longer apply.",
  })
})

function render(files: ReadonlyArray<File>) {
  return files.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n")
}
