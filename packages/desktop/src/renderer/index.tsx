// @refresh reload

import {
  ACCEPTED_FILE_EXTENSIONS,
  AppBaseProviders,
  AppInterface,
  handleNotificationClick,
  loadLocaleDict,
  normalizeLocale,
  type Locale,
  type Platform,
  PlatformProvider,
  ServerConnection,
  useCommand,
  useWslServers,
} from "@opencode-ai/app"
import type { UpdaterState } from "@opencode-ai/app/updater"
import * as Sentry from "@sentry/solid"
import type { AsyncStorage } from "@solid-primitives/storage"
import { createMemoryHistory, MemoryRouter, type MemoryRouterProps } from "@solidjs/router"
import { createEffect, createMemo, createResource, createSignal, onCleanup, onMount, Show } from "solid-js"
import { render } from "solid-js/web"
import pkg from "../../package.json"
import type { DesktopTestingRequest } from "../preload/types"
import { initI18n, t } from "./i18n"
import { initializationData, initializationReady } from "./initialization"
import { handleExternalLinkClick } from "./external-links"
import { resetZoom, setPinchZoomEnabled, webviewZoom, zoomIn, zoomOut } from "./webview-zoom"
import { availableStartupServer, readyWslConnections } from "./wsl/connections"
import "./styles.css"
import { Splash } from "@opencode-ai/ui/logo"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { ServerStatus } from "./server-status"

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(t("error.dev.rootNotFound"))
}

const ignoredBrowserErrorMessages = new Set([
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
])

window.addEventListener(
  "error",
  (event) => {
    if (!ignoredBrowserErrorMessages.has(event.message)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  },
  true,
)

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE ?? `desktop@${pkg.version}`,
    initialScope: {
      tags: {
        platform: "desktop",
      },
    },
    integrations: (integrations) => {
      return integrations.filter(
        (i) =>
          i.name !== "Breadcrumbs" &&
          !(
            import.meta.env.OPENCODE_CHANNEL === "prod" &&
            (i.name === "GlobalHandlers" || i.name === "BrowserApiErrors")
          ),
      )
    },
  })
}

void initI18n()

const [updaterState, setUpdaterState] = createSignal<UpdaterState>({ status: "disabled" })
void window.api.updater.subscribe(setUpdaterState)

const deepLinkEvent = "opencode:deep-link"

function desktopRouterPath() {
  const pathname = window.location.pathname.endsWith("/index.html") ? "/" : window.location.pathname || "/"
  return `${pathname}${window.location.search}${window.location.hash}`
}

function DesktopMemoryRouter(props: MemoryRouterProps) {
  const history = createMemoryHistory()
  const value = desktopRouterPath()
  if (value !== "/") history.set({ value, replace: true, scroll: false })
  return <MemoryRouter {...props} history={history} />
}

const emitDeepLinks = (urls: string[]) => {
  if (urls.length === 0) return
  window.__OPENCODE__ ??= {}
  const pending = window.__OPENCODE__.deepLinks ?? []
  window.__OPENCODE__.deepLinks = [...pending, ...urls]
  window.dispatchEvent(new CustomEvent(deepLinkEvent, { detail: { urls } }))
}

const listenForDeepLinks = () => {
  void window.api.consumeInitialDeepLinks().then((urls) => emitDeepLinks(urls))
  return window.api.onDeepLink((urls) => emitDeepLinks(urls))
}

type DesktopTestingWindow = Window & {
  __OPENCODE__?: {
    desktopTesting?: {
      action(input: unknown): Promise<unknown>
      screenState(): Promise<unknown>
    }
  }
}

const desktopTestingHandler = async (request: DesktopTestingRequest) => {
  const bridge = (window as DesktopTestingWindow).__OPENCODE__?.desktopTesting
  if (!bridge) throw new Error("Desktop testing renderer bridge is not ready")
  if (request.type === "action") return bridge.action(request.payload)
  if (request.type === "screen-state") return bridge.screenState()
  if (request.type === "prepare-recovery") return bridge.action({ type: "app.status" })
  throw new Error(`Unknown desktop testing request: ${request.type}`)
}

window.api.desktopTesting?.onRequest(desktopTestingHandler)

