export * as ConfigFileTarget from "./file-target"

import path from "node:path"
import { existsSync } from "node:fs"

/** Existing Settings document selection. The directory is host-owned; callers
 * never pass model-selected paths through this boundary. */
export function global(directory: string) {
  const candidates = ["opencode.jsonc", "opencode.json", "config.json"].map((file) => path.join(directory, file))
  return candidates.find((file) => existsSync(file)) ?? candidates[0] ?? path.join(directory, "opencode.jsonc")
}

export function project(directory: string) {
  return path.join(directory, ".opencode", "opencode.json")
}
