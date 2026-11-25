import type { AttentionEntry } from "./state"

export function recoverableAttention(entries: Record<string, AttentionEntry>, server: string) {
  return Object.entries(entries).flatMap(([key, entry]) => {
    if (!key.startsWith(`${server}\n`) || !entry.enabled || !entry.directory) return []
    const sessionID = key.slice(key.lastIndexOf("\n") + 1)
    return sessionID ? [{ directory: entry.directory, sessionID }] : []
  })
}

export async function recoverAttention<T>(targets: T[], refresh: (target: T) => Promise<unknown>) {
  for (let offset = 0; offset < targets.length; offset += 4) {
    await Promise.all(targets.slice(offset, offset + 4).map(refresh))
  }
}
