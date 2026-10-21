import { onMount } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { showToast } from "@/utils/toast"
import { type ContentPart, type PromptAttachmentPart, type usePrompt } from "@/context/prompt"
import { useLanguage } from "@/context/language"
import { uuid } from "@/utils/uuid"
import { getCursorPositionOrNull } from "./editor-dom"
import { attachmentMime, sameClipboardFile, uniqueClipboardFiles } from "./files"
import { promptLength } from "./history"
import { normalizePaste, pasteMode } from "./paste"

const duplicatePasteWindow = 100

function dataUrl(file: File, mime: string) {
  return new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.addEventListener("error", () => resolve(""))
    reader.addEventListener("load", () => {
      const value = typeof reader.result === "string" ? reader.result : ""
      const idx = value.indexOf(",")
      if (idx === -1) {
        resolve(value)
        return
      }
      resolve(`data:${mime};base64,${value.slice(idx + 1)}`)
    })
    reader.readAsDataURL(file)
  })
}

type PromptAttachmentsInput = {
  prompt: ReturnType<typeof usePrompt>
  editor: () => HTMLDivElement | undefined
  isDialogActive: () => boolean
  setDraggingType: (type: "image" | "@mention" | null) => void
  focusEditor: () => void
  addPart: (part: ContentPart) => boolean
  readClipboardImage?: (options?: { includeBuffer?: boolean }) => Promise<File | null>
  getPathForFile?: (file: File) => string
}

