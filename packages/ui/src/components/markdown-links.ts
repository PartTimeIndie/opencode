export function markdownPreviewHref(href: string, base: string) {
  const value = href.trim()
  if (!value || /^[A-Za-z]:[\\/]/.test(value)) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) return false
  if (/\.(md|markdown)(?:[?#].*)?$/i.test(value)) return true
  if (!URL.canParse(value, base)) return false
  return /\.(md|markdown)$/i.test(new URL(value, base).pathname)
}
