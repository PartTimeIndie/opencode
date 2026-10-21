const rendererPermissions = new Set(["clipboard-sanitized-write", "notifications"])

export function rendererPermissionAllowed(input: {
  permission: string
  trusted: boolean
  mainContents: boolean
  mediaTypes?: ReadonlyArray<"audio" | "video">
  mediaType?: "audio" | "video" | "unknown"
}) {
  if (!input.trusted || !input.mainContents) return false
  if (input.permission !== "media") return rendererPermissions.has(input.permission)
  if (input.mediaTypes) return input.mediaTypes.length === 1 && input.mediaTypes[0] === "audio"
  return input.mediaType === "audio"
}
