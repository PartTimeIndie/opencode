import { expect, test } from "bun:test"
import { annotationScope, validRef } from "./storage"
import { sanitizePromptStore } from "@/context/prompt-persist"
import { isPromptEqual, createPromptState } from "@/context/prompt-session"
import { imageAttachmentPromptFile, imageAttachmentRequestPart } from "../prompt-input/build-request-parts"
import type { PromptAttachmentPart } from "@/context/prompt"
import { reconcileAnnotations } from "./draft-controller"

const part: PromptAttachmentPart = { type: "image", id: "image", filename: "screenshot.png", mime: "image/png", sourcePath: "C:/original.png", dataUrl: "data:image/png;base64,original", annotation: { version: 1, documentID: "document", revision: 1, scope: "test" } }
test("annotated drafts retain only a versioned reference, not original paths or large image data", () => {
  const stored = sanitizePromptStore({ prompt: [part], context: { items: [] } }).prompt[0]
  expect(stored).toEqual({ type: "image", id: "image", filename: "screenshot.png", mime: "image/png", annotation: part.annotation })
  expect(stored).not.toHaveProperty("sourcePath")
  expect(stored).not.toHaveProperty("dataUrl")
})
test("unresolved annotations cannot fall back to the original path in either send dialect", () => {
  expect(() => imageAttachmentPromptFile(part)).toThrow("resolved")
  expect(() => imageAttachmentRequestPart(part)).toThrow("resolved")
})
test("revision identity and cloned references preserve newer edits", () => {
  expect(isPromptEqual([part], [{ ...part, annotation: { ...part.annotation!, revision: 2 } }])).toBe(false)
  const state = createPromptState()
  state.set([part])
  part.annotation!.revision = 3
  expect((state.current()[0] as PromptAttachmentPart).annotation?.revision).toBe(1)
})
test("scope boundaries and malformed references fail closed", () => {
  expect(annotationScope("server", "C:\\Project\\", "chat")).toBe(annotationScope("server", "c:/project", "chat"))
  expect(annotationScope("server", "/project", "chat")).not.toBe(annotationScope("other", "/project", "chat"))
  expect(annotationScope("server", "/project", "chat")).not.toBe(annotationScope("server", "/project", "other"))
  expect(validRef({ ...part.annotation, version: 99 })).toBe(false)
  expect(validRef({ ...part.annotation, revision: NaN })).toBe(false)
  expect(validRef(part.annotation)).toBe(true)
})

test("recovery replaces the original before-marker image and preserves newly typed text and unrelated attachments", () => {
  const restored: PromptAttachmentPart = { ...part, annotation: { ...part.annotation!, revision: 2 }, sourcePath: undefined, dataUrl: "data:image/png;base64,annotated" }
  const original: PromptAttachmentPart = { type: "image", id: part.id, filename: part.filename, mime: part.mime, sourcePath: "C:/original.png" }
  const other: PromptAttachmentPart = { ...original, id: "other" }
  const text = { type: "text" as const, content: "Typed during decoding", start: 0, end: 21 }
  const recovered = reconcileAnnotations([text, original, other], [restored], new Set())
  expect(recovered).toEqual([text, restored, other])
  expect(recovered[1]).not.toHaveProperty("sourcePath", "C:/original.png")
  expect(reconcileAnnotations([text], [restored], new Set())).toEqual([text, restored])
})

test("recovery cannot revive a removed marker or fall back to its original in a concurrent removal", () => {
  const retired = new Set([part.annotation!.documentID])
  const original: PromptAttachmentPart = { type: "image", id: part.id, filename: part.filename, mime: part.mime, sourcePath: "C:/original.png" }
  expect(reconcileAnnotations([part], [part], retired)).toEqual([])
  expect(reconcileAnnotations([original], [part], retired)).toEqual([])
  expect(reconcileAnnotations([], [part], retired)).toEqual([])
})
