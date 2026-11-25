export const MAXIMUM_CLIPBOARD_TEXT_LENGTH = 200_000

export type ClipboardTextResult = { ok: true } | { ok: false; error: string }

/** Same boundary as browser-transfer-ipc: only a window's own main frame may write. */
export function isOwningWindowSender(sender: { senderFrame?: unknown; mainFrame?: unknown; getType(): string }) {
  return sender.senderFrame != null && sender.senderFrame === sender.mainFrame && sender.getType() === "window"
}

/** Renderer clipboard writes need document focus in Chromium; the shell has no such limit. */
export function writeClipboardText(text: unknown, write: (text: string) => void): ClipboardTextResult {
  if (typeof text !== "string" || !text) return { ok: false, error: "The clipboard text is empty." }
  if (text.length > MAXIMUM_CLIPBOARD_TEXT_LENGTH) return { ok: false, error: "The clipboard text is too large." }
  try {
    write(text)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
