export * as Npm from "./npm"

import path from "path"
import fs from "fs"
import npa from "npm-package-arg"
import { Effect, Schema, Context, Layer, Option, FileSystem } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { EffectFlock } from "./util/effect-flock"
import { LayerNode } from "./effect/layer-node"
import { filesystem } from "./effect/layer-node-platform"
import { makeRuntime } from "./effect/runtime"
import { NpmConfig } from "./npm-config"

export class InstallFailedError extends Schema.TaggedErrorClass<InstallFailedError>()("NpmInstallFailedError", {
  add: Schema.Array(Schema.String).pipe(Schema.optional),
  dir: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface EntryPoint {
  readonly directory: string
  readonly entrypoint: Option.Option<string>
}

export interface Interface {
  readonly add: (pkg: string) => Effect.Effect<EntryPoint, InstallFailedError | EffectFlock.LockError>
  readonly install: (
    dir: string,
    input?: {
      add: {
        name: string
        version?: string
      }[]
      provided?: string[]
    },
  ) => Effect.Effect<void, EffectFlock.LockError | InstallFailedError>
  readonly which: (pkg: string, bin?: string) => Effect.Effect<Option.Option<string>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Npm") {}

const illegal = process.platform === "win32" ? new Set(["<", ">", ":", '"', "|", "?", "*"]) : undefined

export function sanitize(pkg: string) {
  if (!illegal) return pkg
  return Array.from(pkg, (char) => (illegal.has(char) || char.charCodeAt(0) < 32 ? "_" : char)).join("")
}

export function packageImportFile(dir: string) {
  const json = readPackageJson(dir)
  if (!json) return
  const raw = exportPath(json.exports) ?? stringField(json.module) ?? stringField(json.main)
  if (!raw) return
  return path.resolve(dir, raw)
}

const resolveEntryPoint = (name: string, dir: string): EntryPoint => {
  const fromPackage = packageImportFile(dir)
  if (fromPackage) {
    return {
      directory: dir,
      entrypoint: Option.some(fromPackage),
    }
  }
  try {
    const resolved = typeof Bun !== "undefined" ? import.meta.resolve(name, dir) : import.meta.resolve(dir)
    return {
      directory: dir,
      entrypoint: Option.some(resolved),
    }
  } catch {
    return {
      directory: dir,
      entrypoint: Option.none(),
    }
  }
}

function readPackageJson(dir: string) {
  try {
    const raw = fs.readFileSync(path.join(dir, "package.json"), "utf8")
    const json = JSON.parse(raw)
    if (!json || typeof json !== "object" || Array.isArray(json)) return
    return json as Record<string, unknown>
  } catch {
    return
  }
}

function stringField(value: unknown) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

function exportPath(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const root = (value as Record<string, unknown>)["."] ?? value
  if (typeof root === "string") return root
  if (!root || typeof root !== "object" || Array.isArray(root)) return
  const conditions = root as Record<string, unknown>
  return stringField(conditions.import) ?? stringField(conditions.default)
}

interface ArboristNode {
  name: string
  path: string
}

interface ArboristTree {
  edgesOut: Map<string, { to?: ArboristNode }>
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const afs = yield* FSUtil.Service
    const global = yield* Global.Service
    const fs = yield* FileSystem.FileSystem
    const flock = yield* EffectFlock.Service
    const directory = (pkg: string) => path.join(global.cache, "packages", sanitize(pkg))
    const reify = (input: { dir: string; add?: string[] }) =>
      Effect.gen(function* () {
        yield* flock.acquire(`npm-install:${input.dir}`)
        const { Arborist } = yield* Effect.promise(() => import("@npmcli/arborist"))
        const add = input.add ?? []
        const npmOptions = yield* NpmConfig.load(input.dir)
        const arborist = new Arborist({
          ...npmOptions,
          path: input.dir,
          binLinks: true,
          progress: false,
          savePrefix: "",
          ignoreScripts: true,
        })
        return yield* Effect.tryPromise({
          try: () =>
            arborist.reify({
              ...npmOptions,
              add,
              save: true,
              saveType: "prod",
            }),
          catch: (cause) =>
            new InstallFailedError({
              cause,
              add,
              dir: input.dir,
            }),
        }) as Effect.Effect<ArboristTree, InstallFailedError>
      }).pipe(
        Effect.withSpan("Npm.reify", {
          attributes: input,
        }),
      )

    const add = Effect.fn("Npm.add")(function* (pkg: string) {
      const dir = directory(pkg)
      const name = (() => {
        try {
          return npa(pkg).name ?? pkg
        } catch {
          return pkg
        }
      })()

      if (yield* afs.existsSafe(path.join(dir, "node_modules", name))) {
        return resolveEntryPoint(name, path.join(dir, "node_modules", name))
      }

      const tree = yield* reify({ dir, add: [pkg] })
      const first = tree.edgesOut.values().next().value?.to
      if (!first) {
        const result = resolveEntryPoint(name, path.join(dir, "node_modules", name))
        if (Option.isSome(result.entrypoint)) return result
        return yield* new InstallFailedError({ add: [pkg], dir })
      }
      return resolveEntryPoint(first.name, first.path)
    }, Effect.scoped)

    const install: Interface["install"] = Effect.fn("Npm.install")(function* (dir, input) {
      const canWrite = yield* afs.access(dir, { writable: true }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
      if (!canWrite) return

      const removedProvided = yield* Effect.gen(function* () {
        if (!input?.provided?.length) return []
        const file = path.join(dir, "package.json")
        const pkg = yield* afs.readJson(file).pipe(Effect.orElseSucceed(() => ({})))
        if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return []
        const record = pkg as Record<string, unknown>
        const removed = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap(
          (field) =>
            input.provided!.flatMap((name) => {
              const dependencies = record[field]
              if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) return []
              const entries = dependencies as Record<string, unknown>
              if (!(name in entries)) return []
              const value = entries[name]
              delete entries[name]
              return [{ field, name, value }]
            }),
        )
        if (!removed.length) return removed
        yield* afs.writeJson(file, record).pipe(
          Effect.mapError((cause) => new InstallFailedError({ cause, dir })),
        )
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const pkg = yield* afs.readJson(file)
            if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return
            const record = pkg as Record<string, unknown>
            for (const item of removed) {
              const dependencies = record[item.field]
              const entries =
                dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)
                  ? (dependencies as Record<string, unknown>)
                  : (record[item.field] = {})
              entries[item.name] = item.value
            }
            yield* afs.writeJson(file, record)
          }).pipe(Effect.orDie),
        )
        return removed
      }).pipe(Effect.uninterruptible, Effect.withSpan("Npm.removeProvided"))

      const add = input?.add.map((pkg) => [pkg.name, pkg.version].filter(Boolean).join("@")) ?? []
      if (
        yield* Effect.gen(function* () {
          const nodeModulesExists = yield* afs.existsSafe(path.join(dir, "node_modules"))
          if (!nodeModulesExists || removedProvided.length) {
            yield* reify({ add, dir })
            return true
          }
          return false
        }).pipe(Effect.withSpan("Npm.checkNodeModules"))
      )
        return

      yield* Effect.gen(function* () {
        const pkg = yield* afs.readJson(path.join(dir, "package.json")).pipe(Effect.orElseSucceed(() => ({})))
        const lock = yield* afs.readJson(path.join(dir, "package-lock.json")).pipe(Effect.orElseSucceed(() => ({})))

        const pkgAny = pkg as any
        const lockAny = lock as any
        const staleRequestedDependency = (input?.add ?? []).some((item) => {
          if (!item.version) return false
          const version = [
            pkgAny?.dependencies?.[item.name],
            pkgAny?.devDependencies?.[item.name],
            pkgAny?.peerDependencies?.[item.name],
            pkgAny?.optionalDependencies?.[item.name],
          ].find((value): value is string => typeof value === "string")
          return version !== item.version
        })
        if (staleRequestedDependency) {
          yield* reify({ dir, add })
          return
        }

        const declared = new Set([
          ...Object.keys(pkgAny?.dependencies || {}),
          ...Object.keys(pkgAny?.devDependencies || {}),
          ...Object.keys(pkgAny?.peerDependencies || {}),
          ...Object.keys(pkgAny?.optionalDependencies || {}),
          ...(input?.add || []).map((pkg) => pkg.name),
        ])

        const root = lockAny?.packages?.[""] || {}
        const locked = new Set([
          ...Object.keys(root?.dependencies || {}),
          ...Object.keys(root?.devDependencies || {}),
          ...Object.keys(root?.peerDependencies || {}),
          ...Object.keys(root?.optionalDependencies || {}),
        ])

        for (const name of declared) {
          if (!locked.has(name)) {
            yield* reify({ dir, add })
            return
          }
        }
      }).pipe(Effect.withSpan("Npm.checkDirty"))

      return
    }, Effect.scoped)

    const which = Effect.fn("Npm.which")(function* (pkg: string, bin?: string) {
      const dir = directory(pkg)
      const binDir = path.join(dir, "node_modules", ".bin")

      const pick = Effect.fnUntraced(function* () {
        const files = yield* fs.readDirectory(binDir).pipe(Effect.catch(() => Effect.succeed([] as string[])))

        if (files.length === 0) return Option.none<string>()
        // Caller picked a specific bin (e.g. pyright exposes both `pyright` and
        // `pyright-langserver`); trust the hint if the package provides it.
        if (bin) return files.includes(bin) ? Option.some(bin) : Option.none<string>()
        if (files.length === 1) return Option.some(files[0])

        const pkgJson = yield* afs.readJson(path.join(dir, "node_modules", pkg, "package.json")).pipe(Effect.option)

        if (Option.isSome(pkgJson)) {
          const parsed = pkgJson.value as { bin?: string | Record<string, string> }
          if (parsed?.bin) {
            const unscoped = pkg.startsWith("@") ? pkg.split("/")[1] : pkg
            const parsedBin = parsed.bin
            if (typeof parsedBin === "string") return Option.some(unscoped)
            const keys = Object.keys(parsedBin)
            if (keys.length === 1) return Option.some(keys[0])
            return parsedBin[unscoped] ? Option.some(unscoped) : Option.some(keys[0])
          }
        }

        return Option.some(files[0])
      })

      return yield* Effect.gen(function* () {
        const bin = yield* pick()
        if (Option.isSome(bin)) {
          return Option.some(path.join(binDir, bin.value))
        }

        yield* fs.remove(path.join(dir, "package-lock.json")).pipe(Effect.orElseSucceed(() => {}))

        yield* add(pkg)

        const resolved = yield* pick()
        if (Option.isNone(resolved)) return Option.none<string>()
        return Option.some(path.join(binDir, resolved.value))
      }).pipe(
        Effect.scoped,
        Effect.orElseSucceed(() => Option.none<string>()),
      )
    })

    return Service.of({
      add,
      install,
      which,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EffectFlock.layer),
  Layer.provide(FSUtil.layer),
  Layer.provide(Global.layer),
  Layer.provide(NodeFileSystem.layer),
)
export const node = LayerNode.make(layer, [FSUtil.node, Global.node, filesystem, EffectFlock.node])

const { runPromise } = makeRuntime(Service, defaultLayer)

export async function install(...args: Parameters<Interface["install"]>) {
  return runPromise((svc) => svc.install(...args))
}

export async function add(...args: Parameters<Interface["add"]>) {
  const entry = await runPromise((svc) => svc.add(...args))
  return {
    directory: entry.directory,
    entrypoint: Option.getOrUndefined(entry.entrypoint),
  }
}

export async function which(...args: Parameters<Interface["which"]>) {
  const resolved = await runPromise((svc) => svc.which(...args))
  return Option.getOrUndefined(resolved)
}
