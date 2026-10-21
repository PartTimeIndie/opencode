import "@/index.css"
import * as Sentry from "@sentry/solid"
import { I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { File } from "@opencode-ai/ui/file"
import { Font } from "@opencode-ai/ui/font"
import { Splash } from "@opencode-ai/ui/logo"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { MetaProvider } from "@solidjs/meta"
import { type BaseRouterProps, Route, Router, useLocation, useNavigate, useSearchParams } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { Effect } from "effect"
import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  type JSX,
  lazy,
  onCleanup,
  type ParentProps,
  Show,
  untrack,
} from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Dynamic } from "solid-js/web"
import { CommandProvider } from "@/context/command"
import { CommentsProvider } from "@/context/comments"
import { FileProvider } from "@/context/file"
import { ServerSDKProvider } from "@/context/server-sdk"
import { ServerSyncProvider, useServerSync } from "@/context/server-sync"
import { GlobalProvider } from "@/context/global"
import { HighlightsProvider } from "@/context/highlights"
import { LanguageProvider, type Locale, useLanguage } from "@/context/language"
import { LayoutProvider, useLayout } from "@/context/layout"
import { MOBILE_DOCK_MEDIA_QUERY } from "@/context/layout-dock"
import { ModelsProvider } from "@/context/models"
import { ModelChainSafetyReviewBridge } from "@/context/model-chain-safety-review-bridge"
import { NotificationProvider } from "@/context/notification"
import { PermissionProvider } from "@/context/permission"
import { PromptProvider } from "@/context/prompt"
import { ServerConnection, ServerProvider, serverName, useServer } from "@/context/server"
import { SessionFavoritesProvider } from "@/context/session-favorites"
import { SettingsProvider, useSettings } from "@/context/settings"
import { TerminalProvider } from "@/context/terminal"
import { TabsProvider, useTabs, type DraftTab } from "@/context/tabs"
import { SDKProvider } from "@/context/sdk"
import { SessionRouteProvider } from "@/context/session-route"
import { AppPluginLoadingOverlay, AppPluginRuntimeProvider } from "@/plugin/app-runtime"
import { DesktopTestingHost } from "@/desktop-testing/action-registry"
import { ExtensionManager } from "@/components/extension-manager"
import { PresentationWatchdog } from "@/components/presentation-watchdog"
import { WslServersProvider } from "@/wsl/context"
import { DirectoryDataProvider } from "@/pages/directory-layout"
import { DraftNewSessionPane } from "@/pages/session/draft-new-session-pane"
import { FollowupQueueDrain } from "@/pages/session/followup-drain-runner"
import { DockContentProvider, useDockContent } from "@/pages/session/dock-content-registry"
import { SessionDockShell } from "@/pages/session/session-dock-shell"
import {
  mobileRootDraftSuppressedAtBoot,
  sessionDirectoryRouteKey,
  sessionRouteParamsForCapturedTab,
} from "@/pages/session/session-route-identity"
import Layout from "@/pages/layout"
import { ErrorPage } from "./pages/error"
import { useCheckServerHealth } from "./utils/server-health"
import { decode64 } from "@/utils/base64"
import { base64Encode } from "@opencode-ai/core/util/encode"

const HomeRoute = lazy(() => import("@/pages/home"))
const Session = lazy(() => import("@/pages/session"))
const PreviewRoute = lazy(() => import("@/pages/preview").then((m) => ({ default: m.PreviewRoute })))
const initialBrowserRouteIsRoot =
  typeof window === "undefined" || (window.location.pathname === "/" && window.location.search.length === 0)
const initialBrowserRouteRestoresSession =
  typeof window !== "undefined" &&
  (window.history.state as Record<string, unknown> | null)?.opencodeSessionRoute === true
// Captured once per page load next to the other boot facts. SessionRoute can
// remount on responsive layout switches; reading the live viewport there would
// re-arm the mobile root draft for a desktop boot that merely resized later.
const initialBrowserViewportIsMobile =
  typeof window !== "undefined" && window.matchMedia(MOBILE_DOCK_MEDIA_QUERY).matches