const createPlatform = (): Platform => {
  const attachmentPaths = new WeakMap<File, string>()
  const os = (() => {
    const ua = navigator.userAgent
    if (ua.includes("Mac")) return "macos"
    if (ua.includes("Windows")) return "windows"
    if (ua.includes("Linux")) return "linux"
    return undefined
  })()

  const runDesktopMenuAction: Platform["runDesktopMenuAction"] = (action) => {
    switch (action) {
      case "view.resetZoom":
        resetZoom()
        return
      case "view.zoomIn":
        zoomIn()
        return
      case "view.zoomOut":
        zoomOut()
        return
    }

    return window.api.runDesktopMenuAction(action)
  }

  const storage = (() => {
    const cache = new Map<string, AsyncStorage>()

    const createStorage = (name: string) => {
      const api: AsyncStorage = {
        getItem: (key: string) => window.api.storeGet(name, key),
        setItem: (key: string, value: string) => window.api.storeSet(name, key, value),
        removeItem: (key: string) => window.api.storeDelete(name, key),
        clear: () => window.api.storeClear(name),
        key: async (index: number) => (await window.api.storeKeys(name))[index],
        getLength: () => window.api.storeLength(name),
        get length() {
          return api.getLength()
        },
      }
      return api
    }

    return (name = "default.dat") => {
      const cached = cache.get(name)
      if (cached) return cached
      const api = createStorage(name)
      cache.set(name, api)
      return api
    }
  })()

  const wslServersApi = os === "windows" ? window.api.wslServers : undefined

  return {
    platform: "desktop",
    os,
    version: pkg.version,

    async openDirectoryPickerDialog(opts) {
      return window.api.openDirectoryPicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFolder"),
      })
    },

    async openAttachmentPickerDialog(opts, onFile) {
      const result = await window.api.openFilePicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFile"),
        defaultPath: opts?.defaultPath,
        extensions: opts?.extensions ?? ACCEPTED_FILE_EXTENSIONS,
      })
      if (!result) return
      try {
        for (const file of result.files) {
          const selected = new File([await window.api.readPickedFile(result.token, file.path)], file.name)
          attachmentPaths.set(selected, file.path)
          await onFile(selected)
        }
      } finally {
        await window.api.releasePickedFiles(result.token)
      }
    },

    getPathForFile(file) {
      return attachmentPaths.get(file) ?? window.api.getPathForFile(file)
    },

    async saveFilePickerDialog(opts) {
      return window.api.saveFilePicker({
        title: opts?.title ?? t("desktop.dialog.saveFile"),
        defaultPath: opts?.defaultPath,
      })
    },

    openLink(url: string) {
      window.api.openLink(url)
    },
    openAppWindow(route: string) {
      return window.api.openAppWindow(route)
    },
    async openPath(path: string, app?: string) {
      if (os === "windows") {
        const resolvedApp = app ? await window.api.resolveAppPath(app).catch(() => null) : null
        return window.api.openPath(path, resolvedApp ?? undefined)
      }
      return window.api.openPath(path, app)
    },

    back() {
      window.history.back()
    },

    forward() {
      window.history.forward()
    },

    storage,
    sessionAttention: window.api.sessionAttention,

    updater: {
      state: updaterState,
      check: () => window.api.updater.check(),
      install: () => window.api.updater.install(),
    },

    exportDebugLogs: () => window.api.exportDebugLogs(),

    recordFatalRendererError: (error) => window.api.recordFatalRendererError(error),

    restart: async () => {
      await window.api.killSidecar().catch(() => undefined)
      window.api.relaunch()
    },

    notify: async (title, description, href, options) => {
      const focused = await window.api.getWindowFocused().catch(() => document.hasFocus())
      if (focused && !options?.always) return

      const notification = new Notification(title, {
        body: description ?? "",
        icon: "https://opencode.ai/favicon-96x96-v3.png",
      })
      notification.onclick = () => {
        void window.api.showWindow()
        void window.api.setWindowFocus()
        handleNotificationClick(href)
        notification.close()
      }
    },

    fetch: (input, init) => {
      if (input instanceof Request) return fetch(input)
      return fetch(input, init)
    },

    getDefaultServer: async () => {
      const url = await window.api.getDefaultServerUrl().catch(() => null)
      if (!url) return null
      return ServerConnection.Key.make(url)
    },

    setDefaultServer: async (url: string | null) => {
      await window.api.setDefaultServerUrl(url)
    },

    wslServers: wslServersApi,

    getDisplayBackend: async () => {
      return window.api.getDisplayBackend().catch(() => null)
    },

    setDisplayBackend: async (backend) => {
      await window.api.setDisplayBackend(backend)
    },

    parseMarkdown: (markdown: string) => window.api.parseMarkdownCommand(markdown),

    webviewZoom,
    embeddedBrowser: "webview",
    browserTransfer: (action, id, ticket) => window.api.browserTransfer(action, id, ticket),

    getPinchZoomEnabled: () => window.api.getPinchZoomEnabled(),

    setPinchZoomEnabled,

    getBrowserAutomationEnabled: () => window.api.getBrowserAutomationEnabled(),

    setBrowserAutomationEnabled: (enabled: boolean) => window.api.setBrowserAutomationEnabled(enabled),

    runDesktopMenuAction,

    async registerDesktopService(input, onInvoke) {
      const result = await window.api.registerDesktopService(input)
      if (!result.ok) return result
      const unsubscribe = window.api.onDesktopServiceInvocation((event) => {
        if (event.registrationID !== result.registrationID) return
        void Promise.resolve(onInvoke(event.invocation)).catch((error) => {
          console.error("[desktop-service] invocation handler failed", error)
          return window.api
            .updateDesktopService(result.registrationID, event.invocation.id, {
              phase: "error",
              label: "The desktop service could not start this invocation.",
            })
            .catch((updateError) => console.error("[desktop-service] invocation recovery failed", updateError))
        })
      })
      return {
        ok: true,
        accelerator: result.accelerator,
        readClipboard: (invocationID) => window.api.readDesktopServiceClipboard(result.registrationID, invocationID),
        writeClipboard: (invocationID, text) => window.api.writeDesktopServiceClipboard(result.registrationID, invocationID, text),
        update: (invocationID, state) => window.api.updateDesktopService(result.registrationID, invocationID, state),
        insertText: (invocationID, text) =>
          window.api.insertDesktopServiceText(result.registrationID, invocationID, text),
        async dispose() {
          unsubscribe()
          await window.api.unregisterDesktopService(result.registrationID)
        },
      }
    },

    writeClipboardText: (text) => window.api.writeClipboardText(text),

    checkAppExists: async (appName: string) => {
      return window.api.checkAppExists(appName)
    },

    async readClipboardImage(options) {
      const image = await window.api.readClipboardImage(options).catch(() => null)
      if (!image) return null
      const file = new File(
        image.buffer ? [image.buffer] : [],
        image.path.split(/[\\/]/).at(-1) ?? `pasted-image-${Date.now()}.png`,
        { type: "image/png" },
      )
      attachmentPaths.set(file, image.path)
      return file
    },
  }
}

