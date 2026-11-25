import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { fixture } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer, type MockServerConfig } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"
import { expectNoSmokeErrors, trackPageErrors, trackNetworkFailures } from "../utils/errors"

// Keep the browser module boundary local: importing app types pulls Solid's entire
// application into the isolated composite E2E TypeScript project.
type Ref = { version: 1; documentID: string; scope: string; revision: number }
type BrowserMark = { id: string; kind: "line" | "emoji" | "text"; start: { x: number; y: number }; end: { x: number; y: number }; points: { x: number; y: number }[]; color: string; width: number; size: number; text: string }
type BrowserScene = { version: 1; width: number; height: number; marks: BrowserMark[] }
type BrowserPart = { type: "image"; id: string; filename: string; mime: string; annotation?: Ref; dataUrl?: string; sourcePath?: string }
type StoredImage = { ref: Ref; png: Blob; scene: BrowserScene }
type SaveInput = { scope: string; attachmentID: string; filename: string; original: Blob; png: Blob; scene: BrowserScene; previous?: Ref; current?: () => boolean }
type StorageModule = {
  annotationScope(server: string, directory: string, session: string): string
  saveAnnotation(input: SaveInput): Promise<Ref>
  loadAnnotation(ref: Ref): Promise<StoredImage>
  activeAnnotations(scope: string): Promise<{ ref: Ref }[]>
  pinAnnotation(ref: Ref, token: string): Promise<void>
  removeAnnotation(ref: Ref): Promise<void>
  releaseAnnotation(ref: Ref, token?: string, admitted?: boolean): Promise<void>
  restoreQueuedAnnotation(ref: Ref): Promise<void>
  emojiUsage(): Promise<Record<string, { count: number; last: number }>>
}
type ResolverModule = {
  resolveAnnotationPart(part: { type: "image"; id: string; filename: string; mime: string; sourcePath: string; annotation: Ref }): Promise<{ dataUrl?: string }>
}

const directory = "C:/OpenCode/ImageAnnotation"
const sessionID = "ses_image_annotation"
const route = `/${base64Encode(directory)}/session/${sessionID}`
const sent: unknown[] = []

async function setup(page: Page, options: Partial<MockServerConfig> = {}) {
  await mockOpenCodeServer(page, {
    directory,
    project: { id: "proj_image_annotation", worktree: directory, vcs: "git", name: "image-annotation", time: { created: 1, updated: 1 }, sandboxes: [] },
    provider: fixture.provider,
    agents: [{ name: "build", mode: "primary" }],
    sessions: [{ id: sessionID, slug: sessionID, projectID: "proj_image_annotation", directory, title: "Image annotation", version: "dev", time: { created: 1, updated: 1 } }],
    pageMessages: () => ({ items: [] }),
    onSessionPrompt: (input) => { sent.push(input); return { data: { sessionID: input.sessionID, messageID: "msg_annotation", admittedSeq: 1 } } },
    ...options,
  })
  await page.addInitScript(({ directory, dirBase64, sessionID }) => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
    localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
    localStorage.setItem("opencode.global.dat:tabs", JSON.stringify([{ type: "session", server: "http://127.0.0.1:4096", dirBase64, sessionId: sessionID }]))
  }, { directory, dirBase64: base64Encode(directory), sessionID })
  await page.goto(route)
  await expectAppVisible(page.locator('[data-component="session-composer"] [data-component="prompt-input"]'))
}
async function paste(page: Page) {
  await page.locator('[data-component="session-composer"] [data-component="prompt-input"]').evaluate(async (element) => {
    const canvas = document.createElement("canvas")
    canvas.width = 640; canvas.height = 400
    const context = canvas.getContext("2d")!
    context.fillStyle = "#ffffff"; context.fillRect(0, 0, 640, 400)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"))
    const transfer = new DataTransfer()
    transfer.items.add(new File([blob], "screenshot.png", { type: "image/png" }))
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }))
  })
  await expect(page.locator('[data-component="session-composer"] img[alt="screenshot.png"]')).toHaveCount(1)
}
async function draw(page: Page, tool: string, start: [number, number], end: [number, number]) {
  const editor = page.locator('[data-component="image-annotation-editor"]')
  await editor.locator(`[data-tool="${tool}"]`).click()
  const bounds = await editor.locator('[data-slot="annotation-canvas"]').boundingBox()
  if (!bounds) throw new Error("Missing annotation canvas")
  await page.mouse.move(bounds.x + start[0] * bounds.width, bounds.y + start[1] * bounds.height)
  await page.mouse.down()
  await page.mouse.move(bounds.x + end[0] * bounds.width, bounds.y + end[1] * bounds.height, { steps: 8 })
  await page.mouse.up()
}

