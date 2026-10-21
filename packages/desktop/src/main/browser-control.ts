import { assertBrowserTargetURL } from "./browser-target"

type BrowserStatus = {
  browser?: {
    actualURL?: string
    url?: string
    mode?: string
    tabId?: string
    webContentsID?: number
  }
}

type WebContentsAdapter = {
  readonly id: number
  isDestroyed(): boolean
  getURL(): string
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  capturePage(): Promise<{ toJPEG(quality: number): Buffer }>
  subscribeEvidence(listener: (kind: "console" | "network", value: string) => void): () => void
}

type Input = {
  readonly status: () => Promise<BrowserStatus>
  /** Injectable seam for tests; production resolves the exact Electron webContents. */
  readonly webContentsForId?: (id: number) => WebContentsAdapter | undefined
}

type Target = {
  readonly ref?: string
  readonly selector?: string
  readonly timeout?: number
  readonly expectedOrigin?: string
}

type Evidence = {
  console: string[]
  network: string[]
}

const MAX_EVIDENCE = 50
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024
const REF_ATTRIBUTE = "data-opencode-browser-ref"

export function createBrowserAutomation(input: Input) {
  const directEvidence = new Map<number, Evidence>()
  const evidenceUnsubscribers = new Map<number, () => void>()
  const resolveWebContents = input.webContentsForId

  const activeWebContents = async (timeout = 10_000, expectedOrigin?: string) => {
    const deadline = Date.now() + timeout
    while (Date.now() <= deadline) {
      const current = (await input.status()).browser
      const url = current?.actualURL || current?.url
      if (!current || current.mode !== "webview" || !url || !isHttpUrl(url))
        throw new Error("The active Browser Dock tab is not an HTTP(S) desktop webview")
      if (current.webContentsID !== undefined) {
        const contents = resolveWebContents
          ? resolveWebContents(current.webContentsID)
          : await resolveElectronWebContents(current.webContentsID)
        if (contents && !contents.isDestroyed() && contents.id === current.webContentsID) {
          cleanupInactiveDirectEvidence(contents.id, directEvidence, evidenceUnsubscribers)
          const origin = expectedOrigin ?? new URL(url).origin
          assertBrowserTargetURL(contents.getURL(), origin)
          const confirmation = (await input.status()).browser
          if (confirmation?.mode !== "webview" || confirmation.webContentsID !== current.webContentsID)
            throw new Error("The active Browser Dock webContents changed during resolution; retry the action")
          const confirmationURL = confirmation.actualURL || confirmation.url
          if (!confirmationURL) throw new Error("The active Browser Dock URL disappeared during resolution; retry the action")
          assertBrowserTargetURL(confirmationURL, origin)
          assertBrowserTargetURL(contents.getURL(), origin)
          ensureDirectEvidence(contents, directEvidence, evidenceUnsubscribers)
          return { contents, origin }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`Could not resolve the active Browser Dock webContents ID within ${timeout}ms`)
  }

  const assertStillActive = async (contents: WebContentsAdapter, origin: string) => {
    const current = (await input.status()).browser
    if (!current || current.mode !== "webview" || current.webContentsID !== contents.id)
      throw new Error("The active Browser Dock webContents changed during the action; retry the action")
    assertBrowserTargetURL(contents.getURL(), origin)
  }

  return {
    async snapshot(action: {
      screenshot?: boolean
      maxTextChars?: number
      maxElements?: number
      timeout?: number
      expectedOrigin?: string
    }) {
      const resolved = await activeWebContents(action.timeout, action.expectedOrigin)
      const result = await snapshotWebContents(resolved.contents, action, directEvidence)
      await assertStillActive(resolved.contents, resolved.origin)
      return result
    },
    async click(action: Target & { button?: "left" | "right" | "middle" }) {
      const resolved = await activeWebContents(action.timeout, action.expectedOrigin)
      await executeWebContents(resolved.contents, interactionScript, { action: "click", ref: action.ref, selector: action.selector, button: action.button, refAttribute: REF_ATTRIBUTE })
      await assertStillActive(resolved.contents, resolved.origin)
      return { url: resolved.contents.getURL(), title: await webContentsTitle(resolved.contents) }
    },
    async type(action: Target & { text: string; clear?: boolean; pressEnter?: boolean }) {
      const resolved = await activeWebContents(action.timeout, action.expectedOrigin)
      await executeWebContents(resolved.contents, interactionScript, { action: action.clear === false ? "type" : "fill", ref: action.ref, selector: action.selector, text: action.text, pressEnter: action.pressEnter, refAttribute: REF_ATTRIBUTE })
      await assertStillActive(resolved.contents, resolved.origin)
      return { url: resolved.contents.getURL(), title: await webContentsTitle(resolved.contents) }
    },
    async wait(
      action: Target & { text?: string; state?: "visible" | "hidden" | "attached" | "detached"; milliseconds?: number },
    ) {
      const resolved = await activeWebContents(action.timeout, action.expectedOrigin)
      const timeout = action.timeout ?? 15_000
      const contents = resolved.contents
      if (action.milliseconds !== undefined) {
        const milliseconds = action.milliseconds
        await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(milliseconds, 1), 5_000)))
        await assertStillActive(contents, resolved.origin)
        return { url: contents.getURL(), title: await webContentsTitle(contents), waited: `${action.milliseconds}ms` }
      }
      await waitForWebContents(contents, action, timeout)
      await assertStillActive(contents, resolved.origin)
      return { url: contents.getURL(), title: await webContentsTitle(contents), waited: action.text ? `text ${JSON.stringify(action.text)}` : action.ref ?? action.selector ?? "domcontentloaded" }
    },
  }
}

