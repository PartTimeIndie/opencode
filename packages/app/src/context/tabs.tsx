import { createSimpleContext } from "@opencode-ai/ui/context"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { createStore, produce } from "solid-js/store"
import { Persist, persisted, removePersisted, draftPersistedKeys } from "@/utils/persist"
import { ServerConnection, useServer } from "./server"
import { createEffect, createSignal, startTransition } from "solid-js"
import { useLocation, useNavigate, useSearchParams } from "@solidjs/router"
import { usePlatform } from "./platform"
import { uuid } from "@/utils/uuid"
import { notifySessionTabReconciled, type SessionTabsRemovedDetail } from "@/components/titlebar-session-events"
import { clearDraftPromptState, createDraftPromptState } from "./prompt"
import { decode64 } from "@/utils/base64"
import { composerSendIntents } from "@/plugin/composer-send-intent"
import {
  draftHref,
  migrateStoredTabs,
  moveSessionTabs,
  nextRecentLocal,
  reconcileSessionTab,
  reorderTabs,
  sessionTabIdentity,
  sessionTabMatchesRemoved,
  sessionTabReplacementForKey,
  tabKey,
  type DraftTab,
  type SessionTab,
  type Tab,
} from "./tabs-domain"

function localServerAlias(key: ServerConnection.Key) {
  const match = /^(https?):\/\/(localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?$/i.exec(key)
  if (!match) return
  return `${match[1]!.toLowerCase()}:${match[3] ?? (match[1]!.toLowerCase() === "https" ? "443" : "80")}`
}

export {
  draftHref,
  moveSessionTabs,
  reorderTabs,
  sessionHasOpenTab,
  sessionTabDockPaneID,
  sessionTabMatchesRemoved,
  tabHref,
  tabKey,
} from "./tabs-domain"
export type { DraftTab, SessionTab, Tab } from "./tabs-domain"

type RecentTab = {
  key?: string
}

export const { use: useTabs, provider: TabsProvider } = createSimpleContext({
  name: "Tabs",
  gate: false,
  init: () => {
    const server = useServer()
    createEffect(() => {
      const active = server.key
      composerSendIntents.revoke((target) => target.serverID !== active)
    })
    const cancelPrepared = (tab: Tab) => composerSendIntents.revoke((target) =>
      target.serverID === tab.server && (tab.type === "draft"
        ? target.composerID === tab.draftID
        : target.sessionID === tab.sessionId && base64Encode(target.directory) === tab.dirBase64))
    const platform = usePlatform()
    const fallback = server.key
    const [store, setStore, _, ready] = persisted(
      {
        ...Persist.global("tabs"),
        migrate: (value: unknown) => migrateStoredTabs(value, fallback),
      },
      createStore<Tab[]>([]),
    )
    const [recent, setRecent, , recentReady] = persisted(Persist.global("tabs.recent"), createStore<RecentTab>({}))
    const [showHome, setShowHome] = createSignal(false)
    const [pendingNavigation, setPendingNavigation] = createSignal<Tab>()
    const [hydrated, setHydrated] = createSignal(false)
    setTimeout(() => setHydrated(true), 0)

    const navigate = useNavigate()
    const location = useLocation()
    const [searchParams, setSearchParams] = useSearchParams<{
      dir?: string
      prompt?: string
      server?: string
      session?: string
    }>()

    const closing = new Set<string>()
    const [recentLocal, setRecentLocal] = createSignal<{ loaded: boolean; write: number; key?: string }>({
      loaded: false,
      write: 0,
    })

    const recentKey = () => {
      const local = recentLocal()
      return local.loaded ? local.key : recent.key
    }

    const setRecentKey = (key: string | undefined) => {
      const next = nextRecentLocal(recentLocal(), key)
      if (!next) return
      setRecentLocal(next)
      if (recentReady()) {
        setRecent("key", key)
        return
      }
      void recentReady.promise?.then(() => {
        if (next.write === recentLocal().write) setRecent("key", key)
      })
    }

    createEffect(() => {
      if (!recentReady()) return
      setRecentLocal((current) => {
        if (current.loaded) return current
        return { loaded: true, write: current.write, key: recent.key }
      })
    })

    const removeDraftPersisted = (draftID: string) => {
      clearDraftPromptState(draftID)
      for (const key of draftPersistedKeys()) removePersisted(Persist.draft(draftID, key), platform)
    }

    const createDraft = (draft: Omit<DraftTab, "type" | "draftID">) => {
      const draftID = uuid()
      setStore(
        produce((tabs) => {
          tabs.push({ type: "draft", draftID, ...draft })
        }),
      )
      return draftID
    }

    const setDraftPrompt = (draftID: string, prompt?: string) => {
      if (!prompt) return
      createDraftPromptState(draftID, platform).set(
        [{ type: "text", content: prompt, start: 0, end: prompt.length }],
        prompt.length,
      )
    }

    createEffect(() => {
      if (!ready() || !hydrated() || !recentReady()) return
      // Keep tabs for the active server while the persisted server list is still hydrating.
      // The active connection is authoritative; pruning it during that gap drops the
      // selected session when Home navigation triggers the first reconciliation.
      const servers = new Set([server.key, ...server.list.map(ServerConnection.key)])
      const activeLocalAlias = localServerAlias(server.key)
      const next = store.filter(
        (tab) => servers.has(tab.server) || (activeLocalAlias && localServerAlias(tab.server) === activeLocalAlias),
      )
      if (next.length !== store.length) setStore(() => next)
      const selectedKey = recentKey()
      if (!selectedKey || next.some((tab) => tabKey(tab) === selectedKey)) return
      const replacement = sessionTabReplacementForKey(next, selectedKey)
      if (!replacement) {
        setRecentKey(undefined)
        return
      }
      setRecentKey(tabKey(replacement.next))
      queueMicrotask(() =>
        notifySessionTabReconciled({
          previous: [replacement.previous],
          next: replacement.next,
        }),
      )
    })

    createEffect(() => {
      const pending = pendingNavigation()
      if (location.pathname !== "/" || !pending) return
      const current = active()
      if (current && tabKey(current) === tabKey(pending)) setPendingNavigation(undefined)
    })

    const ensureRoot = () => {
      if (location.pathname === "/") return
      navigate("/", { replace: true })
    }

    const navigateTab = (tab: Tab) => {
      const navigation =
        tab.type === "draft"
          ? { directory: tab.directory }
          : { directory: atob(tab.dirBase64), sessionID: tab.sessionId }
      const directSessionRoute =
        tab.type === "session" &&
        (() => {
          const match = /^\/([^/]+)\/session\/([^/]+)\/?$/.exec(location.pathname)
          return match?.[1] === tab.dirBase64 && match?.[2] === tab.sessionId
        })()
      if (tab.server === server.key) {
        if (!directSessionRoute) {
          setPendingNavigation(tab)
          ensureRoot()
        }
      } else {
        setPendingNavigation(tab)
        ensureRoot()
      }
      setShowHome(false)
      setRecentKey(tabKey(tab))
      window.dispatchEvent(new CustomEvent("opencode:navigation-activated", { detail: navigation }))
      if (tab.server !== server.key) void startTransition(() => server.setActive(tab.server))
    }

    const active = () => {
      if (showHome()) return
      const pending = pendingNavigation()
      const pendingTab = pending && store.find((tab) => tabKey(tab) === tabKey(pending))
      if (pendingTab) return pendingTab
      const key = recentKey()
      return (key && store.find((tab) => tabKey(tab) === key)) || store[0]
    }

    const actions = {
      openSessionTab: (tab: Omit<SessionTab, "type">, options?: { activate?: boolean }) => {
        const next = { type: "session" as const, ...tab }
        const identity = sessionTabIdentity(next)
        if (closing.has(identity)) return
        const previous = store.filter(
          (item): item is SessionTab => item.type === "session" && sessionTabIdentity(item) === identity,
        )
        const recentMatched = store.some(
          (item) => item.type === "session" && sessionTabIdentity(item) === identity && tabKey(item) === recentKey(),
        )
        setStore((tabs) => reconcileSessionTab(tabs, next))
        const resolved = store.find(
          (item): item is SessionTab => item.type === "session" && sessionTabIdentity(item) === identity,
        )
        if (!resolved) return
        if (previous.some((item) => tabKey(item) !== tabKey(resolved))) {
          notifySessionTabReconciled({ previous, next: resolved })
        }
        if (options?.activate === false) {
          if (recentMatched) setRecentKey(tabKey(resolved))
          return resolved
        }
        navigateTab(resolved)
        return resolved
      },
      markSessionUsed(input: {
        server?: ServerConnection.Key
        directory?: string
        dirBase64?: string
        sessionID: string
      }) {
        const identity = sessionTabIdentity({ server: input.server ?? server.key, sessionId: input.sessionID })
        setStore(
          produce((tabs) => {
            const tab = tabs.find((item) => item.type === "session" && sessionTabIdentity(item) === identity)
            if (tab?.type === "session") tab.createdEmpty = false
          }),
        )
      },
      draft(draftID: string) {
        const tab = store.find((item) => item.type === "draft" && item.draftID === draftID)
        if (!tab || tab.type !== "draft") throw new Error(`Draft not found: ${draftID}`)
        return tab
      },
      createDraft,
      setDraftPrompt,
      newDraft(draft: Omit<DraftTab, "type" | "draftID">, prompt?: string, options?: { navigate?: boolean }) {
        const draftID = createDraft(draft)
        setDraftPrompt(draftID, prompt)
        if (options?.navigate !== false) navigateTab({ type: "draft", draftID, ...draft })
        return draftID
      },
      updateDraft(draftID: string, draft: Partial<Omit<DraftTab, "type" | "draftID">>) {
        setStore(
          (tab) => tab.type === "draft" && tab.draftID === draftID,
          produce((tab) => Object.assign(tab, draft)),
        )
      },
      promoteDraft(draftID: string, session: Omit<SessionTab, "type">) {
        // We're viewing this draft when /new-session?draftId=… points at it. Promoting
        // replaces the draft tab with a session tab, so the draft route would stop resolving
        // and fall back home. Navigate to the new session first so we leave /new-session
        // before the draft is removed from the store.
        const active = location.query.draftId === draftID
        const next = { type: "session" as const, ...session }
        startTransition(() => {
          setStore((tabs) =>
            reconcileSessionTab(
              tabs.map((tab) => (tab.type === "draft" && tab.draftID === draftID ? next : tab)),
              next,
            ),
          )
          if (active || recentKey() === `draft:${draftID}`) setRecentKey(tabKey(next))
          if (active) navigateTab(next)
        })
        removeDraftPersisted(draftID)
      },
      moveTab(fromKey: string, toKey: string) {
        setStore((tabs) => reorderTabs(tabs, fromKey, toKey))
      },
      removeTab: (index: number) => {
        const tab = store[index]
        if (!tab) return
        cancelPrepared(tab)
        const key = tabKey(tab)
        const closingKey = tab.type === "session" ? sessionTabIdentity(tab) : key
        const draftID = tab.type === "draft" ? tab.draftID : undefined
        closing.add(closingKey)
        const transition = startTransition(() => {
          const currentIndex = store.findIndex((item) => tabKey(item) === key)
          if (currentIndex === -1) return
          const nextTab = store[currentIndex + 1] ?? store[currentIndex - 1]
          setStore(
            produce((tabs) => {
              const index = tabs.findIndex((item) => tabKey(item) === key)
              if (index !== -1) tabs.splice(index, 1)
            }),
          )
          if (recent.key === key) setRecentKey(nextTab && tabKey(nextTab))
          if (nextTab) navigateTab(nextTab)
          else ensureRoot()
        }).finally(() => closing.delete(closingKey))
        if (draftID) removeDraftPersisted(draftID)
        return transition
      },
      removeTabs: (keys: string[]) => {
        const removed = store.filter((tab) => keys.includes(tabKey(tab)))
        removed.forEach(cancelPrepared)
        if (removed.length === 0) return
        const removedKeys = new Set(removed.map(tabKey))
        const closingKeys = new Set(
          removed.map((tab) => (tab.type === "session" ? sessionTabIdentity(tab) : tabKey(tab))),
        )
        for (const key of closingKeys) closing.add(key)
        const current = active()
        const currentKey = current && tabKey(current)
        if (current && currentKey && removedKeys.has(currentKey)) setPendingNavigation(current)
        const transition = startTransition(() => {
          const currentIndex = current ? store.findIndex((tab) => tabKey(tab) === currentKey) : -1
          const nextTab =
            currentIndex === -1
              ? undefined
              : (store.slice(currentIndex + 1).find((tab) => !removedKeys.has(tabKey(tab))) ??
                store.slice(0, currentIndex).findLast((tab) => !removedKeys.has(tabKey(tab))))
          setStore(
            produce((tabs) => {
              for (let i = tabs.length - 1; i >= 0; i--) {
                if (removedKeys.has(tabKey(tabs[i]))) tabs.splice(i, 1)
              }
            }),
          )
          if (recent.key && removedKeys.has(recent.key)) setRecentKey(nextTab && tabKey(nextTab))
          if (currentKey && removedKeys.has(currentKey)) {
            if (nextTab) navigateTab(nextTab)
            else ensureRoot()
          }
        }).finally(() => {
          for (const key of closingKeys) closing.delete(key)
        })
        for (const tab of removed) if (tab.type === "draft") removeDraftPersisted(tab.draftID)
        return transition
      },
      removeServer(key: ServerConnection.Key) {
        composerSendIntents.revoke((target) => target.serverID === key)
        const drafts = store.flatMap((tab) => (tab.type === "draft" && tab.server === key ? [tab.draftID] : []))
        const removed = store.filter((tab) => tab.server === key).map(tabKey)
        setStore((tabs) => tabs.filter((tab) => tab.server !== key))
        if (recent.key && removed.includes(recent.key)) setRecentKey(undefined)
        for (const draftID of drafts) removeDraftPersisted(draftID)
        if (server.key === key) navigate("/")
      },
      removeSessions: (input: SessionTabsRemovedDetail) => {
        const sessionIDs = new Set(input.sessionIDs)
        composerSendIntents.revoke((target) => target.serverID === input.server && target.directory === input.directory && !!target.sessionID && sessionIDs.has(target.sessionID))
        const removed = store
          .filter((tab) =>
            sessionTabMatchesRemoved(tab, { server: input.server, directory: input.directory, sessionIDs }),
          )
          .map(tabKey)
        void startTransition(() => {
          setStore(
            produce((tabs) => {
              const current = active()
              const currentIndex = current ? tabs.findIndex((tab) => tabKey(tab) === tabKey(current)) : -1
              const currentTab = tabs[currentIndex]
              const removedCurrent = sessionTabMatchesRemoved(currentTab, {
                server: input.server,
                directory: input.directory,
                sessionIDs,
              })

              for (let i = tabs.length - 1; i >= 0; i--) {
                if (
                  !sessionTabMatchesRemoved(tabs[i], { server: input.server, directory: input.directory, sessionIDs })
                )
                  continue
                tabs.splice(i, 1)
              }

              if (!removedCurrent) return
              const nextTab =
                tabs.slice(currentIndex).find((tab) => tab.type === "session") ??
                tabs.slice(0, currentIndex).findLast((tab) => tab.type === "session")
              if (nextTab) navigateTab(nextTab)
              else ensureRoot()
            }),
          )
          if (recent.key && removed.includes(recent.key)) setRecentKey(undefined)
        })
      },
      moveSessions: (input: {
        fromDirectory: string
        toDirectory: string
        sessionIDs: string[]
        selectSessionID?: string
      }) => {
        const sessionIDs = new Set(input.sessionIDs)
        const nextDirBase64 = base64Encode(input.toDirectory)
        const recentTab = store.find(
          (tab): tab is SessionTab =>
            tab.type === "session" &&
            tab.server === server.key &&
            atob(tab.dirBase64) === input.fromDirectory &&
            sessionIDs.has(tab.sessionId) &&
            tabKey(tab) === recent.key,
        )
        const current = active()
        const currentMoved =
          current?.type === "session" &&
          current.server === server.key &&
          atob(current.dirBase64) === input.fromDirectory &&
          sessionIDs.has(current.sessionId)
        setStore((tabs) =>
          moveSessionTabs(tabs, {
            server: server.key,
            fromDirectory: input.fromDirectory,
            toDirectory: input.toDirectory,
            sessionIDs: input.sessionIDs,
          }),
        )
        if (recentTab) setRecentKey(tabKey({ ...recentTab, dirBase64: nextDirBase64 }))
        if (input.selectSessionID) {
          navigateTab({
            type: "session",
            server: server.key,
            dirBase64: nextDirBase64,
            sessionId: input.selectSessionID,
          })
          return
        }
        if (currentMoved && current?.type === "session") {
          navigateTab({ ...current, dirBase64: nextDirBase64 })
        }
      },
      select: navigateTab,
      active,
      home: showHome,
      last: active,
      remember(tab: Tab) {
        const key = tabKey(tab)
        const current = active()
        if (current?.type === "draft" && tab.type === "session") return
        const pending = pendingNavigation()
        if (pending && tabKey(pending) !== key) return
        if (recentKey() !== key) setRecentKey(key)
      },
      toggleHome(input: { home: boolean; current?: Tab }) {
        if (input.home) {
          const tab = store.find((tab) => tabKey(tab) === recentKey())
          if (tab) navigateTab(tab)
          return
        }
        if (input.current) setRecentKey(tabKey(input.current))
        setShowHome(true)
        ensureRoot()
        window.dispatchEvent(new CustomEvent("opencode:navigation-activated", { detail: {} }))
      },
    }

    createEffect(() => {
      if (!ready() || !hydrated() || !recentReady()) return
      const sessionId = searchParams.session
      const dirBase64 = searchParams.dir
      if (!dirBase64) return

      const targetServer = searchParams.server ? ServerConnection.Key.make(searchParams.server) : server.key
      const directory = sessionId ? undefined : decode64(dirBase64)
      const prompt = searchParams.prompt
      if (sessionId) actions.openSessionTab({ server: targetServer, dirBase64, sessionId })
      if (directory) actions.newDraft({ server: targetServer, directory }, prompt)
      setSearchParams(
        { dir: undefined, prompt: sessionId ? searchParams.prompt : undefined, server: undefined, session: undefined },
        { replace: true },
      )
    })

    return { ...actions, store, ready: () => ready() && hydrated(), recentReady, pendingNavigation }
  },
})