test.use({ video: "on", screenshot: "on" })
test("annotates every tool, restores a draft, and sends only a PNG", async ({ page }, testInfo) => {
  sent.length = 0
  const errors = trackPageErrors(page)
  const network = trackNetworkFailures(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await setup(page)
  await paste(page)
  await page.locator('img[alt="screenshot.png"]').click()
  const editor = page.locator('[data-component="image-annotation-editor"]')
  await expect(editor).toBeVisible()
  await draw(page, "arrow", [0.8, 0.6], [0.2, 0.3])
  await expect(editor.locator('[data-mark]')).toHaveCount(1)
  const arrow = await editor.locator('[data-mark] path').last().getAttribute("d")
  const ends = arrow!.match(/^M([^,]+),([^ ]+) L([^,]+),([^ ]+)/)!
  expect(Number(ends[3])).toBeLessThan(Number(ends[1]))
  expect(Number(ends[4])).toBeLessThan(Number(ends[2]))
  await editor.locator('[data-tool="select"]').click()
  const handle = editor.locator('[data-handle="rotate"]')
  const box = await handle.boundingBox()
  if (!box) throw new Error("Missing rotation handle")
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + 60, box.y + 30, { steps: 6 }); await page.mouse.up()
  expect(await editor.locator('[data-mark] path').last().getAttribute("d")).not.toBe(arrow)
  await editor.getByLabel("Color", { exact: true }).fill("#00ff00")
  await expect(editor.locator('[data-mark] path').last()).toHaveAttribute("stroke", "#00ff00")
  await editor.getByRole("button", { name: "Zoom in", exact: true }).click()
  await editor.getByRole("button", { name: "Fit image", exact: true }).click()
  for (const tool of ["freehand", "line", "rectangle", "ellipse"]) await draw(page, tool, [0.15, 0.65], [0.35, 0.8])
  await editor.locator('[data-tool="text"]').click()
  await editor.getByRole("textbox", { name: "Text", exact: true }).fill("Note\nSecond line")
  const surface = editor.locator('[data-slot="annotation-canvas"]')
  await surface.click({ position: { x: 50, y: 40 } })
  await editor.locator('[data-tool="emoji"]').click()
  await editor.getByPlaceholder("Search emojis").fill("warning")
  await editor.getByRole("button", { name: "Warnung / warning", exact: true }).click()
  await surface.click({ position: { x: 120, y: 60 } })
  await expect(editor.locator('[data-mark]')).toHaveCount(7)
  await page.screenshot({ path: testInfo.outputPath("editor-desktop.png") })
  await editor.locator('[data-action="apply-annotation"]').click()
  await expect(editor).toHaveCount(0)
  await page.reload()
  await expectAppVisible(page.locator('[data-component="session-composer"] [data-component="prompt-input"]'))
  await page.locator('img[alt="screenshot.png"]').click()
  await expect(editor.locator('[data-mark]')).toHaveCount(7)
  await editor.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.locator('[data-component="session-composer"] [data-component="prompt-input"]').fill("Review this annotated image")
  await page.locator('[data-component="session-composer"] [data-action="prompt-submit"]').click()
  await expect.poll(() => sent.length).toBe(1)
  const body = JSON.stringify(sent[0])
  expect(body).toContain("data:image/png;base64,")
  expect(body).not.toContain('"annotation":') // No local document marker.
  expect(body).not.toContain("file://")
  expectNoSmokeErrors(errors, await page.locator('[data-component="toast"][data-variant="error"]').allTextContents(), [])
  // An aborted event-stream reconnect is the normal teardown after page.close(),
  // not an annotation failure; everything else must be clean.
  expect(network.filter((entry) => !entry.includes("net::ERR_ABORTED"))).toEqual([])
})

