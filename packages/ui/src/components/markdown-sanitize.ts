import DOMPurify from "dompurify"

if (typeof window !== "undefined" && DOMPurify.isSupported) {
  DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
    // Keep user-clicked file destinations, never file sources on images or frames.
    if (node.nodeName !== "A" || data.attrName !== "href") return
    const href = localFileHref(data.attrValue)
    if (!href) return
    node.setAttribute("href", href)
    data.forceKeepAttr = true
  })
  DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
    if (node.nodeName !== "A") return
    if (node.getAttribute("href")?.startsWith("file:")) {
      node.classList.add("external-link")
      node.setAttribute("target", "_blank")
    }
    if (node.getAttribute("target") !== "_blank") return
    const rel = new Set((node.getAttribute("rel") ?? "").split(/\s+/).filter(Boolean))
    rel.add("noopener")
    rel.add("noreferrer")
    node.setAttribute("rel", Array.from(rel).join(" "))
  })
}

export function localFileHref(value: string) {
  if (/[\u0000-\u001f\u007f]/.test(value) || !URL.canParse(value)) return
  const url = new URL(value)
  if (url.protocol !== "file:" || url.hostname || url.pathname.startsWith("//")) return
  return url.href
}

export function sanitizeMarkdown(html: string) {
  if (!DOMPurify.isSupported) return ""
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, mathMl: true },
    SANITIZE_NAMED_PROPS: true,
    FORBID_TAGS: ["style"],
    FORBID_CONTENTS: ["style", "script"],
    ADD_TAGS: ["svg", "path"],
    ADD_ATTR: ["d", "viewBox", "preserveAspectRatio", "xmlns", "target"],
    ADD_DATA_URI_TAGS: ["img"],
  })
}
