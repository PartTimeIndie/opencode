import type { AttentionEntry, AttentionSnapshot } from "./state"
import type { AttentionCommand, AttentionResult } from "./broker"

/** Desktop orchestration: fetch outside the writer, then compare-and-update in main. */
export async function refreshAttention(input: {
  key: string
  current(): AttentionEntry | undefined
  fetch(afterSeq: number): Promise<AttentionSnapshot>
  update(command: AttentionCommand): Promise<AttentionResult>
  receive(entry: AttentionEntry): void
  enabled(): boolean
  visible(): boolean
  live: () => boolean
}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const start = input.current()
    if (!start?.enabled || !input.enabled()) return false
    const snapshot = await input.fetch(start.cursor)
    if (!input.enabled()) return false
    const result = await input.update({ type: "refresh", key: input.key, afterSeq: start.cursor, snapshot })
    if (result.entry) input.receive(result.entry)
    if (result.stale) continue
    if (!result.notify || !input.live() || input.visible() || !input.enabled()) return false
    const claim = await input.update({ type: "claim", key: input.key, cursor: snapshot.cursor })
    if (claim.entry) input.receive(claim.entry)
    return claim.notify && input.enabled() && !input.visible()
  }
  return false
}
