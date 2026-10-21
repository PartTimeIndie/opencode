/** Presentation only: never use this label as a plugin identifier or install spec. */
export function pluginDisplayName(spec: string, displayName?: unknown) {
  if (typeof displayName === "string" && displayName.trim()) return displayName.trim().slice(0, 120)
  const segments = spec
    .replace(/\\/g, "/")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .split("/")
  const leaf = segments.at(-1) ?? ""
  const name = /^(index|app|server|tui)\.[cm]?[jt]sx?$/i.test(leaf) ? (segments.at(-2) ?? leaf) : leaf
  return (
    name
      .replace(/@[^@]*$/, "")
      .replace(/\.[cm]?[jt]sx?$/i, "")
      .replace(/(?:-app|-plugin)$/, "")
      .replace(/^opencode-/, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((word) =>
        /^(ai|qa|ui|tui|stt|tts|api|git)$/i.test(word) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1),
      )
      .join(" ") || "Plugin"
  )
}
