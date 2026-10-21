export function isAllowedBrowserUrl(value?: string) {
  if (!value || !URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === "http:" || url.protocol === "https:"
}

export function isAllowedExternalUrl(value?: string) {
  if (!value || !URL.canParse(value)) return false
  const url = new URL(value)
  return isAllowedBrowserUrl(value) || url.protocol === "obsidian:"
}
