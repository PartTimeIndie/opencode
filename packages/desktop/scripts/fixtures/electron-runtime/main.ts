import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"
import { app, BrowserWindow, nativeImage } from "electron"
import { readClipboardPng } from "../../../src/main/clipboard-image"

const root = process.env.OPENCODE_RUNTIME_TEST_ROOT
const core = process.env.OPENCODE_RUNTIME_TEST_CORE
const icon = process.env.OPENCODE_RUNTIME_TEST_ICON
if (!root || !core || !icon) throw new Error("Isolated runtime fixture paths required")
app.setPath("userData", join(root, "user-data"))
app.on("window-all-closed", () => {})
void app.whenReady().then(async () => {
  assert.equal(process.versions.electron, process.env.OPENCODE_RUNTIME_TEST_VERSION)
  const source = nativeImage.createFromPath(icon)
  assert(!source.isEmpty())
  for (const type of ["image/png", "image/jpeg"]) {
    const input = type === "image/png" ? source.toPNG() : source.toJPEG(90)
    // No real clipboard read/write: exercise the item boundary with real Blob
    // and native image decoding, without touching the user's clipboard.
    const image = await readClipboardPng(async () => [{
      types: [type], getType: async () => new Blob([input], { type }),
    }], (buffer) => nativeImage.createFromBuffer(buffer))
    assert(image)
    assert.deepEqual({ width: image.width, height: image.height }, source.getSize())
    assert.equal(image.buffer.subarray(0, 8).toString("hex"), "89504e470d0a1a0a")
  }
  const window = new BrowserWindow({
    show: false,
    webPreferences: { preload: join(root, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  await window.loadURL("data:text/html,<title>Isolated runtime fixture</title>")
  assert.equal(await window.webContents.executeJavaScript("typeof window.api?.readClipboardImage"), "function")
  assert.equal(await window.webContents.executeJavaScript("typeof window.require"), "undefined")
  window.destroy()
  const watcher = createRequire(core)("@parcel/watcher") as typeof import("@parcel/watcher")
  const observed = Promise.withResolvers<void>()
  const subscription = await watcher.subscribe(root, (error, events) => {
    if (error) return observed.reject(error)
    if (events.some((event) => event.path.endsWith("native-watcher.txt"))) observed.resolve()
  })
  try {
    await writeFile(join(root, "native-watcher.txt"), "isolated fixture")
    await observed.promise
  } finally {
    await subscription.unsubscribe()
  }
  console.log(`RUNTIME_FIXTURE_OK Electron ${process.versions.electron}; V8 ${process.versions.v8}; PNG/JPEG native conversion; sandboxed production preload; native file watcher`)
  app.exit(0)
}).catch((error) => { console.error(error); app.exit(1) })
