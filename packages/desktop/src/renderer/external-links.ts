export function handleExternalLinkClick(event: MouseEvent, openLink: (href: string) => void) {
  if (event.defaultPrevented || !(event.target instanceof Element)) return
  const link = event.target.closest("a.external-link")
  if (!(link instanceof HTMLAnchorElement) || !link.href) return
  event.preventDefault()
  openLink(link.href)
}