test("uses real IndexedDB CAS, pins, tombstones, quota rollback and PNG materialization", async ({ page }) => {
  await setup(page)
  const result = await page.evaluate(async () => {
    const url = "/src/components/image-annotation/storage.ts"
    const storage: StorageModule = await import(url)
    const resolverUrl = "/src/components/image-annotation/resolve.ts"
    const resolver: ResolverModule = await import(resolverUrl)
    const canvas = document.createElement("canvas"); canvas.width = 400; canvas.height = 300
    const context = canvas.getContext("2d")!
    const pixels = context.createImageData(400, 300)
    for (let offset = 0; offset < pixels.data.length; offset += 65536) crypto.getRandomValues(pixels.data.subarray(offset, Math.min(offset + 65536, pixels.data.length)))
    context.putImageData(pixels, 0, 0)
    const png = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"))
    const scope = storage.annotationScope("test-server", "/project", "test-chat")
    const input = { scope, attachmentID: "test-image", filename: "test.png", original: png, png, scene: { version: 1 as const, width: 400, height: 300, marks: [] } }
    const first = await storage.saveAnnotation(input)
    const competing = await Promise.allSettled([storage.saveAnnotation({ ...input, previous: first }), storage.saveAnnotation({ ...input, previous: first })])
    const second = competing.find((value): value is PromiseFulfilledResult<typeof first> => value.status === "fulfilled")!.value
    const wrongScope = await storage.loadAnnotation({ ...second, scope: "other" }).then(() => false, () => true)
    const plain = await resolver.resolveAnnotationPart({ type: "image", id: "test-image", filename: "test.png", mime: "image/png", sourcePath: "C:/original.png", annotation: second })
    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) { if (this.name === "usage") throw new DOMException("Full", "QuotaExceededError"); return originalPut.apply(this, args) }
    const quota = await storage.saveAnnotation({ ...input, previous: second }).then(() => false, () => true)
    IDBObjectStore.prototype.put = originalPut
    const afterQuota = (await storage.activeAnnotations(scope))[0].ref.revision
    await storage.pinAnnotation(second, "in-flight")
    await storage.removeAnnotation(second)
    const pinned = await storage.loadAnnotation(second)
    await storage.releaseAnnotation(second, "in-flight")
    const removed = await storage.loadAnnotation(second).then(() => false, () => true)
    return { size: png.size, fulfilled: competing.filter((value) => value.status === "fulfilled").length, rejected: competing.filter((value) => value.status === "rejected").length, wrongScope, plain, quota, afterQuota, second: second.revision, pinned: pinned.png.size, removed, active: (await storage.activeAnnotations(scope)).length }
  })
  expect(result.size).toBeGreaterThan(256 * 1024)
  expect(result.fulfilled).toBe(1); expect(result.rejected).toBe(1)
  expect(result.wrongScope).toBe(true); expect(result.quota).toBe(true)
  expect(result.afterQuota).toBe(result.second)
  expect(result.plain).not.toHaveProperty("sourcePath"); expect(result.plain).not.toHaveProperty("annotation")
  expect(result.plain.dataUrl).toMatch(/^data:image\/png;base64,/)
  expect(result.pinned).toBe(result.size); expect(result.removed).toBe(true); expect(result.active).toBe(0)
})

test("touch layout keeps tools and confirmation reachable and cancels without changes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await setup(page); await paste(page)
  await page.locator('img[alt="screenshot.png"]').click()
  const editor = page.locator('[data-component="image-annotation-editor"]')
  await expect(editor).toBeVisible()
  await editor.locator('[data-tool="arrow"]').click()
  const bounds = await editor.locator('[data-slot="annotation-canvas"]').boundingBox()
  if (!bounds) throw new Error("Missing touch canvas")
  const touch = await page.context().newCDPSession(page)
  await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true })
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height * 0.8 }] })
  await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height * 0.2 }] })
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  await expect(editor.locator('[data-mark]')).toHaveCount(1)
  await touch.detach()
  await editor.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(editor.getByRole("alertdialog")).toBeVisible()
  await editor.getByRole("button", { name: "Keep editing", exact: true }).click()
  await expect(editor.locator('[data-action="apply-annotation"]')).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath("editor-mobile.png") })
  await editor.getByRole("button", { name: "Cancel", exact: true }).click()
  await editor.getByRole("button", { name: "Discard changes", exact: true }).click()
  await expect(editor).toHaveCount(0)
  await page.locator('img[alt="screenshot.png"]').click()
  await expect(editor.locator('[data-mark]')).toHaveCount(0)
})

