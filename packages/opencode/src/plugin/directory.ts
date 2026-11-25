import { realpath } from "node:fs/promises"
import { posix, resolve, win32 } from "node:path"

/** Server plugin APIs always receive an absolute host-owned project scope. */
export function absolutePluginDirectory(directory: string) {
  // The choice must follow the host platform, not the input shape:
  // win32.isAbsolute also claims POSIX root paths, and win32.resolve would
  // mangle `/srv/project` into `C:\srv\project` on Linux/macOS.
  if (process.platform === "win32") return win32.resolve(directory || ".")
  if (posix.isAbsolute(directory)) return posix.resolve(directory)
  return win32.isAbsolute(directory) ? win32.resolve(directory) : posix.resolve(directory || ".")
}

export function sameDirectory(left: string, right: string) {
  if (win32.isAbsolute(left) || win32.isAbsolute(right)) {
    return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase()
  }
  return resolve(left) === resolve(right)
}

const resolvedEqual = (left: string, right: string) =>
  // Follow the host platform, not the input shape: win32.isAbsolute also
  // claims POSIX root paths, so an input-shape rule would fold case for two
  // distinct case-sensitive POSIX directories without touching the
  // filesystem. samePluginScope only compares host-resolved directories,
  // where this rule matches absolutePluginDirectory's normalization.
  process.platform === "win32"
    ? win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase()
    : resolve(left) === resolve(right)

/**
 * Same project scope for plugin host APIs, tolerating Windows drive aliases
 * (subst/junction, e.g. C:\proj vs E:\proj for one physical checkout), case
 * and separator drift across app relaunches. The gate compares physical
 * scope: an in-tree symlink into another project resolves to that project's
 * directory. Identical spellings are accepted lexically without filesystem
 * access (archived catalogs can outlive their directories); differing
 * spellings fall back to realpath and reject when either cannot be resolved.
 */
export async function samePluginScope(left: string, right: string) {
  if (resolvedEqual(left, right)) return true
  try {
    const [leftReal, rightReal] = await Promise.all([realpath(left), realpath(right)])
    return resolvedEqual(leftReal, rightReal)
  } catch {
    return false
  }
}

/**
 * Host plugin routes accept either an absolute project directory or the app's
 * "global" sentinel, mapped to a host-owned directory. Anything else returns
 * undefined so the route can reject the request before provider resolution: a
 * relative string would otherwise silently resolve against the server's
 * working directory and inherit whatever project config happens to live there.
 */
export function hostRouteDirectory(directory: string, options: { globalDirectory: string }): string | undefined {
  if (directory === "global") return options.globalDirectory
  // Either platform's absolute form is valid: absolutePluginDirectory keeps
  // both shapes absolute on every host, so both belong in the allowed set.
  if (!win32.isAbsolute(directory) && !posix.isAbsolute(directory)) return undefined
  return directory
}
