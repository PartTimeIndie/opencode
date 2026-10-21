export function resolveSessionRename(initialTitle: string, value: string) {
  const title = value.trim()
  if (!title) return { status: "empty" as const }
  if (title === initialTitle.trim()) return { status: "unchanged" as const }
  return { status: "changed" as const, title }
}