test("recovers the DB-before-marker crash window, counts emoji once, and never revives tombstones or queued snapshots", async ({ page }) => {
  await setup(page)
  const result = await page.evaluate(async () => {
    const storageUrl = "/src/components/image-annotation/storage.ts"
    const storage: StorageModule = await import(storageUrl)
    const draftUrl = "/src/components/image-annotation/draft-controller.ts"
    const drafts: { restoreAnnotations(scope: string, current: () => BrowserPart[], set: (prompt: BrowserPart[]) => void): Promise<void> } = await import(draftUrl)
    const queueUrl = "/src/components/image-annotation/queue.ts"
    const queue: { snapshotAnnotationQueue(prompt: BrowserPart[]): Promise<{ prompt: BrowserPart[]; commit(): Promise<unknown>; rollback(): Promise<unknown> }> } = await import(queueUrl)
    const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 24
    const png = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"))
    const scope = storage.annotationScope("crash-server", "/project", "chat")
    const mark: BrowserMark = { id: "once", kind: "emoji", start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, points: [], color: "#ff0000", width: 4, size: 12, text: "✅" }
    const input: SaveInput = { scope, attachmentID: "crash-image", filename: "crash.png", original: png, png, scene: { version: 1, width: 32, height: 24, marks: [mark] } }
    const before = (await storage.emojiUsage())[mark.text]?.count ?? 0
    const first = await storage.saveAnnotation(input)
    const second = await storage.saveAnnotation({ ...input, previous: first })
    // The ordinary attachment still exists because the process died before
    // replacing it with its committed IndexedDB reference.
    let prompt: BrowserPart[] = [{ type: "image", id: input.attachmentID, filename: input.filename, mime: "image/png", dataUrl: "data:original" }]
    await drafts.restoreAnnotations(scope, () => prompt, (next) => { prompt = next })
    const recovered = prompt[0].annotation?.revision
    const snapshot = await queue.snapshotAnnotationQueue(prompt)
    await snapshot.commit()
    const queued = snapshot.prompt[0]
    const queuedLoad = await storage.loadAnnotation(queued.annotation!)
    await drafts.restoreAnnotations(scope, () => prompt, (next) => { prompt = next })
    const noRevival = prompt.length === 0 && (await storage.activeAnnotations(scope)).length === 0
    const count = (await storage.emojiUsage())[mark.text].count - before
    await storage.restoreQueuedAnnotation(queued.annotation!)
    const editing = (await storage.activeAnnotations(scope)).length
    await storage.releaseAnnotation(queued.annotation!, undefined, true)
    prompt = [queued] // Simulate a stale persisted prompt after successful admission.
    await drafts.restoreAnnotations(scope, () => prompt, (next) => { prompt = next })
    const sentGone = prompt.length === 0
    const denied = await storage.saveAnnotation({ ...input, current: () => false }).then(() => false, () => true)
    return { recovered, second: second.revision, queuedDocument: queued.annotation!.documentID !== second.documentID, queuedBytes: queuedLoad.png.size, inline: queued.dataUrl, noRevival, count, editing, sentGone, denied, active: (await storage.activeAnnotations(scope)).length }
  })
  expect(result.recovered).toBe(result.second)
  expect(result.queuedDocument).toBe(true)
  expect(result.queuedBytes).toBeGreaterThan(0)
  expect(result.inline).toBeUndefined()
  expect(result.noRevival).toBe(true)
  expect(result.count).toBe(1)
  expect(result.editing).toBe(1)
  expect(result.sentGone).toBe(true)
  expect(result.denied).toBe(true)
  expect(result.active).toBe(0)
})

