import type { PromptAttachmentPart, Prompt } from "@/context/prompt"
import { activeAnnotations, isAnnotationDraft, loadAnnotation, saveAnnotation } from "./storage"
import { blobDataUrl } from "./resolve"
import type { Scene } from "./model"

export async function annotationPart(ref: NonNullable<PromptAttachmentPart["annotation"]>): Promise<PromptAttachmentPart> {
  const document = await loadAnnotation(ref)
  return { type: "image", id: document.attachmentID, filename: document.filename, mime: "image/png", annotation: { ...ref }, dataUrl: await blobDataUrl(document.png) }
}
export async function restoreAnnotations(scope: string, current: () => Prompt, set: (prompt: Prompt) => void) {
  const documents = await activeAnnotations(scope)
  const restored = await Promise.all(documents.map((doc) => annotationPart(doc.ref)))
  const markers = current().flatMap((part) => part.type === "image" && part.annotation ? [part.annotation] : [])
  const retired = new Set<string>()
  for (const ref of [...markers, ...documents.map((doc) => doc.ref)]) if (!(await isAnnotationDraft(ref))) retired.add(ref.documentID)
  // Re-read after asynchronous decoding: preserve text typed meanwhile. Replace
  // an original with the same attachment ID too (crash after DB commit, before
  // the prompt marker). A sent/removed marker must never restore an old image.
  set(reconcileAnnotations(current(), restored, retired))
}

export function reconcileAnnotations(prompt: Prompt, restored: PromptAttachmentPart[], retired: ReadonlySet<string>): Prompt {
  const retiredIDs = new Set(restored.filter((part) => part.annotation && retired.has(part.annotation.documentID)).map((part) => part.id))
  const available = restored.filter((part) => part.annotation && !retired.has(part.annotation.documentID))
  const next = prompt.flatMap<Prompt[number]>((part) => {
    if (part.type !== "image") return [part]
    if (retiredIDs.has(part.id) || (part.annotation && retired.has(part.annotation.documentID))) return []
    return [available.find((doc) => doc.id === part.id) ?? part]
  })
  available.forEach((part) => { if (!next.some((candidate) => candidate.type === "image" && candidate.id === part.id)) next.push(part) })
  return next
}
export async function commitAnnotation(input: { scope: string; part: PromptAttachmentPart; original: Blob; scene: Scene; png: Blob; current?: () => boolean }) {
  const ref = await saveAnnotation({ ...input, previous: input.part.annotation, attachmentID: input.part.id, filename: input.part.filename })
  return annotationPart(ref)
}
