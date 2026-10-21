export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"]

// Prompt attachments are managed by the content store and may be rendered or
// represented as unsupported text depending on provider capabilities. The
// picker must therefore not pre-emptively hide otherwise valid file types.
export const ACCEPTED_FILE_TYPES = ["*/*"]
export const ACCEPTED_FILE_EXTENSIONS: string[] = []

export function filePickerFilters(ext?: string[]) {
  if (!ext || ext.length === 0) return undefined
  return [{ name: "Files", extensions: ext }]
}