let menuTrigger = null as null | ((id: string) => void)
window.api.onMenuCommand((id) => {
  menuTrigger?.(id)
})
listenForDeepLinks()

render(() => {
  const platform = createPlatform()
  const loadLocale = async () => {
    const current = await platform.storage?.("opencode.global.dat").getItem("language")
    const legacy = current ? undefined : await platform.storage?.().getItem("language.v1")
    const raw = current ?? legacy
    if (!raw) return
    const locale = raw.match(/"locale"\s*:\s*"([^"]+)"/)?.[1]
    if (!locale) return
    const next = normalizeLocale(locale)
    if (next !== "en") await loadLocaleDict(next)
    return next satisfies Locale
  }

  const [windowCount] = createResource(() => window.api.getWindowCount())

  // Wait for verified sidecar health before mounting API-backed providers.
  const [sidecar] = createResource(() => window.api.awaitInitialization())

  const [defaultServer] = createResource(() => platform.getDefaultServer?.())
  const [locale] = createResource(loadLocale)

  function handleClick(e: MouseEvent) {
    handleExternalLinkClick(e, platform.openLink)
  }

  function Inner() {
    const cmd = useCommand()
    menuTrigger = (id) => cmd.trigger(id)

    const theme = useTheme()

    createEffect(() => {
      theme.themeId()
      theme.mode()
      const bg = getComputedStyle(document.documentElement).getPropertyValue("--background-base").trim()
      if (bg) {
        void window.api.setBackgroundColor(bg)
      }
    })

    return null
  }

  function App() {
    onMount(() => window.dispatchEvent(new Event("opencode:renderer-mounted")))
    const wslServers = useWslServers()
    const splash = (
      <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
        <Splash class="w-16 h-20 opacity-50 animate-pulse" />
      </div>
    )

    const ready = createMemo(
      () => !defaultServer.loading && !sidecar.loading && !windowCount.loading && !locale.loading,
    )
    const servers = createMemo(() => {
      const data = initializationData(sidecar)
      const list: ServerConnection.Any[] = []
      if (data) {
        list.push({
          displayName: "Local Server",
          type: "sidecar",
          variant: "base",
          http: {
            url: data.url,
            username: data.username ?? undefined,
            password: data.password ?? undefined,
          },
        })
      }
      list.push(...readyWslConnections(wslServers.data))
      return list
    })
    const effectiveDefaultServer = createMemo(() =>
      ServerConnection.Key.make(availableStartupServer(defaultServer.latest, wslServers.data)),
    )

    return (
      <Show when={ready()} fallback={splash}>
        <Show when={effectiveDefaultServer()} keyed>
          {(key) => (
            <AppInterface defaultServer={key} servers={servers()} router={DesktopMemoryRouter}>
              <Inner />
            </AppInterface>
          )}
        </Show>
      </Show>
    )
  }

  onMount(() => {
    document.addEventListener("click", handleClick)
    onCleanup(() => {
      document.removeEventListener("click", handleClick)
    })
  })

  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders locale={locale.latest}>
        <ServerStatus />
        <Show when={true}>{(_) => <App />}</Show>
      </AppBaseProviders>
    </PlatformProvider>
  )
}, root!)
