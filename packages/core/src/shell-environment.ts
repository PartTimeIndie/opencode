export * as ShellEnvironment from "./shell-environment"

import path from "node:path"
import fs from "node:fs/promises"
import { Context, Effect, Layer, Scope } from "effect"
import type { SessionSchema } from "./session/schema"

export interface Request {
  readonly directory: string
  readonly cwd: string
  readonly sessionID: SessionSchema.ID
  readonly callID: string
}

type Handler = (input: Request) => Effect.Effect<Record<string, string>, Error>

export interface Interface {
  readonly register: (directory: string, handler: Handler) => Effect.Effect<void, Error, Scope.Scope>
  readonly get: (input: Request) => Effect.Effect<Record<string, string>, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShellEnvironment") {}

// Registration and lookup must agree on the host-physical directory identity.
// The plugin host registers the realpath-canonicalized project directory, while
// a native Location keeps its original path (symlink, junction, drive alias).
// Resolve both sides to the same physical path; fall back to the plain
// resolution when the physical path cannot be determined (e.g. directory
// absent) so both sides degrade identically.
const key = async (directory: string) => {
  const resolved = path.resolve(directory)
  const physical = await fs.realpath(resolved).catch(() => resolved)
  return process.platform === "win32" ? physical.toLowerCase() : physical
}

// Application lifetime, like ApplicationTools: location-cache eviction must not
// silently disconnect a loaded server plugin. Each registration owns its release.
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>()
    yield* Effect.addFinalizer(() => Effect.sync(() => handlers.clear()))
    return Service.of({
      register: (directory, handler) => Effect.acquireRelease(
        Effect.gen(function* () {
          const identity = yield* Effect.promise(() => key(directory))
          if (handlers.has(identity)) return yield* Effect.fail(new Error("Shell environment is already registered for this location"))
          handlers.set(identity, handler)
          return identity
        }),
        (identity) => Effect.sync(() => {
          if (handlers.get(identity) === handler) handlers.delete(identity)
        }),
      ).pipe(Effect.asVoid),
      get: (input) => Effect.gen(function* () {
        const identity = yield* Effect.promise(() => key(input.directory))
        const handler = handlers.get(identity)
        if (!handler) return {}
        const env = yield* handler(input)
        if (handlers.get(identity) !== handler) {
          return yield* Effect.fail(new Error("Shell environment plugin was unloaded; shell was not started"))
        }
        return { ...env }
      }),
    })
  }),
)