test("exports original-resolution PNG pixels without handles and reuses identical text and emoji tiles", async ({ page }) => {
  await setup(page)
  const result = await page.evaluate(async () => {
    const exportUrl = "/src/components/image-annotation/export.ts"
    const exporter: { exportAnnotation(original: Blob, scene: BrowserScene): Promise<Blob>; decodeImage(blob: Blob): Promise<HTMLImageElement> } = await import(exportUrl)
    const renderUrl = "/src/components/image-annotation/render.ts"
    const renderer: { textTile(mark: BrowserMark): { canvas: HTMLCanvasElement } } = await import(renderUrl)
    const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 240
    const context = canvas.getContext("2d")!
    context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height)
    const original = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"))
    const base: BrowserMark = { id: "line", kind: "line", start: { x: 20, y: 20 }, end: { x: 180, y: 20 }, points: [], width: 6, color: "#ff0000", size: 24, text: "" }
    const text: BrowserMark = { ...base, id: "text", kind: "text", start: { x: 20, y: 70 }, text: "Plain <b>text</b>\nSecond line" }
    const emoji: BrowserMark = { ...base, id: "emoji", kind: "emoji", start: { x: 220, y: 140 }, text: "✅", size: 40 }
    const scene: BrowserScene = { version: 1, width: 320, height: 240, marks: [base, text, emoji] }
    const png = await exporter.exportAnnotation(original, scene)
    const image = await exporter.decodeImage(png)
    context.drawImage(image, 0, 0)
    const pixel = (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data]
    const parity = (mark: BrowserMark) => {
      const tile = renderer.textTile(mark).canvas
      const expected = document.createElement("canvas"); expected.width = tile.width; expected.height = tile.height
      const ctx = expected.getContext("2d")!; ctx.fillStyle = "white"; ctx.fillRect(0, 0, tile.width, tile.height); ctx.drawImage(tile, 0, 0)
      const left = ctx.getImageData(0, 0, tile.width, tile.height).data
      const right = context.getImageData(mark.start.x, mark.start.y, tile.width, tile.height).data
      return left.every((value, index) => value === right[index])
    }
    const mismatch = await exporter.exportAnnotation(original, { ...scene, width: 160 }).then(() => false, () => true)
    return { width: image.naturalWidth, height: image.naturalHeight, type: png.type, red: pixel(80, 20), white: pixel(300, 20), text: parity(text), emoji: parity(emoji), untinted: renderer.textTile(emoji).canvas === renderer.textTile({ ...emoji, color: "#00ff00" }).canvas, mismatch }
  })
  expect(result).toEqual({ width: 320, height: 240, type: "image/png", red: [255, 0, 0, 255], white: [255, 255, 255, 255], text: true, emoji: true, untinted: true, mismatch: true })
})

test("retains a captured revision across windows while a newer revision is saved or the draft is removed", async ({ page, context }) => {
  await setup(page)
  const ref = await page.evaluate(async () => {
    const url = "/src/components/image-annotation/storage.ts"
    const storage: StorageModule = await import(url)
    const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 48
    const png = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"))
    const ref = await storage.saveAnnotation({ scope: storage.annotationScope("server", "/project", "two-windows"), attachmentID: "shared", filename: "shared.png", original: png, png, scene: { version: 1, width: 64, height: 48, marks: [] } })
    await storage.pinAnnotation(ref, "captured")
    return ref
  })
  const other = await context.newPage()
  await setup(other)
  const newer = await other.evaluate(async (ref) => {
    const url = "/src/components/image-annotation/storage.ts"
    const storage: StorageModule = await import(url)
    const doc = await storage.loadAnnotation(ref)
    return storage.saveAnnotation({ ...doc, original: doc.png, filename: "shared.png", attachmentID: "shared", scope: ref.scope, previous: ref })
  }, ref)
  const result = await page.evaluate(async ({ ref, newer }) => {
    const url = "/src/components/image-annotation/storage.ts"
    const storage: StorageModule = await import(url)
    const resolverUrl = "/src/components/image-annotation/resolve.ts"
    const resolver: { acquireAnnotationSend(prompt: BrowserPart[]): Promise<{ prompt: BrowserPart[]; release(admitted?: boolean): Promise<void> }> } = await import(resolverUrl)
    const first = await storage.loadAnnotation(ref)
    const stale = await storage.saveAnnotation({ ...first, original: first.png, filename: "shared.png", attachmentID: "shared", scope: ref.scope, previous: ref }).then(() => false, () => true)
    // An older send's receipt cannot delete a newer draft.
    await storage.releaseAnnotation(ref, "captured", true)
    const active = (await storage.activeAnnotations(ref.scope))[0].ref.revision
    await storage.pinAnnotation(newer, "prepared")
    await storage.removeAnnotation(newer)
    const send = await resolver.acquireAnnotationSend([{ type: "image", id: "shared", filename: "shared.png", mime: "image/png", annotation: newer }])
    await send.release(false)
    const retained = (await storage.loadAnnotation(newer)).png.size
    await storage.releaseAnnotation(newer, "prepared")
    const deleted = await storage.loadAnnotation(newer).then(() => false, () => true)
    return { stale, active, retained, deleted, resolved: send.prompt[0].dataUrl?.startsWith("data:image/png;base64,"), local: send.prompt[0].annotation }
  }, { ref, newer })
  expect(result.stale).toBe(true)
  expect(result.active).toBe(newer.revision)
  expect(result.retained).toBeGreaterThan(0)
  expect(result.deleted).toBe(true)
  expect(result.resolved).toBe(true)
  expect(result.local).toBeUndefined()
  await other.close()
})

