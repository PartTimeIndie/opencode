import type { EventEmitter } from "node:events"

/**
 * Bun 1.4 adds a narrow `memoryPressure` overload to `NodeJS.Process`.
 * Keep the normal EventEmitter signal API available to OpenCode as well.
 */
export const processEvents = process as unknown as EventEmitter
