export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
export function errorMessage(value: unknown) { return isRecord(value) && typeof value.message === "string" ? value.message : String(value) }
