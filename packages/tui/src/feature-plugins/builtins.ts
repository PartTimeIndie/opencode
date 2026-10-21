/** Declarative preinstallation only; every entry is resolved by the public package loader. */
export const builtinTuiPackages = [
  "home-footer",
  "home-tips",
  "sidebar-context",
  "sidebar-mcp",
  "sidebar-lsp",
  "sidebar-todo",
  "sidebar-files",
  "sidebar-footer",
  "notifications",
  "plugin-manager",
  "which-key",
  "diff-viewer",
] as const

export function createBuiltinPlugins(directory = new URL("../../../tui-plugins/", import.meta.url)) {
  return builtinTuiPackages.map((name) => new URL(name + "/", directory).href)
}
