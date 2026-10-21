// Pure, framework-agnostic helpers for the plugin custom-chat-part surface.
// Kept out of app-runtime.tsx so unit tests can import them without pulling in
// SolidJS server-only modules.

export type CustomPart = {
  id: string
  sessionID: string
  messageID: string
  type: "custom"
  kind: string
  data: unknown
  title?: string
  fallback?: string
  metadata?: Record<string, unknown>
  time?: {
    start: number
    end?: number
  }
}

// Title and fallback are surfaced in plain-text contexts (tab fallback, copy,
// accessibility tools). Bound them so a malicious or buggy plugin cannot push
// huge strings or smuggle text into other UI surfaces via custom parts.
export const CUSTOM_PART_TITLE_MAX = 200
export const CUSTOM_PART_FALLBACK_MAX = 2000

function boundString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  if (value.length <= max) return value
  return value.slice(0, max)
}

export function sanitizeCustomPart<T extends CustomPart>(part: T): T {
  return {
    ...part,
    title: boundString(part.title, CUSTOM_PART_TITLE_MAX),
    fallback: boundString(part.fallback, CUSTOM_PART_FALLBACK_MAX),
  }
}