type BrowserScript = { toString(): string }

type DirectAction = Target & { text?: string; state?: "visible" | "hidden" | "attached" | "detached" }

async function executeWebContents<T>(contents: WebContentsAdapter, script: BrowserScript, args: unknown): Promise<T> {
  return (await contents.executeJavaScript(`(${script.toString()})(${JSON.stringify(args)})`, true)) as T
}

async function webContentsTitle(contents: WebContentsAdapter) {
  return executeWebContents<string>(contents, () => document.title, undefined)
}

async function snapshotWebContents(contents: WebContentsAdapter, action: { screenshot?: boolean; maxTextChars?: number; maxElements?: number }, directEvidence: Map<number, Evidence>) {
  const maxTextChars = Math.min(Math.max(action.maxTextChars ?? 20_000, 1), 20_000)
  const maxElements = Math.min(Math.max(action.maxElements ?? 150, 1), 150)
  const result = await executeWebContents<{ text: string; accessibility: string; elements: unknown[] }>(contents, snapshotScript, {
    maxTextChars,
    maxElements,
    refAttribute: REF_ATTRIBUTE,
  })
  const screenshot = action.screenshot ? (await contents.capturePage()).toJPEG(60) : undefined
  if (screenshot && screenshot.byteLength > MAX_SCREENSHOT_BYTES)
    throw new Error(`Browser screenshot exceeds the ${MAX_SCREENSHOT_BYTES} byte limit`)
  return { url: contents.getURL(), title: await webContentsTitle(contents), ...result, evidence: directEvidence.get(contents.id) ?? { console: [], network: [] }, ...(screenshot ? { screenshotBase64: screenshot.toString("base64") } : {}) }
}

function snapshotScript(settings: { maxTextChars: number; maxElements: number; refAttribute: string }) {
  document.querySelectorAll(`[${settings.refAttribute}]`).forEach((node) => node.removeAttribute(settings.refAttribute))
  const elements = Array.from(document.querySelectorAll("a,button,input,select,textarea,[role],[contenteditable='true']"))
    .filter((node) => { const element = node as HTMLElement; const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0 })
    .slice(0, settings.maxElements)
    .map((node, index) => {
      const element = node as HTMLElement & HTMLInputElement
      const ref = `e${index + 1}`
      element.setAttribute(settings.refAttribute, ref)
      const tag = element.tagName.toLowerCase()
      const role = element.getAttribute("role") || (tag === "a" ? "link" : tag === "button" ? "button" : ["input", "select", "textarea"].includes(tag) ? "input" : "")
      return { ref, tag, role, name: element.getAttribute("aria-label") || element.getAttribute("title") || element.placeholder || element.innerText?.trim().slice(0, 200) || "", type: element.type || "", value: element.type === "password" ? "" : typeof element.value === "string" ? element.value.slice(0, 200) : "", disabled: element.disabled === true || element.getAttribute("aria-disabled") === "true" }
    })
  const text = document.body?.innerText.slice(0, settings.maxTextChars) ?? ""
  return { text, accessibility: text, elements }
}

function interactionScript(settings: { action: "click" | "fill" | "type"; ref?: string; selector?: string; button?: "left" | "right" | "middle"; text?: string; pressEnter?: boolean; refAttribute: string }) {
  const element = (settings.ref ? document.querySelector(`[${settings.refAttribute}="${settings.ref}"]`) : settings.selector ? document.querySelector(settings.selector) : document.body) as HTMLElement | null
  if (!element) throw new Error("Browser target was not found")
  element.scrollIntoView({ block: "center", inline: "center" })
  if (settings.action === "click") {
    const button = settings.button ?? "left"
    const buttonCode = button === "right" ? 2 : button === "middle" ? 1 : 0
    const init = { bubbles: true, cancelable: true, button: buttonCode, buttons: button === "left" ? 1 : 0, detail: 1 }
    element.dispatchEvent(new MouseEvent("mousedown", init))
    element.dispatchEvent(new MouseEvent("mouseup", init))
    if (button === "left") element.click()
    else element.dispatchEvent(new MouseEvent(button === "right" ? "contextmenu" : "auxclick", init))
    return
  }
  if (settings.action === "fill" || settings.action === "type") {
    element.focus()
    const value = settings.action === "fill" ? settings.text ?? "" : readEditableValue(element) + (settings.text ?? "")
    if (element.tagName === "SELECT") (element as HTMLSelectElement).value = value
    else if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")
      descriptor?.set?.call(element, value)
    } else if (element.isContentEditable) element.textContent = value
    else throw new Error("Browser target is not editable")
    element.dispatchEvent(new Event("input", { bubbles: true }))
    element.dispatchEvent(new Event("change", { bubbles: true }))
  }
  if (settings.pressEnter) {
    const key = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }
    element.dispatchEvent(new KeyboardEvent("keydown", key))
    element.dispatchEvent(new KeyboardEvent("keypress", key))
    element.dispatchEvent(new KeyboardEvent("keyup", key))
  }
}

