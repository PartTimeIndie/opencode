import { createStore, reconcile } from "solid-js/store"
import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useServerSDK } from "./server-sdk"
import { useServerSync } from "./server-sync"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { Binary } from "@opencode-ai/core/util/binary"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { decode64 } from "@/utils/base64"
import type { EventSessionError, EventSessionIdle } from "@opencode-ai/sdk/v2"
import { Persist, persisted } from "@/utils/persist"
import { playSoundById } from "@/utils/sound"
import { useSessionRoute } from "@/context/session-route"
import { sessionNotificationEvent } from "./notification-event"
import { useSessionAttention } from "./session-attention"
import { attentionKey } from "@/session-attention/identity"
import { useServer } from "./server"

type NotificationBase = {
  directory?: string
  session?: string
  metadata?: unknown
  time: number
  viewed: boolean
}

type TurnCompleteNotification = NotificationBase & {
  type: "turn-complete"
}

type ErrorNotification = NotificationBase & {
  type: "error"
  error: EventSessionError["properties"]["error"]
}

export type Notification = TurnCompleteNotification | ErrorNotification

type NotificationIndex = {
  session: {
    all: Record<string, Notification[]>
    unseen: Record<string, Notification[]>
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
  }
  project: {
    all: Record<string, Notification[]>
    unseen: Record<string, Notification[]>
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
  }
}

const MAX_NOTIFICATIONS = 500
const NOTIFICATION_TTL_MS = 1000 * 60 * 60 * 24 * 30

function pruneNotifications(list: Notification[]) {
  const cutoff = Date.now() - NOTIFICATION_TTL_MS
  const pruned = list.filter((n) => n.time >= cutoff)
  if (pruned.length <= MAX_NOTIFICATIONS) return pruned
  return pruned.slice(pruned.length - MAX_NOTIFICATIONS)
}

function createNotificationIndex(): NotificationIndex {
  return {
    session: {
      all: {},
      unseen: {},
      unseenCount: {},
      unseenHasError: {},
    },
    project: {
      all: {},
      unseen: {},
      unseenCount: {},
      unseenHasError: {},
    },
  }
}

function buildNotificationIndex(list: Notification[]) {
  const index = createNotificationIndex()

  list.forEach((notification) => {
    if (notification.session) {
      const all = index.session.all[notification.session] ?? []
      index.session.all[notification.session] = [...all, notification]
      if (!notification.viewed) {
        const unseen = index.session.unseen[notification.session] ?? []
        index.session.unseen[notification.session] = [...unseen, notification]
        index.session.unseenCount[notification.session] = unseen.length + 1
        if (notification.type === "error") index.session.unseenHasError[notification.session] = true
      }
    }

    if (notification.directory) {
      const all = index.project.all[notification.directory] ?? []
      index.project.all[notification.directory] = [...all, notification]
      if (!notification.viewed) {
        const unseen = index.project.unseen[notification.directory] ?? []
        index.project.unseen[notification.directory] = [...unseen, notification]
        index.project.unseenCount[notification.directory] = unseen.length + 1
        if (notification.type === "error") index.project.unseenHasError[notification.directory] = true
      }
    }
  })

  return index
}

