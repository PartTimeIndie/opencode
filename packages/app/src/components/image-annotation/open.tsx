import { render } from "solid-js/web"
import { ImageAnnotationEditor, type AnnotationLabels } from "./image-annotation-editor"
import { decodeImage, exportAnnotation } from "./export"
import { loadAnnotation, emojiUsage } from "./storage"
import { commitAnnotation } from "./draft-controller"
import type { PromptAttachmentPart } from "@/context/prompt"

export async function editImage(input: { part: PromptAttachmentPart; scope: string; source: () => Promise<Blob>; labels: AnnotationLabels; apply: (part: PromptAttachmentPart) => void; current: () => boolean }) {
  const document = input.part.annotation ? await loadAnnotation(input.part.annotation) : undefined
  if (document && document.ref.scope !== input.scope) throw new Error("Image belongs to another conversation")
  const original = document?.original ?? await input.source()
  const image = await decodeImage(original)
  const scene = document?.scene ?? { version: 1 as const, width: image.naturalWidth, height: image.naturalHeight, marks: [] }
  const usage = await emojiUsage()
  if (!input.current()) throw new Error("The target conversation changed")
  return new Promise<void>((resolve) => {
    const host = window.document.createElement("div")
    window.document.body.append(host)
    let disposed = false
    const close = () => {
      if (disposed) return
      disposed = true
      queueMicrotask(() => { dispose(); host.remove(); resolve() })
    }
    const dispose = render(() => <ImageAnnotationEditor scene={scene} original={original} usage={usage} labels={input.labels} onClose={close} onSave={async (next) => {
      if (!input.current()) throw new Error("The image or conversation changed. Your edits have been kept.")
      const png = await exportAnnotation(original, next)
      if (!input.current()) throw new Error("The image or conversation changed. Your edits have been kept.")
      const part = await commitAnnotation({ scope: input.scope, part: input.part, original, scene: next, png, current: input.current })
      if (!input.current()) throw new Error("The target conversation changed. The saved image remains in its original draft.")
      input.apply(part)
      close()
    }} />, host)
  })
}