const SessionRoute = Object.assign(
  () => {
    const tabs = useTabs()
    const server = useServer()
    const location = useLocation()
    const navigate = useNavigate()
    const mobile = createMediaQuery(MOBILE_DOCK_MEDIA_QUERY)
    let normalizingLocation: string | undefined
    let mobileRootInitialized = false
    let mobileRootDraftSuppressed = mobileRootDraftSuppressedAtBoot({
      isRootRoute: initialBrowserRouteIsRoot,
      restoresSession: initialBrowserRouteRestoresSession,
      mobileViewport: initialBrowserViewportIsMobile,
    })
    createEffect(() => {
      if (location.pathname === "/") {
        normalizingLocation = undefined
        return
      }
      const locationKey = `${location.pathname}${location.search}${location.hash}`
      if (normalizingLocation === locationKey) return
      const match = /^\/([^/]+)\/session(?:\/([^/]+))?\/?$/.exec(location.pathname)
      if (!match) {
        normalizingLocation = locationKey
        navigate("/", { replace: true })
        return
      }
      if (!tabs.ready() || !tabs.recentReady()) return
      normalizingLocation = locationKey

      const query = new URLSearchParams(location.search)
      const queryServer = query.get("server")
      const targetServer = queryServer ? ServerConnection.Key.make(queryServer) : server.key
      if (match[2]) {
        if (!initialBrowserRouteIsRoot) mobileRootDraftSuppressed = true
        tabs.openSessionTab({ server: targetServer, dirBase64: match[1], sessionId: match[2] })
      } else {
        const directory = decode64(match[1])
        if (directory) {
          const prompt = query.get("prompt") ?? undefined
          const existingDraft = tabs.store.find(
            (tab): tab is DraftTab =>
              tab.type === "draft" && tab.server === targetServer && tab.directory === directory,
          )
          if (existingDraft) {
            tabs.setDraftPrompt(existingDraft.draftID, prompt)
            tabs.select(existingDraft)
          } else tabs.newDraft({ server: targetServer, directory }, prompt)
          query.delete("prompt")
        }
      }
      query.delete("server")
      navigate(`/${query.size ? `?${query}` : ""}${location.hash}`, {
        replace: true,
        state: match[2] ? { opencodeSessionRoute: true } : undefined,
      })
    })
    createEffect(() => {
      if (
        mobileRootInitialized ||
        mobileRootDraftSuppressed ||
        !mobile() ||
        location.pathname !== "/" ||
        location.search
      )
        return
      if (!tabs.ready() || !tabs.recentReady()) return
      mobileRootInitialized = true
      if (tabs.home()) return
      const active = tabs.active()
      if (!active || active.type === "draft") return
      const directory = decode64(active.dirBase64)
      if (!directory) return
      const existingDraft = tabs.store.find(
        (tab) => tab.type === "draft" && tab.server === active.server && tab.directory === directory,
      )
      if (existingDraft) {
        tabs.select(existingDraft)
        navigate("/", { replace: true, state: { opencodeSessionRoute: false } })
        return
      }
      tabs.newDraft({ server: active.server, directory })
      navigate("/", { replace: true, state: { opencodeSessionRoute: false } })
    })
    // Stable remount key: same-server same-directory session switches keep the
    // routed subtree (and the dock panes it feeds) alive; only directory or
    // draft identity changes recreate it. The session id stays reactive
    // through the params accessor below.
    const activeRouteKey = createMemo(() => sessionDirectoryRouteKey(tabs.active()))

    return (
      <Show
        when={activeRouteKey()}
        keyed
        fallback={
          <Show
            when={location.pathname === "/"}
            fallback={
              <div
                data-component="session-route-loading"
                aria-busy="true"
                class="size-full min-h-0 flex items-center justify-center bg-background-base"
              >
                <Splash class="w-16 h-20 opacity-50 animate-pulse" />
              </div>
            }
          >
            <Show when={tabs.home()} fallback={<WorkspaceRestoreRoute />}>
              <HomeRoute />
            </Show>
          </Show>
        }
      >
        {(_key) => {
          // Capture the keyed tab once. Reading tabs.active() here would
          // recreate SessionProviders on every same-directory session switch.
          const tab = untrack(() => tabs.active())
          if (!tab) return null
          if (tab.type === "draft") {
            return (
              <SessionRouteProvider params={() => ({ dir: base64Encode(tab.directory), id: undefined })}>
                <DraftNewSessionPane draft={tab} />
              </SessionRouteProvider>
            )
          }
          const directory = decode64(tab.dirBase64)
          if (!directory) return null
          return (
            <SessionRouteProvider
              params={() => {
                // Follow session switches within this directory reactively;
                // freeze on the captured tab once the active tab moved away so
                // the dying subtree never renders foreign params.
                return sessionRouteParamsForCapturedTab(tab, tabs.active())
              }}
            >
              <SDKProvider directory={directory}>
                <DirectoryDataProvider directory={directory}>
                  <SessionProviders>
                    <Session />
                  </SessionProviders>
                </DirectoryDataProvider>
              </SDKProvider>
            </SessionRouteProvider>
          )
        }}
      </Show>
    )
  },
  { preload: Session.preload },
)

