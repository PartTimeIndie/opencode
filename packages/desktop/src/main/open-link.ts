import { isAllowedExternalUrl } from "./url-policy"
import { stat } from "node:fs/promises"
import { extname } from "node:path"
import { fileURLToPath } from "node:url"

// Document associations only: do not turn generated links into executable launches.
const documentExtensions = new Set([
  ".pdf",
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".log",
  ".rtf",
  ".doc",
  ".docx",
  ".odt",
  ".xls",
  ".xlsx",
  ".ods",
  ".ppt",
  ".pptx",
  ".odp",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".mp3",
  ".wav",
  ".ogg",
  ".flac",
  ".mp4",
  ".webm",
  ".mkv",
  ".mov",
])

type LinkOpener = {
  openPath: (path: string) => Promise<string>
  openExternal: (url: string) => Promise<void>
}

export async function openDesktopLink(url: string, opener: LinkOpener) {
  if (URL.canParse(url) && new URL(url).protocol === "file:") {
    const path = localDocumentPath(url)
    if (!(await stat(path)).isFile()) throw new Error("The link does not point to a regular document file.")
    const error = await opener.openPath(path)
    if (error) throw new Error(error)
    return
  }
  if (!isAllowedExternalUrl(url)) return
  await opener.openExternal(url)
}

export function localDocumentPath(value: string, windows = process.platform === "win32") {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid document link.")
  const url = new URL(value)
  if (url.protocol !== "file:" || url.hostname || url.pathname.startsWith("//"))
    throw new Error("Only local document files can be opened.")
  const path = fileURLToPath(url, { windows })
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new Error("Invalid document filename.")
  if (windows && (!/^[a-z]:\\/i.test(path) || path.slice(2).includes(":"))) {
    throw new Error("Network, device and alternate-stream paths cannot be opened.")
  }
  if (!documentExtensions.has(extname(path).toLowerCase()))
    throw new Error("This file type cannot be opened from a document link.")
  return path
}
