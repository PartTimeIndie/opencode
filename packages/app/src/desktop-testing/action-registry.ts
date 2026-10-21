import type { DesktopMenuAction } from "@/desktop-menu"
import { useCommand } from "@/context/command"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useTabs } from "@/context/tabs"
import { useModels } from "@/context/models"
import { pluginSettingsLeafFields } from "@/components/settings-v2/plugin-setting-values"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { onCleanup, onMount } from "solid-js"
import { useAppPluginRuntime } from "@/plugin/app-runtime"
import { createDesktopTestingSnapshot, installDesktopTestingDebugCapture } from "./snapshot"
import { pluginItemID } from "./plugin-action-id"
import { cancelSessionTool, startSessionPrompt } from "./session-action"
import { desktopTestingDefaultModel, desktopTestingPromptModel } from "./default-model"
import { normalizeBrowserURL, SessionBrowserControl, type SessionBrowserController } from "@/pages/session/composer/session-browser-control"
import {
  DOCK_AREAS,
  MOBILE_BROWSER_DOCK_MIN_SIZE,
  MOBILE_DOCK_MEDIA_QUERY,
  type DockArea,
} from "@/context/layout-dock"

type DesktopTestingModel = {
  providerID: string
  modelID: string
}

export type DesktopTestingAction =
  | { type: "app.status" }
  | { type: "app.command"; command: string }
  | { type: "app.menu"; action: DesktopMenuAction }
  | { type: "screen.capture"; includeDebugText?: boolean }
  | { type: "session.list"; directory?: string }
  | { type: "session.open"; sessionID: string; directory?: string }
  | { type: "session.resume"; sessionID: string; directory?: string }
  | { type: "session.cancelTool"; sessionID: string; callID: string; directory?: string }
  | {
      type: "session.prompt"
      sessionID: string
      directory?: string
      text: string
      agent: string
      model?: DesktopTestingModel
      variant?: string
    }
  | { type: "session.interrupt"; sessionID: string; directory?: string }
  | { type: "question.list"; directory?: string }
  | {
      type: "question.reply"
      sessionID: string
      requestID: string
      answers: string[][]
      directory?: string
    }
  | { type: "question.reject"; sessionID: string; requestID: string; directory?: string }
  | { type: "browser.open"; url: string }
  | { type: "browser.navigate"; url: string }
  | { type: "browser.close"; tabId?: string }
  | { type: "browser.status" }
  | { type: "dock.setActive"; area: DockArea; tab?: string }
  | { type: "plugin.list" }
  | { type: "plugin.dock.open"; pluginID: string; itemID: string }
  | { type: "plugin.dock.close"; pluginID: string; itemID: string }
  | { type: "plugin.toolbar.invoke"; pluginID: string; itemID: string }
  | { type: "plugin.settings.get"; pluginID: string }
  | { type: "plugin.settings.set"; pluginID: string; key: string; value: unknown }
  | { type: "plugin.automation.run"; pluginID: string; actionID: string; input?: unknown }

type DesktopTestingHostApi = {
  action(input: DesktopTestingAction): Promise<unknown>
  screenState(): Promise<unknown>
}

type DesktopTestingWindow = Window & {
  __OPENCODE__?: {
    deepLinks?: string[]
    desktopTesting?: DesktopTestingHostApi
  }
}