// Single app shell for the canonical "/" route. Session/project changes update
// pane state inside this shell instead of swapping route-owned layouts.
function StableServerLayout(props: ParentProps) {
  return (
    <ServerSDKProvider>
      <ServerSyncProvider>
        <TabsProvider>
          <ServerScopedShell>{props.children}</ServerScopedShell>
        </TabsProvider>
      </ServerSyncProvider>
    </ServerSDKProvider>
  )
}

function RouterShell(props: ParentProps) {
  const location = useLocation()
  const preview = () => location.pathname === "/preview" || location.pathname.startsWith("/preview/")
  return (
    <Show when={!preview()} fallback={props.children}>
      <StableServerLayout>{props.children}</StableServerLayout>
    </Show>
  )
}

// Wraps /new-session. It resolves the draft's target server and provides the
// server-scoped shell for that server — without ServerKey, so the page never depends
// on the globally "selected" server.
function WorkspaceRestoreRoute() {
  const tabs = useTabs()
  const layout = useLayout()
  const server = useServer()
  const serverSync = useServerSync()
  const [search] = useSearchParams<{ directory?: string; prompt?: string; dir?: string; session?: string }>()
  const [fallbackHome, setFallbackHome] = createSignal(false)
  let creatingDraft = false

  const targetDirectory = createMemo(
    () => search.directory?.trim() || layout.projects.list()[0]?.worktree || serverSync().data.project[0]?.worktree,
  )

  createEffect(() => {
    if (!tabs.ready() || !tabs.recentReady()) return
    // A deep-link is consumed by SessionRoute's tab admission effect. Do not
    // create the first project session while that admission is still pending.
    if (search.dir || search.session) return
    const directory = targetDirectory()
    if (!directory) {
      setFallbackHome(true)
      return
    }
    const existingDraft = tabs.store.find(
      (tab): tab is DraftTab => tab.type === "draft" && tab.server === server.key && tab.directory === directory,
    )
    if (existingDraft) {
      setFallbackHome(false)
      tabs.setDraftPrompt(existingDraft.draftID, search.prompt)
      const active = tabs.active()
      if (active?.type !== "draft" || active.draftID !== existingDraft.draftID) tabs.select(existingDraft)
      return
    }
    if (creatingDraft || tabs.active() || tabs.pendingNavigation()) return
    setFallbackHome(false)
    creatingDraft = true
    layout.projects.open(directory)
    tabs.newDraft({ server: server.key, directory }, search.prompt)
  })

  return (
    <Show when={!fallbackHome()} fallback={<HomeRoute />}>
      <div class="size-full min-h-0 flex items-center justify-center bg-background-base text-text-base">
        <div class="text-13-regular text-text-weak">Opening composer...</div>
      </div>
    </Show>
  )
}

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.intl, t: language.t }}>{props.children}</I18nProvider>
}

declare global {
  interface Window {
    __OPENCODE__?: {
      deepLinks?: string[]
    }
    api?: {
      setTitlebar?: (theme: { mode: "light" | "dark" }) => Promise<void>
      exportDebugLogs?: () => Promise<string>
      reportFrameStall?: (report: { stallMs: number; focused: boolean; visibility: string }) => void
    }
  }
}

function QueryProvider(props: ParentProps) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnReconnect: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
      },
    },
  })
  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
}