test("pointer cancellation, endpoint moves, undo, redo and delete stay atomic at zoom", async ({ page }) => {
  await setup(page); await paste(page)
  await page.locator('img[alt="screenshot.png"]').click()
  const editor = page.locator('[data-component="image-annotation-editor"]')
  await draw(page, "arrow", [0.2, 0.2], [0.6, 0.5])
  await editor.getByRole("button", { name: "Undo", exact: true }).click()
  await expect(editor.locator('[data-mark]')).toHaveCount(0)
  await editor.getByRole("button", { name: "Redo", exact: true }).click()
  await editor.locator('[data-tool="select"]').click()
  const before = await editor.locator('[data-mark] path').last().getAttribute("d")
  const end = await editor.locator('[data-handle="end"]').boundingBox()
  if (!end) throw new Error("Missing endpoint")
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2); await page.mouse.down(); await page.mouse.move(end.x + 45, end.y + 25); await page.mouse.up()
  expect(await editor.locator('[data-mark] path').last().getAttribute("d")).not.toBe(before)
  await editor.getByRole("button", { name: "Zoom in", exact: true }).click()
  await editor.locator('[data-tool="line"]').click()
  const surface = editor.locator('[data-slot="annotation-canvas"]')
  const bounds = await surface.boundingBox()
  if (!bounds) throw new Error("Missing canvas")
  await page.mouse.move(bounds.x + 30, bounds.y + 30); await page.mouse.down(); await page.mouse.move(bounds.x + 90, bounds.y + 90)
  await surface.evaluate((svg) => svg.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, bubbles: true })))
  await page.mouse.up()
  await expect(editor.locator('[data-mark]')).toHaveCount(1)
  await editor.locator('[data-tool="select"]').click()
  const stem = (await editor.locator('[data-mark] path').last().getAttribute("d"))!.match(/^M([^,]+),([^ ]+) L([^,]+),([^ ]+)/)!
  const zoomed = await surface.boundingBox()
  if (!zoomed) throw new Error("Missing zoomed canvas")
  await page.mouse.click(zoomed.x + (Number(stem[1]) + Number(stem[3])) / 2 * zoomed.width / 640, zoomed.y + (Number(stem[2]) + Number(stem[4])) / 2 * zoomed.height / 400)
  await editor.getByRole("button", { name: "Delete", exact: true }).click()
  await expect(editor.locator('[data-mark]')).toHaveCount(0)
  await editor.getByRole("button", { name: "Undo", exact: true }).click()
  await expect(editor.locator('[data-mark]')).toHaveCount(1)
})

test("a rejected send retains the editable draft and retries the same annotated PNG", async ({ page }) => {
  sent.length = 0
  await setup(page); await paste(page)
  await page.locator('img[alt="screenshot.png"]').click()
  const editor = page.locator('[data-component="image-annotation-editor"]')
  await draw(page, "rectangle", [0.2, 0.2], [0.8, 0.8])
  await editor.locator('[data-action="apply-annotation"]').click()
  await expect(editor).toHaveCount(0)
  let rejected: unknown
  const endpoint = new RegExp(`/api/session/${sessionID}/prompt(?:\\?|$)`)
  await page.route(endpoint, async (route) => {
    rejected = route.request().postDataJSON()
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ name: "BadRequestError", data: { message: "Fixture rejects the first send" } }) })
  })
  const composer = page.locator('[data-component="session-composer"]')
  const input = composer.locator('[data-component="prompt-input"]')
  await input.fill("Retry annotated image")
  await composer.locator('[data-action="prompt-submit"]').click()
  await expect(input).toContainText("Retry annotated image")
  await expect(composer.locator('img[alt="screenshot.png"]')).toHaveCount(1)
  await expect.poll(() => !!rejected).toBe(true)
  await page.unroute(endpoint)
  await composer.locator('[data-action="prompt-submit"]').click()
  await expect.poll(() => sent.length).toBe(1)
  // A definite 400 rejection can get a new admission ID. The annotation bytes,
  // model and visible prompt must remain identical (no original-image fallback).
  const retried = (sent[0] as { body: { prompt: unknown; model: unknown; agent: string } }).body
  const failed = rejected as typeof retried
  expect(retried.prompt).toEqual(failed.prompt)
  expect(retried.model).toEqual(failed.model)
  expect(retried.agent).toBe(failed.agent)
  await page.reload()
  await expectAppVisible(input)
  await expect(composer.locator('img[alt="screenshot.png"]')).toHaveCount(0)
})