function readEditableValue(element: HTMLElement) {
  if (element.tagName === "SELECT") return (element as HTMLSelectElement).value
  if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") return (element as HTMLInputElement | HTMLTextAreaElement).value
  return element.isContentEditable ? element.textContent ?? "" : ""
}

async function waitForWebContents(contents: WebContentsAdapter, action: DirectAction, timeout: number) {
  const deadline = Date.now() + timeout
  while (Date.now() <= deadline) {
    const found = await executeWebContents<{ exists: boolean; visible: boolean }>(contents, (settings: DirectAction & { refAttribute: string }) => {
      const element = settings.ref ? document.querySelector(`[${settings.refAttribute}="${settings.ref}"]`) : settings.selector ? document.querySelector(settings.selector) : settings.text ? Array.from(document.querySelectorAll("body *")).find((node) => node.textContent?.includes(settings.text!)) : document.body
      return { exists: Boolean(element), visible: Boolean(element && getComputedStyle(element).visibility !== "hidden" && getComputedStyle(element).display !== "none") }
    }, { ...action, refAttribute: REF_ATTRIBUTE })
    const state = action.state ?? (action.text || action.ref || action.selector ? "visible" : "attached")
    if ((state === "visible" && found.visible) || (state === "attached" && found.exists) || (state === "hidden" && !found.visible) || (state === "detached" && !found.exists)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${action.text ?? action.ref ?? action.selector ?? "domcontentloaded"}`)
}

function ensureDirectEvidence(contents: WebContentsAdapter, evidence: Map<number, Evidence>, unsubscribers: Map<number, () => void>) {
  if (evidence.has(contents.id)) return
  const entry = { console: [], network: [] }
  evidence.set(contents.id, entry)
  unsubscribers.set(contents.id, contents.subscribeEvidence((kind, value) => push(entry[kind], value)))
}

function cleanupInactiveDirectEvidence(activeID: number, evidence: Map<number, Evidence>, unsubscribers: Map<number, () => void>) {
  for (const [id, unsubscribe] of unsubscribers) {
    if (id === activeID) continue
    unsubscribe()
    unsubscribers.delete(id)
    evidence.delete(id)
  }
}

async function resolveElectronWebContents(id: number): Promise<WebContentsAdapter | undefined> {
  const electronContents = (await import("electron")).webContents.fromId(id)
  if (!electronContents) return undefined
  return {
    id: electronContents.id,
    isDestroyed: () => electronContents.isDestroyed(),
    getURL: () => electronContents.getURL(),
    executeJavaScript: (code, userGesture) => electronContents.executeJavaScript(code, userGesture),
    capturePage: () => electronContents.capturePage(),
    subscribeEvidence(listener) {
      const attached = electronContents.debugger.isAttached()
      if (!attached) electronContents.debugger.attach("1.3")
      const onMessage = (_event: unknown, method: string, params: Record<string, unknown>) => {
        if (method === "Runtime.consoleAPICalled") {
          const type = typeof params.type === "string" ? params.type : "log"
          const args = Array.isArray(params.args) ? params.args : []
          listener("console", `[${type}] ${args.map((arg) => typeof arg === "object" && arg && "value" in arg ? String(arg.value) : "").join(" ")}`)
        }
        if (method === "Runtime.exceptionThrown") listener("console", `[pageerror] ${JSON.stringify(params.exceptionDetails ?? "exception")}`)
        if (method === "Network.loadingFailed") listener("network", `[failed] ${String(params.type ?? "") } ${String(params.errorText ?? "failed")}`)
        if (method === "Network.responseReceived") {
          const response = params.response as { status?: number; url?: string } | undefined
          if (response?.status && response.status >= 400) listener("network", `[${response.status}] ${response.url ?? ""}`)
        }
      }
      electronContents.debugger.on("message", onMessage)
      void electronContents.debugger.sendCommand("Runtime.enable").catch(() => undefined)
      void electronContents.debugger.sendCommand("Network.enable").catch(() => undefined)
      return () => {
        electronContents.debugger.removeListener("message", onMessage)
        if (!attached && electronContents.debugger.isAttached()) electronContents.debugger.detach()
      }
    },
  }
}

function push(items: string[], value: string) {
  items.push(value.slice(0, 2_000))
  if (items.length > MAX_EVIDENCE) items.splice(0, items.length - MAX_EVIDENCE)
}

function isHttpUrl(input: string) {
  if (!URL.canParse(input)) return false
  const url = new URL(input)
  return url.protocol === "http:" || url.protocol === "https:"
}