function BodyDesignClass() {
  createEffect(() => {
    if (typeof document === "undefined") return

    document.body.classList.remove("text-12-regular")
    document.body.classList.add("font-(family-name:--font-family-text)", "text-[13px]", "font-[440]")
  })

  return null
}

// Server-agnostic providers shared across every route. These live in the shared
// shell (router root) so they stay mounted regardless of the active server/route.
function SharedProviders(props: ParentProps) {
  return (
    <SettingsProvider>
      <BodyDesignClass />
      <CommandProvider>
        <HighlightsProvider>{props.children}</HighlightsProvider>
      </CommandProvider>
    </SettingsProvider>
  )
}

function ActiveSessionRouteProvider(props: ParentProps) {
  const tabs = useTabs()
  const params = createMemo(() => {
    const tab = tabs.active()
    if (!tab || tab.type !== "session") return {}
    return { dir: tab.dirBase64, id: tab.sessionId }
  })
  return <SessionRouteProvider params={params}>{props.children}</SessionRouteProvider>
}

// Server-scoped providers plus the visual Layout (tabs/sidebar). These live inside
// each per-route server layout so they resolve to that route's server (selected vs
// draft). The Layout remounts when crossing between those groups.
function ServerScopedShell(props: ParentProps) {
  return (
    <ActiveSessionRouteProvider>
      <PermissionProvider>
        <LayoutProvider>
          <NotificationProvider>
            <ModelsProvider>
              <ModelChainSafetyReviewBridge />
              <FollowupQueueDrain />
              <AppPluginRuntimeProvider>
                <DesktopTestingHost />
                <ExtensionManager />
                <Layout>
                  <DockContentProvider>
                    <SessionDockShellHost>{props.children}</SessionDockShellHost>
                  </DockContentProvider>
                </Layout>
                <AppPluginLoadingOverlay />
              </AppPluginRuntimeProvider>
            </ModelsProvider>
          </NotificationProvider>
        </LayoutProvider>
      </PermissionProvider>
    </ActiveSessionRouteProvider>
  )
}

// The dock shell is server-scoped: it mounts once per server group and never
// remounts on session tab switches. The routed per-directory content renders
// as the shell's middle pane; the session subtree registers its header and
// side pane contents through the dock content registry. With no active tab
// (home) the routed content renders bare, matching the pre-shell behavior.
function SessionDockShellHost(props: ParentProps) {
  const tabs = useTabs()
  const dockContent = useDockContent()
  return (
    <Show when={tabs.active()} fallback={props.children}>
      <div class="relative size-full overflow-hidden flex flex-col">
        {dockContent.parts()?.header}
        <SessionDockShell middle={props.children} />
      </div>
    </Show>
  )
}

function SessionProviders(props: ParentProps) {
  return (
    <TerminalProvider>
      <FileProvider>
        <PromptProvider>
          <CommentsProvider>{props.children}</CommentsProvider>
        </PromptProvider>
      </FileProvider>
    </TerminalProvider>
  )
}

export function AppBaseProviders(props: ParentProps<{ locale?: Locale }>) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider
        onThemeApplied={(_, mode) => {
          void window.api?.setTitlebar?.({ mode })
        }}
      >
        <LanguageProvider locale={props.locale}>
          <UiI18nBridge>
            <PresentationWatchdog />
            <ErrorBoundary
              fallback={(error) => {
                Sentry.captureException(error)
                return <ErrorPage error={error} />
              }}
            >
              <QueryProvider>
                <WslServersProvider>
                  <DialogProvider>
                    <MarkedProvider>
                      <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
                    </MarkedProvider>
                  </DialogProvider>
                </WslServersProvider>
              </QueryProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

