import type { AppHostClipboardWriteResult, AppHostDesktopServiceState } from "@opencode-ai/plugin/app"
import type { AttentionCommand, AttentionResult } from "@/session-attention/broker"
import type { AttentionEntry } from "@/session-attention/state"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import type { Accessor } from "solid-js"
import type { DesktopMenuAction } from "../desktop-menu"
import { ServerConnection } from "./server"
import type { WslServersPlatform } from "../wsl/types"
import type { UpdaterPlatform } from "../updater"

type PickerPaths = string | string[] | null
type OpenDirectoryPickerOptions = { title?: string; multiple?: boolean }
type OpenAttachmentPickerOptions = {
  title?: string
  multiple?: boolean
  accept?: string[]
  extensions?: string[]
  defaultPath?: string
}
type SaveFilePickerOptions = { title?: string; defaultPath?: string }
type ReadClipboardImageOptions = { includeBuffer?: boolean }
type PlatformName = "web" | "desktop"
type DesktopOS = "macos" | "windows" | "linux"

export type PlatformDesktopServiceInvocation = {
  id: string
  action: "start" | "toggle"
  target: {
    kind: "opencode" | "external"
    application: string
    display: { x: number; y: number; width: number; height: number }
  }
}

export type PlatformDesktopServiceState = AppHostDesktopServiceState

export type PlatformDesktopServiceRegistration =
  | { ok: false; error: string }
  | {
      ok: true
      accelerator: string
      readClipboard?(invocationID: string): Promise<string>
      writeClipboard?(invocationID: string, text: string): Promise<void>
      update(
        invocationID: string,
        state: PlatformDesktopServiceState,
      ): Promise<void>
      insertText(
        invocationID: string,
        text: string,
      ): Promise<{ ok: boolean; error?: string; recoveredToClipboard?: boolean }>
      dispose(): Promise<void>
    }

export type FatalRendererErrorLog = {
  error: string
  url: string
  version?: string
  platform: PlatformName
  os?: DesktopOS
}

type PlatformBase = {
  /** App version */
  version?: string

  /** Open a URL in the default browser */
  openLink(url: string): void

  /** Open an app route in a separate app surface */
  openAppWindow?(route: string): Promise<void> | void

  /** Open a local path in a local app (desktop only) */
  openPath?(path: string, app?: string): Promise<void>

  /** Restart the app  */
  restart(): Promise<void>

  /** Navigate back in history */
  back(): void

  /** Navigate forward in history */
  forward(): void

  /** Send a system notification (optional deep link) */
  notify(title: string, description?: string, href?: string, options?: { always?: boolean }): Promise<void>

  /** Open a native attachment picker and read selected files sequentially (desktop only) */
  openAttachmentPickerDialog?(
    opts: OpenAttachmentPickerOptions,
    onFile: (file: File) => Promise<unknown>,
  ): Promise<void>

  /** Resolve the native source path for a desktop File. */
  getPathForFile?(file: File): string

  /** Open a native save file picker dialog (desktop only) */
  saveFilePickerDialog?(opts?: SaveFilePickerOptions): Promise<string | null>

  /** Storage mechanism, defaults to localStorage */
  storage?: (name?: string) => SyncStorage | AsyncStorage

  /** Desktop main-process writer for cross-window important-session results. */
  sessionAttention?: {
    list(): Promise<Record<string, AttentionEntry>>
    update(command: AttentionCommand): Promise<AttentionResult>
    subscribe(callback: (key: string, entry: AttentionEntry) => void): () => void
    visible(key: string | null): Promise<void>
    isVisible(key: string): Promise<boolean>
  }

  /** Application-global desktop updater */
  updater?: UpdaterPlatform

  /** Fetch override */
  fetch?: typeof fetch

  /** Get the configured default server URL (platform-specific) */
  getDefaultServer?(): Promise<ServerConnection.Key | null>

  /** Set the default server URL to use on app startup (platform-specific) */
  setDefaultServer?(url: ServerConnection.Key | null): Promise<void> | void

  /** Manage WSL sidecar servers (Electron on Windows only) */
  wslServers?: WslServersPlatform

  /** Get the preferred display backend (desktop only) */
  getDisplayBackend?(): Promise<DisplayBackend | null> | DisplayBackend | null

  /** Set the preferred display backend (desktop only) */
  setDisplayBackend?(backend: DisplayBackend): Promise<void>

  /** Parse markdown to HTML using native parser (desktop only, returns unprocessed code blocks) */
  parseMarkdown?(markdown: string): Promise<string>

  /** Webview zoom level (desktop only) */
  webviewZoom?: Accessor<number>

  /** Native embedded browser host available in the desktop shell. */
  embeddedBrowser?: "webview"

  /** Reserve or release a browser guest during a user-directed dock transfer. */
  browserTransfer?(action: "reserve" | "commit" | "release", id: number, ticket?: string): Promise<string | boolean>

  /** Get whether native pinch/Ctrl-scroll zoom gestures are enabled (desktop only) */
  getPinchZoomEnabled?(): Promise<boolean> | boolean

  /** Allow native pinch/Ctrl-scroll zoom gestures (desktop only) */
  setPinchZoomEnabled?(enabled: boolean): Promise<void> | void

  /** Get whether desktop browser automation/CDP is enabled for the next launch */
  getBrowserAutomationEnabled?(): Promise<boolean> | boolean

  /** Enable desktop browser automation/CDP for future launches */
  setBrowserAutomationEnabled?(enabled: boolean): Promise<void> | void

  /** Run a desktop-only menu action from the app chrome */
  runDesktopMenuAction?(action: DesktopMenuAction): Promise<void> | void

  /** Check if an editor app exists (desktop only) */
  checkAppExists?(appName: string): Promise<boolean>

  /** Read image from clipboard (desktop only) */
  readClipboardImage?(options?: ReadClipboardImageOptions): Promise<File | null>

  /** Export collected diagnostic logs (desktop only) */
  exportDebugLogs?(): Promise<string>

  /** Record a fatal renderer error in platform logs (desktop only) */
  recordFatalRendererError?(error: FatalRendererErrorLog): Promise<void>

  /** Register one capability-scoped interactive service in the desktop shell. */
  registerDesktopService?(
    input: { pluginID: string; serviceID: string; accelerator: string },
    onInvoke: (invocation: PlatformDesktopServiceInvocation) => void | Promise<void>,
  ): Promise<PlatformDesktopServiceRegistration>

  /** Write text through the desktop shell; works without renderer focus (desktop only). */
  writeClipboardText?(text: string): Promise<AppHostClipboardWriteResult>
}

export type Platform = PlatformBase &
  (
    | { platform: "web"; os?: never }
    | {
        platform: "desktop"
        os?: DesktopOS
        openDirectoryPickerDialog(opts?: OpenDirectoryPickerOptions): Promise<PickerPaths>
      }
  )

export type DisplayBackend = "auto" | "wayland"

export const { use: usePlatform, provider: PlatformProvider } = createSimpleContext({
  name: "Platform",
  init: (props: { value: Platform }) => {
    return props.value
  },
})
