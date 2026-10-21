const MAX_BREAKS = 200

export function createTextFragment(content: string): DocumentFragment {
  const fragment = document.createDocumentFragment()
  let breaks = 0
  for (const char of content) {
    if (char !== "\n") continue
    breaks += 1
    if (breaks > MAX_BREAKS) {
      const tail = content.endsWith("\n")
      const text = tail ? content.slice(0, -1) : content
      if (text) fragment.appendChild(document.createTextNode(text))
      if (tail) fragment.appendChild(document.createElement("br"))
      return fragment
    }
  }

  const segments = content.split("\n")
  segments.forEach((segment, index) => {
    if (segment) {
      fragment.appendChild(document.createTextNode(segment))
    }
    if (index < segments.length - 1) {
      fragment.appendChild(document.createElement("br"))
    }
  })
  return fragment
}

export function getNodeLength(node: Node): number {
  return getTextLengthWithinNode(node)
}

export function getTextLength(node: Node): number {
  return getTextLengthWithinNode(node, true)
}

export function getCursorPositionOrNull(parent: HTMLElement): number | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!parent.contains(range.startContainer)) return null
  const preCaretRange = range.cloneRange()
  preCaretRange.selectNodeContents(parent)
  preCaretRange.setEnd(range.startContainer, range.startOffset)
  return getTextLength(preCaretRange.cloneContents())
}

export function getCursorPosition(parent: HTMLElement): number {
  return getCursorPositionOrNull(parent) ?? 0
}

export function setCursorPosition(parent: HTMLElement, position: number) {
  if (!parent.isConnected) return
  const range = document.createRange()
  const selection = window.getSelection()
  if (!setRangePoint(parent, range, "start", position, true)) range.selectNodeContents(parent)
  range.collapse(false)
  selection?.removeAllRanges()
  selection?.addRange(range)
}

export function setRangeEdge(parent: HTMLElement, range: Range, edge: "start" | "end", offset: number) {
  if (setRangePoint(parent, range, edge, offset, true)) return
  setBoundary(range, edge, parent, parent.childNodes.length)
}

function getTextLengthWithinNode(node: Node, blockSeparators = false): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\u200B/g, "").length
  if (isBreak(node)) return isPlaceholderBreak(node) ? 0 : 1
  if (isPill(node)) return (node.textContent ?? "").replace(/\u200B/g, "").length

  const children = Array.from(node.childNodes)
  return children.reduce((length, child, index) => {
    const separator = blockSeparators && isBlock(child) && index < children.length - 1 ? 1 : 0
    return length + getTextLengthWithinNode(child) + separator
  }, 0)
}

function setRangePoint(
  parent: Node,
  range: Range,
  edge: "start" | "end",
  offset: number,
  blockSeparators: boolean,
) {
  let remaining = offset
  const nodes = Array.from(parent.childNodes)

  for (const [index, node] of nodes.entries()) {
    const length = getNodeLength(node)
    if (remaining <= length) return setRangePointInNode(range, edge, node, remaining)

    remaining -= length
    if (!blockSeparators || !isBlock(node) || index >= nodes.length - 1) continue
    if (remaining <= 1) return setRangePointInNode(range, edge, nodes[index + 1]!, 0)
    remaining -= 1
  }

  return false
}

function setRangePointInNode(range: Range, edge: "start" | "end", node: Node, offset: number) {
  if (node.nodeType === Node.TEXT_NODE) {
    setBoundary(range, edge, node, Math.min(offset, node.textContent?.length ?? 0))
    return true
  }
  if (isPill(node) || isBreak(node)) {
    if (offset === 0) setBoundaryBefore(range, edge, node)
    if (offset > 0) setBoundaryAfter(range, edge, node)
    return true
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    if (setRangePoint(node, range, edge, offset, false)) return true
    setBoundary(range, edge, node, node.childNodes.length)
    return true
  }
  return false
}

function isBreak(node: Node) {
  return node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR"
}

function isPill(node: Node) {
  return (
    node.nodeType === Node.ELEMENT_NODE &&
    ((node as HTMLElement).dataset.type === "file" || (node as HTMLElement).dataset.type === "agent")
  )
}

function isBlock(node: Node) {
  return node.nodeType === Node.ELEMENT_NODE && ((node as HTMLElement).tagName === "DIV" || (node as HTMLElement).tagName === "P")
}

export function isPlaceholderBreak(node: Node) {
  const parent = node.parentNode
  if (!parent || !isBlock(parent)) return false
  const siblings = Array.from(parent.childNodes)
  const index = siblings.indexOf(node as ChildNode)
  return !siblings.slice(index + 1).some((child) => isBreak(child) || getTextLengthWithinNode(child) > 0)
}

function setBoundary(range: Range, edge: "start" | "end", node: Node, offset: number) {
  if (edge === "start") range.setStart(node, offset)
  if (edge === "end") range.setEnd(node, offset)
}

function setBoundaryBefore(range: Range, edge: "start" | "end", node: Node) {
  if (edge === "start") range.setStartBefore(node)
  if (edge === "end") range.setEndBefore(node)
}

function setBoundaryAfter(range: Range, edge: "start" | "end", node: Node) {
  if (edge === "start") range.setStartAfter(node)
  if (edge === "end") range.setEndAfter(node)
}
