import { managedMediaRequest } from "@/utils/managed-media"
import type { PromptAttachmentPart } from "@/context/prompt"

export async function promptImageBlob(input: { part: PromptAttachmentPart; serverUrl: string; directory: string; sessionID?: string; username?: string; password?: string; fetch: typeof fetch }) {
  const request = managedMediaRequest({ ...input, part: { type: "file", id: input.part.id, messageID: "", sessionID: input.sessionID ?? "", mime: input.part.mime, url: input.part.dataUrl ?? input.part.sourcePath ?? "", filename: input.part.filename }, representation: "content" })
  const response = await input.fetch("direct" in request ? request.direct! : request.url, "headers" in request ? { headers: request.headers } : undefined)
  if (!response.ok) throw new Error(`Image could not be loaded (${response.status})`)
  return response.blob()
}
