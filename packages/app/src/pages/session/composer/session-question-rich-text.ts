export type RichTextCommand = (command: string, showUI: boolean, value: string) => boolean

export function safeRichTextHref(value: string | undefined) {
  if (!value || !/^(https?:|mailto:)/i.test(value.trim())) return
  return value
}

export function captureRichTextSelection(input: HTMLElement) {
  const selection = window.getSelection()
  if (!selection?.rangeCount) return
  const range = selection.getRangeAt(0)
  if (!input.contains(range.commonAncestorContainer)) return
  return range.cloneRange()
}

export function restoreRichTextSelection(input: HTMLElement, range: Range | undefined) {
  input.focus()
  if (!range || !input.contains(range.commonAncestorContainer)) return
  const selection = window.getSelection()
  if (!selection) return
  selection.removeAllRanges()
  selection.addRange(range)
}

export function applyRichTextLink(
  input: HTMLElement,
  range: Range | undefined,
  value: string | undefined,
  exec: RichTextCommand = (command, showUI, href) => document.execCommand(command, showUI, href),
) {
  const href = safeRichTextHref(value)
  if (!href) return false
  restoreRichTextSelection(input, range)
  return exec("createLink", false, href)
}
