export * as ToolContextCache from "./cache"

const DEFAULT_MAX_ENTRIES = 128
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024
const DEFAULT_TTL_MS = 15 * 60 * 1000

type Entry = { readonly value: string; readonly bytes: number; readonly storedAt: number; readonly usedAt: number }

export type CacheKey = {
  readonly scope: string
  readonly sha256: string
  readonly processor: string
  readonly options: string
}

export const cacheKey = (input: CacheKey) => `${input.scope}\0${input.sha256}\0${input.processor}\0${input.options}`

/** Bounded process-local LRU for deterministic compressed views; misses must be functionally identical. */
export class ViewCache {
  private readonly entries = new Map<string, Entry>()
  private totalBytes = 0

  constructor(
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {}

  get(key: string, now: number): string | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (now - entry.storedAt > this.ttlMs) {
      this.delete(key)
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, { ...entry, usedAt: now })
    return entry.value
  }

  set(key: string, value: string, now: number) {
    this.delete(key)
    const bytes = Buffer.byteLength(value, "utf8")
    if (bytes > this.maxBytes) return
    this.entries.set(key, { value, bytes, storedAt: now, usedAt: now })
    this.totalBytes += bytes
    this.evict(now)
  }

  private delete(key: string) {
    const entry = this.entries.get(key)
    if (!entry) return
    this.totalBytes -= entry.bytes
    this.entries.delete(key)
  }

  private evict(now: number) {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.totalBytes <= this.maxBytes) return
      if (now - entry.storedAt > this.ttlMs || this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
        this.delete(key)
      }
    }
  }
}
