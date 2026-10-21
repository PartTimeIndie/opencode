export * as OrchestratorCheckout from "./checkout"

import fs from "fs/promises"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"

export function pathKey(value: string) {
  const file = value.replaceAll("\\", "/")
  const normalized = file === "/" || /^[a-zA-Z]:\/$/.test(file) ? file : file.replace(/\/$/, "")
  // Conservative folding also protects default case-insensitive macOS volumes.
  return process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized
}

export class ResolutionError extends Schema.TaggedErrorClass<ResolutionError>()(
  "OrchestratorCheckout.ResolutionError",
  {
    directory: Schema.String,
  },
) {}

export interface Interface {
  readonly resolve: (directory: string) => Effect.Effect<string, ResolutionError>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/v2/OrchestratorCheckout") {}

// Resolve physical Git checkout identity, not Project ID (shared by worktrees)
// or selected subdirectory. Non-Git projects retain their physical directory.
export const layer = Layer.succeed(
  Service,
  Service.of({
    resolve: (directory) =>
      Effect.tryPromise({
        try: async () => {
          const original = await fs.realpath(directory)
          const find = async (current: string): Promise<string> => {
            const git = await fs.lstat(path.join(current, ".git")).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return undefined
              throw error
            })
            // A linked .git is still a checkout boundary. Falling through would
            // give its root and subdirectories different ownership domains.
            if (git) return pathKey(current)
            const parent = path.dirname(current)
            return parent === current ? pathKey(original) : find(parent)
          }
          return find(original)
        },
        catch: () => new ResolutionError({ directory }),
      }),
  }),
)
