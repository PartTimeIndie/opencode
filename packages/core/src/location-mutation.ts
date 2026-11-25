export * as LocationMutation from "./location-mutation"

import path from "path"
import { realpathSync } from "node:fs"
import { lstat } from "node:fs/promises"
import { Context, Effect, Layer, Schema } from "effect"
import { FSUtil } from "./fs-util"
import { Location } from "./location"

export const Kind = Schema.Literals(["file", "directory"])
export type Kind = typeof Kind.Type

/**
 * Mutation paths do not accept project references. Relative paths resolve
 * against the active Location.
 */
export const ResolveInput = Schema.Struct({
  path: Schema.String,
  /** Selects the external approval boundary; it does not validate the target type. */
  kind: Kind.pipe(Schema.optional),
})
export type ResolveInput = typeof ResolveInput.Type

export class PathError extends Schema.TaggedErrorClass<PathError>()("LocationMutation.PathError", {
  path: Schema.String,
  reason: Schema.Literals(["relative_escape", "location_escape", "non_directory_ancestor", "unresolved_identity"]),
}) {}

export interface ExternalDirectoryAuthorization {
  readonly action: "external_directory"
  /** Canonical existing directory used as the external approval boundary. */
  readonly directory: string
  /** `external_directory` permission resource. */
  readonly resource: string
  readonly save: string
}

export const externalDirectoryPermission = (input: ExternalDirectoryAuthorization) => ({
  action: input.action,
  resources: [input.resource],
  save: [input.save],
})

export interface Target {
  /** Canonical existing path, or missing path below a canonical directory. */
  readonly canonical: string
  /** Permission resource: Location-relative for internal paths, canonical for external paths. */
  readonly resource: string
  readonly externalDirectory?: ExternalDirectoryAuthorization
}

export interface Interface {
  /**
   * Resolve permission resources without granting access. Only callers that
   * enforce external permission and recheck the target before use may opt in
   * to external relative paths and symlink/junction aliases.
   */
  readonly resolve: (input: ResolveInput, options?: ResolveOptions) => Effect.Effect<Target, PathError | FSUtil.Error>
}

interface ResolveOptions {
  readonly authorizeExternalAliases: true
}

export const guardedPaths = { authorizeExternalAliases: true } satisfies ResolveOptions

export function sameTarget(expected: Target, current: Target) {
  return (
    expected.canonical === current.canonical &&
    expected.resource === current.resource &&
    expected.externalDirectory?.resource === current.externalDirectory?.resource
  )
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/LocationMutation") {}

interface ResolvedPath {
  readonly canonical: string
  readonly type?:
    "File" | "Directory" | "SymbolicLink" | "BlockDevice" | "CharacterDevice" | "FIFO" | "Socket" | "Unknown"
  readonly directory: string
}

const slash = (value: string) => value.replaceAll("\\", "/")

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service

    function notFound<A>(effect: Effect.Effect<A, FSUtil.Error>) {
      return effect.pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
    }

    // Bun's JS realpath preserves the requested Windows filename casing;
    // the native handle-based path returns the on-disk spelling instead.
    // Do not lowercase: Windows can have case-sensitive directories.
    const canonicalExisting = (value: string) =>
      process.platform !== "win32"
        ? Effect.succeed(value)
        : Effect.try({
            try: () => realpathSync.native(value),
            catch: () => new PathError({ path: value, reason: "unresolved_identity" }),
          })
    const locationRoot = yield* fs.realPath(location.directory).pipe(Effect.flatMap(canonicalExisting))

    // realpath NotFound can also mean a dangling link. Only genuinely missing
    // entries may contribute prospective path segments.
    const assertMissing = (value: string) => Effect.tryPromise({
      try: async () => {
        try {
          await lstat(value)
        } catch (cause) {
          if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return
          throw cause
        }
        throw new Error("Unresolved existing path")
      },
      catch: () => new PathError({ path: value, reason: "unresolved_identity" }),
    })

    const resolvePath = Effect.fnUntraced(function* (absolute: string) {
      const existing = yield* notFound(fs.realPath(absolute))
      if (existing !== undefined) {
        const canonical = yield* canonicalExisting(existing)
        const info = yield* fs.stat(canonical)
        return {
          canonical,
          type: info.type,
          directory: info.type === "Directory" ? canonical : path.dirname(canonical),
        } satisfies ResolvedPath
      }

      yield* assertMissing(absolute)
      let anchor = path.dirname(absolute)
      while (true) {
        const canonical = yield* notFound(fs.realPath(anchor))
        if (canonical !== undefined) {
          const info = yield* fs.stat(canonical)
          if (info.type !== "Directory") {
            return yield* new PathError({ path: absolute, reason: "non_directory_ancestor" })
          }
          const directory = yield* canonicalExisting(canonical)
          return { canonical: path.resolve(directory, path.relative(anchor, absolute)), directory } satisfies ResolvedPath
        }
        yield* assertMissing(anchor)
        const parent = path.dirname(anchor)
        if (parent === anchor) return yield* new PathError({ path: absolute, reason: "non_directory_ancestor" })
        anchor = parent
      }
    })

    const resolve = Effect.fn("LocationMutation.resolve")(function* (input: ResolveInput, options?: ResolveOptions) {
      const relative = !path.isAbsolute(input.path)
      const absolute = path.resolve(location.directory, input.path)
      const lexicallyInternal = FSUtil.contains(location.directory, absolute)
      if (!options?.authorizeExternalAliases && relative && !lexicallyInternal)
        return yield* new PathError({ path: input.path, reason: "relative_escape" })

      const resolved = yield* resolvePath(absolute)
      // Windows path.relative folds case, even for case-sensitive directories.
      const canonicallyInternal =
        resolved.canonical === locationRoot ||
        resolved.canonical.startsWith(locationRoot.endsWith(path.sep) ? locationRoot : locationRoot + path.sep)
      if (!options?.authorizeExternalAliases && lexicallyInternal && !canonicallyInternal) {
        return yield* new PathError({ path: input.path, reason: "location_escape" })
      }

      const external = !lexicallyInternal || !canonicallyInternal
      const resource = external
        ? slash(resolved.canonical)
        : slash(path.relative(locationRoot, resolved.canonical) || ".")
      const externalDirectory =
        input.kind === "directory" && resolved.type === "Directory" ? resolved.canonical : resolved.directory
      const externalResource = slash(path.join(externalDirectory, "*"))
      return {
        canonical: resolved.canonical,
        resource,
        externalDirectory: external
          ? {
              action: "external_directory",
              directory: externalDirectory,
              resource: externalResource,
              save: externalResource,
            }
          : undefined,
      } satisfies Target
    })

    return Service.of({ resolve })
  }),
)

export const locationLayer = layer
