import type { Prompt, PromptAttachmentPart } from "@/context/prompt"
import { loadAnnotation, pinAnnotation, releaseAnnotation } from "./storage"

export function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("Image could not be read"))
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Image could not be read"))
    reader.readAsDataURL(blob)
  })
}
export async function resolveAnnotationPart(part: PromptAttachmentPart): Promise<PromptAttachmentPart> {
  if (!part.annotation) return { ...part }
  const doc = await loadAnnotation(part.annotation)
  return { type: "image", id: part.id, filename: doc.filename.replace(/\.[^.]+$/, "") + ".png", mime: "image/png", dataUrl: await blobDataUrl(doc.png) }
}
export async function resolveAnnotationPrompt(prompt: Prompt): Promise<Prompt> {
  return Promise.all(prompt.map((part) => part.type === "image" ? resolveAnnotationPart(part) : { ...part }))
}
export async function acquireAnnotationSend(prompt: Prompt) {
  const refs = prompt.flatMap((part) => part.type === "image" && part.annotation ? [part.annotation] : [])
  const token = crypto.randomUUID()
  const pinned: typeof refs = []
  const release = async (admitted = false) => {
    await Promise.all(pinned.map((ref) => releaseAnnotation(ref, token, admitted)))
  }
  return Promise.resolve().then(async () => {
    for (const ref of refs) { await pinAnnotation(ref, token); pinned.push(ref) }
    const resolved = await resolveAnnotationPrompt(prompt)
    return { prompt: resolved, release }
  }).catch(async (error: unknown) => { await release(); throw error })
}
