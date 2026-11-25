import type { Prompt } from "@/context/prompt"
import { loadAnnotation, removeAnnotation, saveAnnotation } from "./storage"

// A parked followup owns an independent, immutable durable snapshot. Editing or
// removing the composer image can never replace the PNG of an already queued send.
export async function snapshotAnnotationQueue(prompt: Prompt) {
  const copies: NonNullable<Extract<Prompt[number], { type: "image" }>["annotation"]>[] = []
  const originals: typeof copies = []
  try {
    const next: Prompt = []
    for (const part of prompt) {
      if (part.type !== "image" || !part.annotation) { next.push({ ...part }); continue }
      const doc = await loadAnnotation(part.annotation)
      const ref = await saveAnnotation({ ...doc, scope: doc.ref.scope, owner: "queue" })
      copies.push(ref)
      originals.push(part.annotation)
      // The persisted queue needs only the local marker, never inline image bytes.
      next.push({ type: "image", id: part.id, filename: part.filename, mime: "image/png", annotation: ref })
    }
    return {
      prompt: next,
      commit: () => Promise.all(originals.map((ref) => removeAnnotation(ref))),
      rollback: () => Promise.all(copies.map((ref) => removeAnnotation(ref))),
    }
  } catch (error) {
    await Promise.all(copies.map((ref) => removeAnnotation(ref)))
    throw error
  }
}