export function DesktopTestingHost() {
  const command = useCommand()
  const layout = useLayout()
  const platform = usePlatform()
  const server = useServer()
  const serverSDK = useServerSDK()
  const tabs = useTabs()
  const models = useModels()
  const plugins = useAppPluginRuntime()

  const sessionExists = async (sessionID: string, directory: string) =>
    serverSDK()
      .createClient({ directory, throwOnError: true })
      .session.get({ sessionID })
      .then((x) => x.data?.id === sessionID)
      .catch(() => false)

  const resolveDirectoryForSession = async (sessionID: string, preferred?: string) => {
    if (preferred) return (await sessionExists(sessionID, preferred)) ? preferred : undefined
    const route = layout.route()
    if (route.type === "session" && route.sessionId === sessionID) return (await sessionExists(sessionID, route.dir)) ? route.dir : undefined
    for (const project of layout.projects.list()) {
      const sessions = await serverSDK().client.session.list({ directory: project.worktree }).then((x) => x.data ?? [])
      if (sessions.some((session) => session.id === sessionID)) return project.worktree
    }
  }

  const sessionList = async (directory?: string) => {
    const directories = directory ? [directory] : layout.projects.list().map((project) => project.worktree)
    const sessions = await Promise.all(
      directories.map(async (item) => ({
        directory: item,
        sessions: await serverSDK().client.session.list({ directory: item }).then((x) => x.data ?? []),
      })),
    )
    return sessions
  }

  const pluginStatus = () => ({
    status: plugins.status().map((item) => ({
      id: item.id,
      enabled: item.enabled,
      active: item.active,
      capabilities: item.capabilities.slice(),
    })),
    dock: plugins.dockItems().map((item) => ({ id: item.id, pluginID: item.pluginID, title: item.title })),
    toolbar: plugins.toolbarItems().map((item) => ({ id: item.id, pluginID: item.pluginID, title: item.title })),
    settings: plugins.settingsItems().map((item) => ({ id: item.id, pluginID: item.pluginID, title: item.title })),
    automation: plugins.automationItems().map((item) => ({
      id: item.id,
      pluginID: item.pluginID,
      title: item.title,
      description: item.description,
      inputSchema: jsonSafe(item.inputSchema),
    })),
  })

  const browserDockStatus = () => {
    const item = layout.dock.item("browser")
    const area = item.area() ?? "right"
    return {
      area,
      visible: item.visible(),
      active: layout.dock.area(area).active() === "browser",
    }
  }

  const waitForBrowserController = async (attempt = 0): Promise<SessionBrowserController> => {
    const controller = SessionBrowserControl.peek()
    if (controller) return controller
    if (attempt >= 5) return SessionBrowserControl.current()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    return waitForBrowserController(attempt + 1)
  }

  const openBrowserDock = async () => {
    // Reveal the Browser dock in whatever area it already lives in. Only fall
    // back to "right" the first time it is created; never move an existing dock
    // just because an agent asked to use the browser.
    const area = layout.dock.itemArea("browser") ?? "right"
    layout.dock.ensureItem("browser", area, true)
    layout.dock.setItemVisible("browser", true)
    if (window.matchMedia(MOBILE_DOCK_MEDIA_QUERY).matches) {
      layout.dock.mobile.resize(Math.max(layout.dock.mobile.size(), MOBILE_BROWSER_DOCK_MIN_SIZE))
      layout.dock.mobile.activate("browser")
      return waitForBrowserController()
    }
    layout.dock.setActive(area, "browser")
    return waitForBrowserController()
  }

  // The most recent sub-tab an agent opened via browser.open, so browser.close
  // (without an explicit tabId) closes the tab that agent is responsible for.
  let lastAgentTabId: string | undefined

  const runAction = async (action: DesktopTestingAction): Promise<unknown> => {
    switch (action.type) {
      case "app.status":
        await models.ready.promise
        return jsonSafe({
          route: jsonSafe(layout.route()),
          activeTab: jsonSafe(tabs.active()),
          projects: layout.projects.list().map((project) => ({
            id: project.id,
            worktree: project.worktree,
            name: project.name,
            expanded: project.expanded,
            icon: projectIconSummary(project.icon),
          })),
          plugins: pluginStatus(),
          defaultModel: desktopTestingDefaultModel(
            models.chain.find(models.chain.default()),
            models.selection.model(),
            models.selection.variant(),
          ),
        })
      case "app.command":
        command.trigger(action.command)
        return { ok: true, command: action.command }
      case "app.menu":
        await platform.runDesktopMenuAction?.(action.action)
        return { ok: true, action: action.action }
      case "screen.capture":
        return createDesktopTestingSnapshot()
      case "session.list":
        return sessionList(action.directory)
      case "session.open": {
        const directory = await resolveDirectoryForSession(action.sessionID, action.directory)
        if (!directory) throw new Error(`Could not resolve directory for session ${action.sessionID}`)
        tabs.openSessionTab({
          server: server.key,
          dirBase64: base64Encode(directory),
          sessionId: action.sessionID,
        })
        return { ok: true, directory, sessionID: action.sessionID }
      }
      case "session.resume": {
        const directory = await resolveDirectoryForSession(action.sessionID, action.directory)
        if (!directory) throw new Error(`Could not resolve directory for session ${action.sessionID}`)
        // Resume starts a provider turn that can legitimately run for many minutes.
        // The desktop-testing bridge has a short request deadline, so awaiting the
        // full turn here reports a false timeout even though the server accepted it.
        const resume = serverSDK().createClient({ directory, throwOnError: true }).v2.session.resume({ sessionID: action.sessionID })
        void resume.catch(() => undefined)
        return { ok: true, accepted: true, directory, sessionID: action.sessionID }
      }
      case "session.cancelTool": {
        const directory = await resolveDirectoryForSession(action.sessionID, action.directory)
        if (!directory) throw new Error(`Could not resolve directory for session ${action.sessionID}`)
        const result = await cancelSessionTool(serverSDK().createClient({ directory, throwOnError: true }), {
          sessionID: action.sessionID,
          callID: action.callID,
        })
        return { ok: true, cancelled: result.data, directory, sessionID: action.sessionID, callID: action.callID }
      }
      case "session.prompt": {
        const directory = await resolveDirectoryForSession(action.sessionID, action.directory)
        if (!directory) throw new Error(`Could not resolve directory for session ${action.sessionID}`)
        const client = serverSDK().createClient({ directory, throwOnError: true })
        const session = await client.session
          .get({ sessionID: action.sessionID })
          .then((result) => result.data)
          .catch(() => undefined)
        // An omitted model must not force the calling agent to guess a provider
        // model — that guess is what ran a testing session on GPT-5.6 while the
        // configured chain was the reported default. Stored session models stay
        // sticky (no model sent), sessions without one follow the Settings
        // default chain exactly as app.status reports it.
        const model = desktopTestingPromptModel({
          requested: action.model ? { providerID: action.model.providerID, modelID: action.model.modelID } : undefined,
          variant: action.variant,
          sessionModel: session?.model,
          chain: models.chain.find(models.chain.default()),
          selected: models.selection.model(),
          selectedVariant: models.selection.variant(),
        })
        const result = startSessionPrompt(client, {
          sessionID: action.sessionID,
          agent: action.agent,
          ...(model ? { model } : {}),
          prompt: { text: action.text },
        })
        return { ok: true, ...result, directory, sessionID: action.sessionID }
      }
      case "session.interrupt": {
        const directory = await resolveDirectoryForSession(action.sessionID, action.directory)
        if (!directory) throw new Error(`Could not resolve directory for session ${action.sessionID}`)
        await serverSDK().createClient({ directory, throwOnError: true }).v2.session.interrupt({ sessionID: action.sessionID })
        return { ok: true, directory, sessionID: action.sessionID }
      }
      case "question.list": {
        const directories = action.directory ? [action.directory] : layout.projects.list().map((project) => project.worktree)
        return Promise.all(
          [...new Set(directories)].map(async (directory) => ({
            directory,
            questions: await serverSDK()
              .createClient({ directory, throwOnError: true })
              .v2.surface.request.list({ location: { directory } })
              .then((result) => result.data?.data ?? []),
          })),
        )
      }
      case "question.reply": {
        const directory = await resolveDirectoryForSession(action.sessionID, action.directory)
        if (!directory) throw new Error(`Could not resolve directory for session ${action.sessionID}`)
        await serverSDK().createClient({ directory, throwOnError: true }).v2.session.surface.reply({
          sessionID: action.sessionID,
          requestID: action.requestID,
          questionV2Reply: { answers: action.answers },
        })
        return { ok: true, directory, sessionID: action.sessionID, requestID: action.requestID }
      }
      case "question.reject": {
        const directory = await resolveDirectoryForSession(action.sessionID, action.directory)
        if (!directory) throw new Error(`Could not resolve directory for session ${action.sessionID}`)
        await serverSDK().createClient({ directory, throwOnError: true }).v2.session.surface.dismiss({
          sessionID: action.sessionID,
          requestID: action.requestID,
        })
        return { ok: true, directory, sessionID: action.sessionID, requestID: action.requestID }
      }
      case "browser.open": {
        // browser.open opens a NEW sub-tab by default and returns its tabId so
        // the caller can target/close it later.
        const url = normalizeBrowserURL(action.url)
        if (!url) throw new Error("Browser URL must be http:// or https://")
        const controller = await openBrowserDock()
        const result = controller.openTab(url)
        lastAgentTabId = result.tabId
        return jsonSafe({ ok: true, dock: browserDockStatus(), browser: result })
      }
      case "browser.navigate": {
        // browser.navigate changes the URL of the currently active sub-tab only.
        const url = normalizeBrowserURL(action.url)
        if (!url) throw new Error("Browser URL must be http:// or https://")
        const controller = await openBrowserDock()
        return jsonSafe({ ok: true, dock: browserDockStatus(), browser: controller.navigate(url) })
      }
      case "browser.close": {
        const controller = SessionBrowserControl.peek()
        if (!controller) return { ok: false, closed: false }
        const result = controller.closeTab(action.tabId ?? lastAgentTabId)
        if (result.tabId === lastAgentTabId) lastAgentTabId = undefined
        return { ok: true, ...result }
      }
      case "browser.status":
        return jsonSafe({ ok: true, dock: browserDockStatus(), browser: SessionBrowserControl.peek()?.status() })
      case "dock.setActive":
        if (!DOCK_AREAS.includes(action.area)) throw new Error(`Invalid dock area: ${String(action.area)}`)
        layout.dock.setActive(action.area, action.tab)
        return { ok: true }
      case "plugin.list":
        return jsonSafe(pluginStatus())
      case "plugin.dock.open":
        plugins.openDockItem(pluginItemID(action.pluginID, action.itemID))
        return { ok: true }
      case "plugin.dock.close":
        plugins.closeDockItem(pluginItemID(action.pluginID, action.itemID))
        return { ok: true }
      case "plugin.toolbar.invoke":
        await plugins.invokeToolbarItem(pluginItemID(action.pluginID, action.itemID))
        return { ok: true }
      case "plugin.settings.get": {
        const item = plugins.settingsItems().find((candidate) => candidate.id === action.pluginID)
        if (!item) return {}
        return Object.fromEntries(
          item.sections.flatMap((section) =>
            pluginSettingsLeafFields(section.fields).map((field) => [
              field.key,
              plugins.settingValue(action.pluginID, field.key, field.default),
            ]),
          ),
        )
      }
      case "plugin.settings.set":
        plugins.setSettingValue(action.pluginID, action.key, action.value)
        return { ok: true }
      case "plugin.automation.run":
        return jsonSafe(await plugins.runAutomationItem(action.pluginID, action.actionID, action.input))
      default:
        throw new Error(`Unknown desktop testing action: ${(action as { type?: string }).type ?? "<missing>"}`)
    }
  }

  onMount(() => {
    installDesktopTestingDebugCapture()
    const target = window as DesktopTestingWindow
    target.__OPENCODE__ ??= {}
    target.__OPENCODE__.desktopTesting = {
      action: runAction,
      screenState: async () => createDesktopTestingSnapshot(),
    }
  })

  onCleanup(() => {
    const target = window as DesktopTestingWindow
    if (!target.__OPENCODE__?.desktopTesting) return
    delete target.__OPENCODE__.desktopTesting
  })

  return null
}

function jsonSafe(value: unknown) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value)) as unknown
}

function projectIconSummary(icon: { url?: string; color?: string } | undefined) {
  if (!icon) return undefined
  return {
    color: icon.color,
    hasUrl: Boolean(icon.url),
  }
}