test("slash commands materialize only the final PNG and retire their local draft", async ({ page }) => {
  const commands: unknown[] = []
  await setup(page, {
    commands: [{ name: "annotate", description: "Fixture command", template: "Review $ARGUMENTS", source: "command" }],
    onSessionCommand: (input) => { commands.push(input); return { data: { sessionID: input.sessionID, messageID: "msg_command", admittedSeq: 1 } } },
  })
  await paste(page)
  await page.locator('img[alt="screenshot.png"]').click()
  await draw(page, "line", [0.1, 0.1], [0.9, 0.9])
  await page.locator('[data-action="apply-annotation"]').click()
  await expect(page.locator('[data-component="image-annotation-editor"]')).toHaveCount(0)
  const composer = page.locator('[data-component="session-composer"]')
  await composer.locator('[data-component="prompt-input"]').fill("/annotate check")
  await composer.locator('[data-action="prompt-submit"]').click()
  await expect.poll(() => commands.length).toBe(1)
  const command = commands[0] as { body: { files: { uri: string }[] } }
  expect(command.body.files).toHaveLength(1)
  expect(command.body.files[0].uri).toMatch(/^data:image\/png;base64,/)
  expect(JSON.stringify(command)).not.toContain('"annotation":')
  await page.reload()
  await expectAppVisible(composer.locator('[data-component="prompt-input"]'))
  await expect(composer.locator('img[alt="screenshot.png"]')).toHaveCount(0)
})

test("export and storage failures keep edits and never replace the composer attachment with a partial result", async ({ page }) => {
  await setup(page); await paste(page)
  const image = page.locator('[data-component="session-composer"] img[alt="screenshot.png"]')
  const original = await image.getAttribute("src")
  await image.click()
  const editor = page.locator('[data-component="image-annotation-editor"]')
  await draw(page, "ellipse", [0.2, 0.2], [0.8, 0.8])
  const restoreExport = await page.evaluateHandle(() => {
    const original = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (callback) { callback(null) }
    return () => { HTMLCanvasElement.prototype.toBlob = original }
  })
  await editor.locator('[data-action="apply-annotation"]').click()
  await expect(editor.getByRole("alert")).toContainText("PNG export failed")
  await expect(editor.locator('[data-mark]')).toHaveCount(1)
  await expect(image).toHaveAttribute("src", original!)
  await restoreExport.evaluate((restore) => restore())
  await restoreExport.dispose()
  const restoreStorage = await page.evaluateHandle(() => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "documents") throw new DOMException("Fixture quota exhausted", "QuotaExceededError")
      return original.apply(this, args)
    }
    return () => { IDBObjectStore.prototype.put = original }
  })
  await editor.locator('[data-action="apply-annotation"]').click()
  await expect(editor.getByRole("alert")).toContainText("quota exhausted")
  await expect(editor.locator('[data-mark]')).toHaveCount(1)
  await expect(image).toHaveAttribute("src", original!)
  await restoreStorage.evaluate((restore) => restore())
  await restoreStorage.dispose()
  await editor.locator('[data-action="apply-annotation"]').click()
  await expect(editor).toHaveCount(0)
  await expect(image).not.toHaveAttribute("src", original!)
  await image.click()
  await expect(editor.locator('[data-mark]')).toHaveCount(1)
})