export function createPromptAttachments(input: PromptAttachmentsInput) {
  const prompt = input.prompt
  const language = useLanguage()
  let pasteGeneration = 0
  let pendingAttachmentPaste: { files: File[]; promise: Promise<void>; generation: number } | undefined
  let recentAttachmentPastes: { files: File[]; time: number }[] = []

  const warn = () => {
    showToast({
      title: language.t("prompt.toast.pasteUnsupported.title"),
      description: language.t("prompt.toast.pasteUnsupported.description"),
    })
  }

  const add = async (file: File, toast = true) => {
    const mime = await attachmentMime(file)
    if (!mime) {
      if (toast) warn()
      return false
    }

    const editor = input.editor()

    const sourcePath = input.getPathForFile?.(file) || undefined
    const url = sourcePath ? undefined : await dataUrl(file, mime)
    if (!sourcePath && !url) return false
    if (
      sourcePath
        ? prompt.current().some((part) => part.type === "image" && part.sourcePath === sourcePath)
        : prompt.current().some((part) => part.type === "image" && part.dataUrl === url)
    )
      return true

    const attachment: PromptAttachmentPart = {
      type: "image",
      id: uuid(),
      filename: file.name,
      sourcePath,
      mime,
      ...(url ? { dataUrl: url } : {}),
    }
    const cursor = prompt.cursor() ?? (editor ? getCursorPositionOrNull(editor) : undefined) ?? promptLength(prompt.current())
    prompt.set([...prompt.current(), attachment], cursor)
    return true
  }

  const addAttachment = (file: File) => add(file)

  const addAttachments = async (files: File[], toast = true) => {
    let found = false

    for (const file of files) {
      const ok = await add(file, false)
      if (ok) found = true
    }

    if (!found && files.length > 0 && toast) warn()
    return found
  }

  const sameAttachmentPaste = async (first: File[], second: File[]) => {
    if (first.length !== second.length) return false
    return (
      await Promise.all(
        first.map((file, index) => {
          const other = second[index]
          if (!other) return false
          const sourcePath = input.getPathForFile?.(file)
          const otherSourcePath = input.getPathForFile?.(other)
          if (sourcePath || otherSourcePath) return sourcePath === otherSourcePath
          return sameClipboardFile(file, other)
        }),
      )
    ).every(Boolean)
  }

  const runAttachmentPaste = async (files: File[], task: () => Promise<unknown>) => {
    const generation = pasteGeneration
    const pending = pendingAttachmentPaste
    if (pending) {
      if (await sameAttachmentPaste(files, pending.files) && pending.generation === generation) return pending.promise
      await pending.promise
      return runAttachmentPaste(files, task)
    }

    const now = Date.now()
    const recent = recentAttachmentPastes.filter((item) => now - item.time < duplicatePasteWindow)
    recentAttachmentPastes = recent
    if ((await Promise.all(recent.map((item) => sameAttachmentPaste(files, item.files)))).some(Boolean)) return

    const active = pendingAttachmentPaste
    if (active || recentAttachmentPastes !== recent) return runAttachmentPaste(files, task)

    const current = task().then(() => undefined)
    pendingAttachmentPaste = { files, promise: current, generation }
    try {
      await current
      if (generation !== pasteGeneration) return
      const time = Date.now()
      recentAttachmentPastes = [
        ...recentAttachmentPastes.filter((item) => time - item.time < duplicatePasteWindow),
        { files, time },
      ]
    } finally {
      if (pendingAttachmentPaste?.promise === current) pendingAttachmentPaste = undefined
    }
  }

  const removeAttachment = (id: string) => {
    const current = prompt.current()
    const next = current.filter((part) => part.type !== "image" || part.id !== id)
    // An explicit removal is a new user intent; do not let the short duplicate-paste
    // window block the same clipboard image from being added again immediately.
    pasteGeneration += 1
    recentAttachmentPastes = []
    prompt.set(next, prompt.cursor())
  }

  const handlePaste = async (event: ClipboardEvent) => {
    const clipboardData = event.clipboardData
    if (!clipboardData) return

    event.preventDefault()
    event.stopPropagation()

    const files = await uniqueClipboardFiles(
      Array.from(clipboardData.items).flatMap((item) => {
        if (item.kind !== "file") return []
        const file = item.getAsFile()
        return file ? [file] : []
      }),
    )

    if (files.length > 0) {
      await runAttachmentPaste(files, () => addAttachments(files))
      return
    }

    const plainText = clipboardData.getData("text/plain") ?? ""

    // Desktop: Browser clipboard has no images and no text, try platform's native clipboard for images
    if (input.readClipboardImage && !plainText) {
      const file = await input.readClipboardImage({ includeBuffer: false })
      if (file) await runAttachmentPaste([file], () => addAttachment(file))
      return
    }

    if (!plainText) return

    const text = normalizePaste(plainText)

    const put = () => {
      if (input.addPart({ type: "text", content: text, start: 0, end: 0 })) return true
      input.focusEditor()
      return input.addPart({ type: "text", content: text, start: 0, end: 0 })
    }

    if (pasteMode(text) === "manual") {
      put()
      return
    }

    const inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, text)
    if (inserted) return

    put()
  }

  const handleGlobalDragOver = (event: DragEvent) => {
    if (input.isDialogActive()) return

    event.preventDefault()
    const hasFiles = event.dataTransfer?.types.includes("Files")
    const hasText = event.dataTransfer?.types.includes("text/plain")
    if (hasFiles) {
      input.setDraggingType("image")
    } else if (hasText) {
      input.setDraggingType("@mention")
    }
  }

  const handleGlobalDragLeave = (event: DragEvent) => {
    if (input.isDialogActive()) return
    if (!event.relatedTarget) {
      input.setDraggingType(null)
    }
  }

  const handleGlobalDrop = async (event: DragEvent) => {
    if (input.isDialogActive()) return

    event.preventDefault()
    input.setDraggingType(null)

    const plainText = event.dataTransfer?.getData("text/plain")
    const filePrefix = "file:"
    if (plainText?.startsWith(filePrefix)) {
      const filePath = plainText.slice(filePrefix.length)
      input.focusEditor()
      input.addPart({ type: "file", path: filePath, content: "@" + filePath, start: 0, end: 0 })
      return
    }

    const dropped = event.dataTransfer?.files
    if (!dropped) return

    await addAttachments(Array.from(dropped))
  }

  onMount(() => {
    makeEventListener(document, "dragover", handleGlobalDragOver)
    makeEventListener(document, "dragleave", handleGlobalDragLeave)
    makeEventListener(document, "drop", handleGlobalDrop)
  })

  return {
    addAttachment,
    addAttachments,
    removeAttachment,
    handlePaste,
  }
}
