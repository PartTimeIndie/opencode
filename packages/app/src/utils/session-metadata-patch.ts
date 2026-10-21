export type SessionMetadataPatch = {
  set?: Record<string, unknown>
  unset?: string[]
}

export function setSessionMetadata(key: string, value: unknown): SessionMetadataPatch {
  return { set: { [key]: value } }
}

export function unsetSessionMetadata(key: string): SessionMetadataPatch {
  return { unset: [key] }
}

export function applySessionMetadataPatch(
  metadata: Record<string, unknown> | undefined,
  patch: SessionMetadataPatch,
): Record<string, unknown> {
  const next = { ...(metadata ?? {}), ...(patch.set ?? {}) }
  for (const key of patch.unset ?? []) delete next[key]
  return next
}