function ConnectionGate(props: ParentProps<{ disableHealthCheck?: boolean }>) {
  const server = useServer()
  const checkServerHealth = useCheckServerHealth()

  const [checkMode, setCheckMode] = createSignal<"blocking" | "background">("blocking")

  // performs repeated health check with a grace period for
  // non-http connections, otherwise fails instantly
  const [startupHealthCheck, healthCheckActions] = createResource(() =>
    props.disableHealthCheck
      ? true
      : Effect.gen(function* () {
          if (!server.current) return true
          const { http, type } = server.current

          while (true) {
            const res = yield* Effect.promise(() => checkServerHealth(http))
            if (res.healthy) return true
            if (checkMode() === "background" || type === "http") return false
          }
        }).pipe(
          Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(false) }),
          Effect.ensuring(Effect.sync(() => setCheckMode("background"))),
          Effect.runPromise,
        ),
  )
  const checking = createMemo(
    () => checkMode() === "blocking" && ["unresolved", "pending"].includes(startupHealthCheck.state),
  )

  return (
    <Show
      when={!checking()}
      fallback={
        <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
        </div>
      }
    >
      <Show
        when={startupHealthCheck.latest}
        fallback={
          <ConnectionError
            onRetry={() => {
              if (checkMode() === "background") void healthCheckActions.refetch()
            }}
            onServerSelected={(key) => {
              setCheckMode("blocking")
              server.setActive(key)
              void healthCheckActions.refetch()
            }}
          />
        }
      >
        {props.children}
      </Show>
    </Show>
  )
}

function ConnectionError(props: { onRetry?: () => void; onServerSelected?: (key: ServerConnection.Key) => void }) {
  const language = useLanguage()
  const server = useServer()
  const others = () => server.list.filter((s) => ServerConnection.key(s) !== server.key)
  const name = createMemo(() => server.name || server.key)
  const serverToken = "\u0000server\u0000"
  const unreachable = createMemo(() => language.t("app.server.unreachable", { server: serverToken }).split(serverToken))

  const timer = setInterval(() => props.onRetry?.(), 1000)
  onCleanup(() => clearInterval(timer))

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6">
      <div class="flex flex-col items-center max-w-md text-center">
        <Splash class="w-12 h-15 mb-4" />
        <p class="text-14-regular text-text-base">
          {unreachable()[0]}
          <span class="text-text-strong font-medium">{name()}</span>
          {unreachable()[1]}
        </p>
        <p class="mt-1 text-12-regular text-text-weak">{language.t("app.server.retrying")}</p>
      </div>
      <Show when={others().length > 0}>
        <div class="flex flex-col gap-2 w-full max-w-sm">
          <span class="text-12-regular text-text-base text-center">{language.t("app.server.otherServers")}</span>
          <div class="flex flex-col gap-1 bg-surface-base rounded-lg p-2">
            <For each={others()}>
              {(conn) => {
                const key = ServerConnection.key(conn)
                return (
                  <button
                    type="button"
                    class="flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                    onClick={() => props.onServerSelected?.(key)}
                  >
                    <span class="text-14-regular text-text-strong truncate">{serverName(conn)}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

export function AppInterface(props: {
  children?: JSX.Element
  defaultServer: ServerConnection.Key
  canonicalLocalServer?: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  router?: Component<BaseRouterProps>
  disableHealthCheck?: boolean
}) {
  // The shared shell holds only server-agnostic providers (QueryClient + Settings/
  // Command/Highlights) and stays mounted across every route. It must wrap GlobalProvider
  // because global server contexts can be created eagerly during startup. SessionFavorites
  // also stays mounted across routes but reads the Global context in its init, so it
  // mounts below GlobalProvider instead of inside the shared shell.
  const SharedShell = (shellProps: ParentProps) => (
    <QueryProvider>
      <SharedProviders>{shellProps.children}</SharedProviders>
    </QueryProvider>
  )

  return (
    <ServerProvider
      defaultServer={props.defaultServer}
      canonicalLocalServer={props.canonicalLocalServer}
      servers={props.servers}
    >
      <SharedShell>
        <GlobalProvider>
          <SessionFavoritesProvider>
            <ConnectionGate disableHealthCheck={props.disableHealthCheck}>
              <Dynamic
                component={props.router ?? Router}
                root={(routerProps) => (
                  <>
                    {props.children}
                    <RouterShell>{routerProps.children}</RouterShell>
                  </>
                )}
              >
                <Route path="/preview/:name?" component={PreviewRoute} />
                <Route path="*fallback" component={SessionRoute} />
              </Dynamic>
            </ConnectionGate>
          </SessionFavoritesProvider>
        </GlobalProvider>
      </SharedShell>
    </ServerProvider>
  )
}
