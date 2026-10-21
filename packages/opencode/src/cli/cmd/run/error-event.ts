export function serializeErrorEvent(error: unknown, fallback?: string) {
  const source = typeof error === "object" && error !== null ? error : {}
  const data = "data" in source && typeof source.data === "object" && source.data !== null ? source.data : {}
  const message =
    fallback ||
    ("message" in data && typeof data.message === "string" ? data.message : undefined) ||
    ("message" in source && typeof source.message === "string" ? source.message : undefined) ||
    String(error)

  return {
    name: "name" in source && typeof source.name === "string" ? source.name : "Error",
    data: { ...data, message },
  }
}
