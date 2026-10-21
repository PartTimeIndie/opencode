import { base64Decode, base64Encode } from "@opencode-ai/core/util/encode"
import { directoryKey } from "@/utils/path-key"

export function pinnedControlPanelPaneId(directory: string, controlID: string) {
  return `control-panel:pinned:${base64Encode([directoryKey(directory), controlID].join("\0"))}`
}

export function normalizeControlPanelClosedKey(id: string) {
  const pinnedPrefix = "control-panel:pinned:"
  const prefix = id.startsWith(pinnedPrefix) ? pinnedPrefix : "control-panel:"
  if (!id.startsWith(prefix)) return id
  const encoded = id.slice(prefix.length)
  let decoded: string | undefined
  try {
    decoded = base64Decode(encoded)
  } catch {
    return id
  }
  if (!decoded) return id
  if (prefix === pinnedPrefix) {
    const separator = decoded.indexOf("\0")
    if (separator === -1) return id
    const directory = decoded.slice(0, separator)
    const rest = decoded.slice(separator + 1)
    if (!directory || !rest) return id
    const normalized = directoryKey(directory)
    if (normalized === directory) return id
    return `${prefix}${base64Encode([normalized, rest].join("\0"))}`
  }
  const [directory, sessionID, messageID, partID] = decoded.split("\0")
  if (!directory || !sessionID || !messageID || !partID) return id
  const normalized = directoryKey(directory)
  if (normalized === directory) return id
  return `${prefix}${base64Encode([normalized, sessionID, messageID, partID].join("\0"))}`
}
