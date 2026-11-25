import { validateScene, type AnnotationRef, type Scene } from "./model"
import type { EmojiUsage } from "./emoji-catalog"

export type AnnotationDocument = { ref: AnnotationRef; attachmentID: string; filename: string; original: Blob; png: Blob; scene: Scene }
type Head = { id: string; scope: string; revision: number; active: boolean; owner?: "draft" | "queue"; pins: string[]; counted: string[]; attachmentID: string; filename: string }
const stores = ["heads", "documents", "usage"]

export function annotationScope(server: string, directory: string, session?: string, draft?: string) {
  const path = directory.replace(/\\/g, "/").replace(/\/+$/, "")
  return JSON.stringify([server, /^[a-z]:/i.test(path) ? path.toLowerCase() : path, draft ? `draft:${draft}` : session ?? "workspace"])
}
export function validRef(value: unknown): value is AnnotationRef {
  if (!value || typeof value !== "object") return false
  const ref = value as AnnotationRef
  return ref.version === 1 && typeof ref.documentID === "string" && !!ref.documentID && Number.isSafeInteger(ref.revision) && ref.revision > 0 && typeof ref.scope === "string" && !!ref.scope
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(value.error ?? new Error("Annotation storage request failed"))
  })
}
async function database() {
  if (typeof indexedDB === "undefined") throw new Error("Local annotation storage is unavailable")
  return new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open("opencode.image-annotations", 1)
    let expired = false
    const timer = setTimeout(() => { expired = true; reject(new Error("Annotation database is blocked by another window")) }, 5_000)
    open.onblocked = () => { expired = true; clearTimeout(timer); reject(new Error("Close older annotation windows before saving")) }
    open.onupgradeneeded = () => stores.forEach((name) => { if (!open.result.objectStoreNames.contains(name)) open.result.createObjectStore(name) })
    open.onerror = () => { clearTimeout(timer); reject(open.error) }
    open.onsuccess = () => {
      clearTimeout(timer)
      if (expired) { open.result.close(); return }
      open.result.onversionchange = () => open.result.close()
      resolve(open.result)
    }
  })
}
async function transaction<T>(mode: IDBTransactionMode, run: (tx: IDBTransaction) => Promise<T>) {
  const db = await database()
  const tx = db.transaction(stores, mode)
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error("Annotation storage transaction aborted"))
    tx.onerror = () => reject(tx.error ?? new Error("Annotation storage transaction failed"))
  })
  const result = run(tx).catch((error: unknown) => { tx.abort(); throw error })
  return Promise.all([result, done]).then(([value]) => value).finally(() => db.close())
}
const key = (ref: AnnotationRef) => `${ref.documentID}:${ref.revision}`
async function pruneDocuments(tx: IDBTransaction, head: Head) {
  const retained = new Set(head.pins.map((pin) => `${head.id}:${pin.split(":", 1)[0]}`))
  if (head.active) retained.add(`${head.id}:${head.revision}`)
  const docs = tx.objectStore("documents")
  const keys = await request(docs.getAllKeys(IDBKeyRange.bound(`${head.id}:`, `${head.id}:\uffff`)))
  keys.forEach((id) => { if (!retained.has(String(id))) docs.delete(id) })
}
async function headFor(tx: IDBTransaction, ref: AnnotationRef) {
  if (!validRef(ref)) throw new Error("Invalid annotation reference")
  const head: Head | undefined = await request(tx.objectStore("heads").get(ref.documentID))
  if (!head || head.scope !== ref.scope) throw new Error("Annotation document is missing or belongs to another conversation")
  return head
}
export async function loadAnnotation(ref: AnnotationRef): Promise<AnnotationDocument> {
  return transaction("readonly", async (tx) => {
    const head = await headFor(tx, ref)
    if (!head.active && !head.pins.some((pin) => pin.startsWith(`${ref.revision}:`))) throw new Error("Annotation was removed")
    const document: AnnotationDocument | undefined = await request(tx.objectStore("documents").get(key(ref)))
    if (!document || document.ref.scope !== ref.scope || !(document.original instanceof Blob) || !(document.png instanceof Blob)) throw new Error("Annotation image is missing")
    validateScene(document.scene)
    return document
  })
}
export async function saveAnnotation(input: Omit<AnnotationDocument, "ref"> & { scope: string; previous?: AnnotationRef; owner?: "draft" | "queue"; current?: () => boolean }): Promise<AnnotationRef> {
  validateScene(input.scene)
  if (input.png.type !== "image/png" || !input.png.size || !input.original.size) throw new Error("Annotation export is invalid")
  const id = input.previous?.documentID ?? crypto.randomUUID()
  return transaction("readwrite", async (tx) => {
    const heads = tx.objectStore("heads")
    const previous: Head | undefined = await request(heads.get(id))
    if (input.previous && (!validRef(input.previous) || input.previous.scope !== input.scope || !previous?.active || previous.scope !== input.scope || previous.revision !== input.previous.revision)) throw new Error("This image changed in another window. Your unsaved edits have been kept.")
    const ref: AnnotationRef = { version: 1, documentID: id, scope: input.scope, revision: (previous?.revision ?? 0) + 1 }
    const counted = new Set(previous?.counted ?? (input.owner === "queue" ? input.scene.marks.filter((mark) => mark.kind === "emoji").map((mark) => mark.id) : []))
    const usage: EmojiUsage = await request(tx.objectStore("usage").get("emoji")) ?? {}
    input.scene.marks.filter((mark) => mark.kind === "emoji" && !counted.has(mark.id)).forEach((mark) => {
      usage[mark.text] = { count: (usage[mark.text]?.count ?? 0) + 1, last: Date.now() }
      counted.add(mark.id)
    })
    if (input.current && !input.current()) throw new Error("The image or conversation changed. Your edits have been kept.")
    const head: Head = { id, scope: input.scope, revision: ref.revision, active: true, owner: input.owner ?? "draft", pins: previous?.pins ?? [], counted: [...counted], attachmentID: input.attachmentID, filename: input.filename }
    heads.put(head, id)
    tx.objectStore("documents").put({ ref, original: input.original, png: input.png, scene: structuredClone(input.scene), attachmentID: input.attachmentID, filename: input.filename } satisfies AnnotationDocument, key(ref))
    tx.objectStore("usage").put(usage, "emoji")
    await pruneDocuments(tx, head)
    return ref
  })
}
export async function activeAnnotations(scope: string) {
  return transaction("readonly", async (tx) => {
    const heads: Head[] = await request(tx.objectStore("heads").getAll())
    return heads.filter((head) => head.active && head.owner !== "queue" && head.scope === scope).map((head) => ({ ref: { version: 1 as const, documentID: head.id, revision: head.revision, scope }, attachmentID: head.attachmentID, filename: head.filename }))
  })
}
export async function isAnnotationDraft(ref: AnnotationRef) {
  return transaction("readonly", async (tx) => {
    const head = await headFor(tx, ref)
    return head.active && head.owner !== "queue"
  })
}
export async function emojiUsage(): Promise<EmojiUsage> {
  return transaction("readonly", async (tx) => await request(tx.objectStore("usage").get("emoji")) ?? {})
}
export async function pinAnnotation(ref: AnnotationRef, token: string) {
  return transaction("readwrite", async (tx) => {
    const head = await headFor(tx, ref)
    if (!head.active && !head.pins.some((pin) => pin.startsWith(`${ref.revision}:`))) throw new Error("Annotation was removed")
    if (!(await request(tx.objectStore("documents").get(key(ref))))) throw new Error("Annotation revision is missing")
    tx.objectStore("heads").put({ ...head, pins: [...new Set([...head.pins, `${ref.revision}:${token}`])] }, head.id)
  })
}
export async function releaseAnnotation(ref: AnnotationRef, token?: string, admitted = false) {
  return transaction("readwrite", async (tx) => {
    const head = await headFor(tx, ref)
    const next = { ...head, pins: head.pins.filter((pin) => pin !== `${ref.revision}:${token}`), active: admitted && head.revision === ref.revision ? false : head.active }
    tx.objectStore("heads").put(next, head.id)
    await pruneDocuments(tx, next)
  })
}
export async function restoreQueuedAnnotation(ref: AnnotationRef) {
  return transaction("readwrite", async (tx) => {
    const head = await headFor(tx, ref)
    if (!head.active || head.revision !== ref.revision) throw new Error("Queued annotation is no longer available")
    tx.objectStore("heads").put({ ...head, owner: "draft" }, head.id)
  })
}
export async function removeAnnotation(ref: AnnotationRef) {
  return transaction("readwrite", async (tx) => {
    const head = await headFor(tx, ref)
    if (head.revision !== ref.revision) throw new Error("Image changed in another window")
    tx.objectStore("heads").put({ ...head, active: false }, head.id)
    await pruneDocuments(tx, { ...head, active: false })
  })
}