export const { use: useNotification, provider: NotificationProvider } = createSimpleContext({
  name: "Notification",
  gate: false,
  init: () => {
    const params = useSessionRoute()
    const serverSDK = useServerSDK()
    const serverSync = useServerSync()
    const platform = usePlatform()
    const settings = useSettings()
    const language = useLanguage()
    const attention = useSessionAttention()
    const server = useServer()

    const empty: Notification[] = []

    const currentDirectory = createMemo(() => {
      return decode64(params.dir)
    })

    const currentSession = createMemo(() => params.id)

    const [store, setStore, _, ready] = persisted(
      Persist.serverGlobal(serverSDK().scope, "notification", ["notification.v1"]),
      createStore({
        list: [] as Notification[],
      }),
    )
    const [index, setIndex] = createStore<NotificationIndex>(buildNotificationIndex(store.list))

    const meta = { pruned: false, disposed: false }

    const updateUnseen = (scope: "session" | "project", key: string, unseen: Notification[]) => {
      setIndex(scope, "unseen", key, unseen)
      setIndex(scope, "unseenCount", key, unseen.length)
      setIndex(
        scope,
        "unseenHasError",
        key,
        unseen.some((notification) => notification.type === "error"),
      )
    }

    const appendToIndex = (notification: Notification) => {
      if (notification.session) {
        setIndex("session", "all", notification.session, (all = []) => [...all, notification])
        if (!notification.viewed) {
          setIndex("session", "unseen", notification.session, (unseen = []) => [...unseen, notification])
          setIndex("session", "unseenCount", notification.session, (count = 0) => count + 1)
          if (notification.type === "error") setIndex("session", "unseenHasError", notification.session, true)
        }
      }

      if (notification.directory) {
        setIndex("project", "all", notification.directory, (all = []) => [...all, notification])
        if (!notification.viewed) {
          setIndex("project", "unseen", notification.directory, (unseen = []) => [...unseen, notification])
          setIndex("project", "unseenCount", notification.directory, (count = 0) => count + 1)
          if (notification.type === "error") setIndex("project", "unseenHasError", notification.directory, true)
        }
      }
    }

    const removeFromIndex = (notification: Notification) => {
      if (notification.session) {
        setIndex("session", "all", notification.session, (all = []) => all.filter((n) => n !== notification))
        if (!notification.viewed) {
          const unseen = (index.session.unseen[notification.session] ?? empty).filter((n) => n !== notification)
          updateUnseen("session", notification.session, unseen)
        }
      }

      if (notification.directory) {
        setIndex("project", "all", notification.directory, (all = []) => all.filter((n) => n !== notification))
        if (!notification.viewed) {
          const unseen = (index.project.unseen[notification.directory] ?? empty).filter((n) => n !== notification)
          updateUnseen("project", notification.directory, unseen)
        }
      }
    }

    createEffect(() => {
      if (!ready()) return
      if (meta.pruned) return
      meta.pruned = true
      const list = pruneNotifications(store.list)
      batch(() => {
        setStore("list", list)
        setIndex(reconcile(buildNotificationIndex(list), { merge: false }))
      })
    })

    const append = (notification: Notification) => {
      const list = pruneNotifications([...store.list, notification])
      const keep = new Set(list)
      const removed = store.list.filter((n) => !keep.has(n))

      batch(() => {
        if (keep.has(notification)) appendToIndex(notification)
        removed.forEach((n) => removeFromIndex(n))
        setStore("list", list)
      })
    }

    const lookup = async (directory: string, sessionID?: string) => {
      if (!sessionID) return undefined
      const [syncStore] = serverSync().child(directory, { bootstrap: false })
      const match = Binary.search(syncStore.session, sessionID, (s) => s.id)
      if (match.found) return syncStore.session[match.index]
      return serverSDK()
        .client.session.get({ directory, sessionID })
        .then((x) => x.data)
        .catch(() => undefined)
    }

    const viewedInCurrentSession = (directory: string, sessionID?: string) => {
      const activeDirectory = currentDirectory()
      const activeSession = currentSession()
      if (!activeDirectory) return false
      if (!activeSession) return false
      if (!sessionID) return false
      if (directory !== activeDirectory) return false
      return sessionID === activeSession
    }

    const prioritySystem = new Map<string, { directory: string; sessionID: string; title: string; href: string; error: boolean }>()
    let priorityTimer: ReturnType<typeof setTimeout> | undefined
    const queuePrioritySystem = (directory: string, sessionID: string, title: string, href: string, error: boolean) => {
      prioritySystem.set(attentionKey(server.key, directory, sessionID), { directory, sessionID, title, href, error })
      if (priorityTimer) return
      priorityTimer = setTimeout(async () => {
        priorityTimer = undefined
        if (meta.disposed) return
        const candidates = [...prioritySystem.values()].filter((item) =>
          attention.enabled() && attention.current(item)?.enabled && attention.current(item)?.count && !attention.visible(item))
        prioritySystem.clear()
        const items = (await Promise.all(candidates.map(async (item) => {
          if (!platform.sessionAttention) return item
          try { return await platform.sessionAttention.isVisible(attention.key(item)) ? undefined : item }
          catch { return undefined }
        }))).filter((item) => !!item)
        if (meta.disposed || !attention.enabled() || !items.length ||
          !(settings.notifications.agent() || settings.notifications.errors())) return
        const first = items[0]!
        void platform.notify(items.length === 1
          ? language.t(first.error ? "session.attention.toast.failed" : "session.attention.toast.completed")
          : language.t("session.attention.toast.multiple", { count: items.length }),
          items.length === 1 ? first.title : language.t("session.attention.toast.open"), first.href, { always: true })
      }, 1000)
    }

    const handleSessionIdle = (directory: string, event: { properties: { sessionID?: string } }, time: number) => {
      const sessionID = event.properties.sessionID
      void lookup(directory, sessionID).then(async (session) => {
        if (meta.disposed) return
        if (!session) return
        if (session.parentID) return

        if (settings.sounds.agentEnabled()) {
          void playSoundById(settings.sounds.agent())
        }

        append({
          directory,
          time,
          viewed: viewedInCurrentSession(directory, sessionID),
          type: "turn-complete",
          session: sessionID,
        })

        const href = `/${base64Encode(directory)}/session/${sessionID}`
        const priority = attention.enabled() && !!sessionID && !!attention.current({ directory, sessionID })?.enabled
        const fresh = priority ? await attention.refresh({ directory, sessionID }, true) : false
        if (settings.notifications.agent() && !meta.disposed) {
          if (priority && fresh) queuePrioritySystem(directory, sessionID, session.title ?? sessionID, href, false)
          if (!priority) void platform.notify(language.t("notification.session.responseReady.title"), session.title ?? sessionID, href)
        }
      })
    }

    const handleSessionError = (
      directory: string,
      event: { properties: { sessionID?: string; error?: EventSessionError["properties"]["error"] } },
      time: number,
    ) => {
      const sessionID = event.properties.sessionID
      void lookup(directory, sessionID).then(async (session) => {
        if (meta.disposed) return
        if (session?.parentID) return

        if (settings.sounds.errorsEnabled()) {
          void playSoundById(settings.sounds.errors())
        }

        const error = "error" in event.properties ? event.properties.error : undefined
        append({
          directory,
          time,
          viewed: viewedInCurrentSession(directory, sessionID),
          type: "error",
          session: sessionID ?? "global",
          error,
        })
        const description =
          session?.title ??
          (typeof error === "string" ? error : language.t("notification.session.error.fallbackDescription"))
        const href = sessionID ? `/${base64Encode(directory)}/session/${sessionID}` : `/${base64Encode(directory)}`
        const priority = attention.enabled() && !!sessionID && !!attention.current({ directory, sessionID })?.enabled
        const fresh = priority && sessionID ? await attention.refresh({ directory, sessionID }, true) : false
        if (settings.notifications.errors() && !meta.disposed) {
          if (priority && fresh && sessionID) queuePrioritySystem(directory, sessionID, session?.title ?? sessionID, href, true)
          if (!priority) void platform.notify(language.t("notification.session.error.title"), description, href, { always: true })
        }
      })
    }

    const terminalEvents = new Set<string>()
    const handleTerminalEvent = (
      directory: string,
      event: { type: string; properties?: unknown },
      id?: string,
    ) => {
      const type = sessionNotificationEvent(event)
      if (!type) return

      if (id) {
        const key = `${directory}\n${id}`
        if (terminalEvents.has(key)) return
        terminalEvents.add(key)
        const oldest = terminalEvents.size > 256 ? terminalEvents.values().next().value : undefined
        if (oldest) terminalEvents.delete(oldest)
      }

      const time = Date.now()
      if (type === "idle") {
        handleSessionIdle(directory, event as EventSessionIdle, time)
        return
      }
      handleSessionError(directory, event as EventSessionError, time)
    }

    const unsub = serverSDK().event.listen((e) => {
      const event = e.details
      handleTerminalEvent(
        e.name,
        event,
        "id" in event && typeof event.id === "string" ? event.id : undefined,
      )
    })
    const unsubSync = serverSDK().sync.listen((e) => {
      handleTerminalEvent(
        e.name,
        { type: e.details.syncEvent.type, properties: e.details.syncEvent.data },
        e.details.syncEvent.id,
      )
    })
    onCleanup(() => {
      meta.disposed = true
      if (priorityTimer) clearTimeout(priorityTimer)
      prioritySystem.clear()
      unsub()
      unsubSync()
    })

    return {
      ready,
      session: {
        all(session: string) {
          return index.session.all[session] ?? empty
        },
        unseen(session: string) {
          return index.session.unseen[session] ?? empty
        },
        unseenCount(session: string) {
          return index.session.unseenCount[session] ?? 0
        },
        unseenHasError(session: string) {
          return index.session.unseenHasError[session] ?? false
        },
        markViewed(session: string) {
          const unseen = index.session.unseen[session] ?? empty
          if (!unseen.length) return

          const projects = [
            ...new Set(unseen.flatMap((notification) => (notification.directory ? [notification.directory] : []))),
          ]
          batch(() => {
            setStore("list", (n) => n.session === session && !n.viewed, "viewed", true)
            updateUnseen("session", session, [])
            projects.forEach((directory) => {
              const next = (index.project.unseen[directory] ?? empty).filter(
                (notification) => notification.session !== session,
              )
              updateUnseen("project", directory, next)
            })
          })
        },
      },
      project: {
        all(directory: string) {
          return index.project.all[directory] ?? empty
        },
        unseen(directory: string) {
          return index.project.unseen[directory] ?? empty
        },
        unseenCount(directory: string) {
          return index.project.unseenCount[directory] ?? 0
        },
        unseenHasError(directory: string) {
          return index.project.unseenHasError[directory] ?? false
        },
        markViewed(directory: string) {
          const unseen = index.project.unseen[directory] ?? empty
          if (!unseen.length) return

          const sessions = [
            ...new Set(unseen.flatMap((notification) => (notification.session ? [notification.session] : []))),
          ]
          batch(() => {
            setStore("list", (n) => n.directory === directory && !n.viewed, "viewed", true)
            updateUnseen("project", directory, [])
            sessions.forEach((session) => {
              const next = (index.session.unseen[session] ?? empty).filter(
                (notification) => notification.directory !== directory,
              )
              updateUnseen("session", session, next)
            })
          })
        },
      },
    }
  },
})
