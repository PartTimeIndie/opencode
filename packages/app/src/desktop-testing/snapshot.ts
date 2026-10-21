type CapturedConsole = {
  level: "log" | "warn" | "error"
  message: string
  time: number
}

type CapturedNetwork = {
  method: string
  url: string
  status?: number
  ok?: boolean
  time: number
  error?: string
}

const MAX_CAPTURED = 100
const MAX_TEXT = 20_000
const MAX_DOM = 30_000
// Stack-bearing error entries need more room than plain log lines so the
// throw site survives truncation.
const MAX_STACK_TEXT = 8_000
const consoleEntries: CapturedConsole[] = []
const networkEntries: CapturedNetwork[] = []

let installed = false

export type DesktopTestingScreenState = {
  text: string
  dom: string
  build: {
    release?: string
    userAgent: string
  }
  theme: {
    dataset: Record<string, string>
    stylePresent: boolean
    styleLength: number
    preloadStylePresent: boolean
  }
  computed: {
    html: ComputedStyleSnapshot
    body: ComputedStyleSnapshot
    root?: ComputedStyleSnapshot
  }
  accessibility: {
    roles: Array<{ role?: string; label: string; tag: string }>
  }
  layout: Array<{
    tag: string
    role?: string
    label: string
    rect: { x: number; y: number; width: number; height: number }
  }>
  console: CapturedConsole[]
  network: CapturedNetwork[]
  focusedElement?: {
    tag: string
    role?: string
    label: string
  }
  scroll: {
    x: number
    y: number
    width: number
    height: number
  }
}

export function installDesktopTestingDebugCapture() {
  if (installed) return
  installed = true
  captureConsole("log")
  captureConsole("warn")
  captureConsole("error")
  captureFetch()
  window.addEventListener("error", (event) => {
    // `event.message` alone hides the throw site; the Error object carries the
    // stack needed to attribute renderer crashes to a chunk/sourcemap.
    const stack = event.error instanceof Error ? event.error.stack : undefined
    pushConsole("error", stack ? `${event.message}\n${stack}` : event.message, MAX_STACK_TEXT)
  })
  window.addEventListener("unhandledrejection", (event) => {
    pushConsole("error", readable(event.reason), MAX_STACK_TEXT)
  })
}

export function createDesktopTestingSnapshot(): DesktopTestingScreenState {
  const elements = Array.from(
    document.querySelectorAll<HTMLElement>(
      "button,a,input,textarea,select,[role],[data-component],[data-plugin-toolbar-item],[data-plugin-dock-item]",
    ),
  ).slice(0, 250)
  return {
    text: trim(document.body.innerText || "", MAX_TEXT),
    dom: trim(sanitizedDom(), MAX_DOM),
    build: {
      release: import.meta.env.VITE_SENTRY_RELEASE || undefined,
      userAgent: navigator.userAgent,
    },
    theme: {
      dataset: datasetSnapshot(document.documentElement.dataset),
      stylePresent: Boolean(document.getElementById("oc-theme")),
      styleLength: document.getElementById("oc-theme")?.textContent?.length ?? 0,
      preloadStylePresent: Boolean(document.getElementById("oc-theme-preload")),
    },
    computed: {
      html: computedStyleSnapshot(document.documentElement),
      body: computedStyleSnapshot(document.body),
      root: elementStyleSnapshot(document.getElementById("root")),
    },
    accessibility: {
      roles: elements.map((element) => ({
        role: element.getAttribute("role") ?? undefined,
        label: labelFor(element),
        tag: element.tagName.toLowerCase(),
      })),
    },
    layout: elements.map((element) => {
      const rect = element.getBoundingClientRect()
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") ?? undefined,
        label: labelFor(element),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      }
    }),
    console: consoleEntries.slice(-MAX_CAPTURED),
    network: networkEntries.slice(-MAX_CAPTURED),
    focusedElement: activeElement(),
    scroll: {
      x: Math.round(window.scrollX),
      y: Math.round(window.scrollY),
      width: Math.round(document.documentElement.scrollWidth),
      height: Math.round(document.documentElement.scrollHeight),
    },
  }
}

type ComputedStyleSnapshot = {
  display: string
  visibility: string
  opacity: string
  color: string
  backgroundColor: string
  colorScheme: string
}

function sanitizedDom() {
  const clone = document.body.cloneNode(true) as HTMLElement
  for (const element of clone.querySelectorAll("#opencode-icon-sprite, script, style")) {
    element.remove()
  }
  return clone.outerHTML || ""
}

function datasetSnapshot(dataset: DOMStringMap) {
  return Object.fromEntries(
    Object.entries(dataset).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

function elementStyleSnapshot(element: HTMLElement | null) {
  if (!element) return undefined
  return computedStyleSnapshot(element)
}

function computedStyleSnapshot(element: HTMLElement) {
  const style = window.getComputedStyle(element)
  return {
    display: style.display,
    visibility: style.visibility,
    opacity: style.opacity,
    color: style.color,
    backgroundColor: style.backgroundColor,
    colorScheme: style.colorScheme,
  }
}

function captureConsole(level: "log" | "warn" | "error") {
  const original = console[level].bind(console)
  console[level] = (...args: unknown[]) => {
    pushConsole(level, args.map(readable).join(" "))
    original(...args)
  }
}

function captureFetch() {
  const original = window.fetch
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET")
    const url = input instanceof Request ? input.url : String(input)
    const time = Date.now()
    try {
      const response = await original(input, init)
      pushNetwork({ method, url, status: response.status, ok: response.ok, time })
      return response
    } catch (error) {
      pushNetwork({ method, url, time, error: readable(error) })
      throw error
    }
  }
  window.fetch = Object.assign(wrapped, original)
}

function pushConsole(level: CapturedConsole["level"], message: string, max = 2_000) {
  consoleEntries.push({ level, message: redact(trim(message, max)), time: Date.now() })
  if (consoleEntries.length > MAX_CAPTURED) consoleEntries.splice(0, consoleEntries.length - MAX_CAPTURED)
}

function pushNetwork(entry: CapturedNetwork) {
  networkEntries.push({ ...entry, url: redact(entry.url) })
  if (networkEntries.length > MAX_CAPTURED) networkEntries.splice(0, networkEntries.length - MAX_CAPTURED)
}

function activeElement() {
  const element = document.activeElement
  if (!(element instanceof HTMLElement)) return
  return {
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute("role") ?? undefined,
    label: labelFor(element),
  }
}

function labelFor(element: HTMLElement) {
  return trim(
    element.getAttribute("aria-label") ??
      element.getAttribute("title") ??
      element.getAttribute("data-component") ??
      element.innerText ??
      element.textContent ??
      "",
    500,
  )
}

function readable(value: unknown) {
  if (value instanceof Error) return value.stack ?? value.message
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function redact(value: string) {
  return value
    .replace(/(authorization|password|token|api[_-]?key)=([^&\s]+)/gi, "$1=<redacted>")
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/g, "$1 <redacted>")
}

function trim(value: string, max: number) {
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n...<truncated ${value.length - max} chars>`
}