test("a timed-out database open closes its late connection instead of leaking a writer", async ({ page }) => {
  await setup(page)
  await page.clock.install()
  const state = await page.evaluateHandle(async () => {
    const url = "/src/components/image-annotation/storage.ts"
    const storage: StorageModule = await import(url)
    const original = IDBFactory.prototype.open
    let connection: IDBDatabase | undefined
    let late: (() => void) | undefined
    let opened: (() => void) | undefined
    const ready = new Promise<void>((resolve) => { opened = resolve })
    IDBFactory.prototype.open = function (...args: Parameters<IDBFactory["open"]>) {
      const request = original.apply(this, args)
      // Delay only delivery to the production handler, not the actual database.
      Object.defineProperty(request, "onsuccess", { set(handler: ((event: Event) => void) | null) {
        request.addEventListener("success", (event) => {
          connection = request.result
          late = () => handler?.call(request, event)
          opened?.()
        })
      } })
      return request
    }
    const outcome = storage.emojiUsage().then(() => "unexpected success", (error: Error) => error.message)
    return { ready, outcome, finish: () => {
      IDBFactory.prototype.open = original
      late?.()
      try { connection?.transaction("usage"); return false } catch { return true }
    } }
  })
  await state.evaluate(async (state) => state.ready)
  await page.clock.fastForward(5_100)
  expect(await state.evaluate(async (state) => state.outcome)).toContain("blocked by another window")
  expect(await state.evaluate((state) => state.finish())).toBe(true)
  await state.dispose()
})

for (const origin of ["user", "assistant", "attach"] as const) {
  test(`sent ${origin} images open as a new editable copy without changing history`, async ({ page }) => {
    await setup(page)
    const source = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 200
      const context = canvas.getContext("2d")!; context.fillStyle = "white"; context.fillRect(0, 0, 320, 200)
      return canvas.toDataURL("image/png")
    })
    const user = { id: "msg_user", sessionID, role: "user", time: { created: 1 }, agent: "build", model: { providerID: "openrouter", modelID: "stealth/ox-alpha" } }
    const assistant = { id: "msg_assistant", sessionID, role: "assistant", parentID: user.id, time: { created: 2, completed: 3 }, modelID: "stealth/ox-alpha", providerID: "openrouter", mode: "build", agent: "build", path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" }
    const file = { id: "part_image", sessionID, messageID: origin === "user" ? user.id : assistant.id, type: "file", mime: "image/png", url: source, filename: "historical.png" }
    const userParts = [{ id: "part_user_text", sessionID, messageID: user.id, type: "text", text: "Original history" }, ...(origin === "user" ? [file] : [])]
    const assistantParts = origin === "assistant" ? [file] : [{ id: "part_tool", sessionID, messageID: assistant.id, type: "tool", callID: "call_image", tool: "attach", state: { status: "completed", input: { filePath: "historical.png" }, output: "Attached historical.png", title: "historical.png", metadata: { filename: "historical.png" }, time: { start: 2, end: 3 }, attachments: [{ mime: "image/png", url: source, filename: "historical.png" }] } }]
    await setup(page, { pageMessages: () => ({ items: [{ info: user, parts: userParts }, ...(origin !== "user" ? [{ info: assistant, parts: assistantParts }] : [])] }) })
    if (origin === "assistant") {
      // Direct assistant file parts are a legacy-history dialect; V2 represents
      // these as tool attachments. Exercise the actual legacy preview path.
      await page.route(new RegExp(`/api/session/${sessionID}/message(?:\\?|$)`), (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: [], cursor: {} }) }))
      await page.reload()
    }
    const historical = page.locator('img[alt="historical.png"]').first()
    await historical.click()
    await page.locator('[data-action="annotate-copy"]').click()
    const editor = page.locator('[data-component="image-annotation-editor"]')
    await expect(editor).toBeVisible()
    await draw(page, "arrow", [0.1, 0.1], [0.8, 0.8])
    await editor.locator('[data-action="apply-annotation"]').click()
    await expect(editor).toHaveCount(0)
    const composer = page.locator('[data-component="session-composer"]')
    await expect(composer.locator('img[alt="historical.png"]')).toHaveCount(1)
    await expect(historical).toHaveAttribute("src", source)
    await composer.locator('img[alt="historical.png"]').click()
    await expect(editor.locator('[data-mark]')).toHaveCount(1)
  })
}
