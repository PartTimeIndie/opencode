import { createBuiltinPlugins } from "@opencode-ai/tui/builtins"
import { pathToFileURL } from "node:url"
import path from "node:path"
import { existsSync } from "node:fs"

export function internalTuiPlugins() {
  const packaged = path.join(path.dirname(process.execPath), "plugin-packages", "tui")
  const directory = process.env.OPENCODE_TUI_PLUGIN_DIR ?? (existsSync(path.join(packaged, "release-manifest.json")) ? packaged : undefined)
  return createBuiltinPlugins(directory ? pathToFileURL(path.resolve(directory) + path.sep) : undefined).map(
    (spec) => ({ spec, source: "preinstalled", scope: "global" as const }),
  )
}
