import type { Message, UserMessage } from "@opencode-ai/sdk/v2"
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createEffect, createMemo, createResource, createSignal, onCleanup, untrack, type Accessor } from "solid-js"
import {
  activeSessionReadyForBackgroundPrefetch,
  getSessionPrefetch,
  SESSION_PREFETCH_TTL,
} from "@/context/global-sync/session-prefetch"
import { SESSION_MESSAGE_REOPEN_LIMIT } from "@/context/global-sync/session-message-window"
import { isSessionNotFoundError } from "@/context/directory-sync"
import { isSessionMessageRequestTimeoutError } from "@/context/session-message-request"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { ServerConnection } from "@/context/server"
import { useSync } from "@/context/sync"
import { sessionActivity } from "@/utils/session-activity"
import { same } from "@/utils/same"
import { compareMessageTime } from "@/utils/message-order"
import { rollbackUsersBefore } from "@/pages/session/rollback-state"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"

const emptyUserMessages: UserMessage[] = []
// Session routes unmount across directory switches, but reconnect recovery must remain deferred
// for a previously opened tab until that tab becomes active again.
const timelineReconnectGenerations = new Map<string, number>()
export type UserMessageWindowOptions = {
  limit: number
  before: number
  targetID?: string
}

export type SessionNotFoundDetail = {
  server: ServerConnection.Key
  directory: string
  error: unknown
  sessionID: string
}

function timelineReconnectRecovery(input: {
  active: boolean
  generation: number
  seen: number | undefined
}) {
  if (!input.active) return { load: false, recover: false, seen: input.seen }
  return {
    load: true,
    recover: input.seen !== undefined && input.generation !== input.seen,
    seen: input.generation,
  }
}

export function timelineReconnectRecoveryForSession(input: {
  active: boolean
  directory: string
  generation: number
  scope: ServerScope
  sessionID: string
}) {
  const key = ScopedKey.from(input.scope, input.directory, input.sessionID)
  const recovery = timelineReconnectRecovery({
    active: input.active,
    generation: input.generation,
    seen: timelineReconnectGenerations.get(key),
  })
  if (recovery.load) timelineReconnectGenerations.set(key, input.generation)
  return recovery
}

const timelineAutoResumeKey = (server: ServerConnection.Key, directory: string, sessionID: string) =>
  `${server}\n${directory}\n${sessionID}`

export function isSessionPrefetchStale(info: { at: number } | undefined, now = Date.now()) {
  return !info || now - info.at > SESSION_PREFETCH_TTL
}

export const TIMELINE_AUTO_RESUME_DELAY_MS = 10_000
export const TIMELINE_AUTO_RESUME_MAX_DELAY_MS = 60_000
export const TIMELINE_AUTO_RESUME_PROBE_TIMEOUT_MS = 5_000

// The event stream is the fast path for a busy session, but it can silently stall
// (SSE saturation ends streams server-side; reconnect recovery only reruns on the
// next generation change). The active tab therefore reconciles its timeline from
// the server on a slow interval while the session is busy, so a stalled pipeline
// can no longer freeze the visible agent output until a manual tab switch.
export const SESSION_BUSY_CATCH_UP_INTERVAL_MS = 5_000

export function shouldCatchUpBusySessionTimeline(input: {
  active: boolean
  sessionID: string | undefined
  statusType: string | undefined
  activityType: string | undefined
}) {
  if (!input.sessionID) return false
  if (!input.active) return false
  return (input.statusType ?? "idle") !== "idle" || input.activityType === "busy"
}

export function isRecoverableTimelineLoadError(error: unknown) {
  if (isSessionMessageRequestTimeoutError(error)) return true
  if (!(error instanceof Error)) return false
  const status =
    typeof error.cause === "object" && error.cause !== null
      ? (error.cause as { status?: unknown }).status
      : undefined
  if (typeof status === "number") return status === 408 || status === 499 || (status >= 500 && status < 600)
  if (error.name === "AbortError") return false
  return error instanceof TypeError || /network|fetch|econnreset|econnrefused|timedout/i.test(error.message)
}

export function shouldAutoResumeTimelineLoad(input: {
  active: boolean
  cached: boolean
  timedOut: boolean
}) {
  return input.active && input.timedOut && !input.cached
}

// Default-Probe über die echte projektspezifische SDK-Grenze: genau ein
// v2.session.messages({sessionID, limit:1}) mit 5s-Abbruch. Global-Health
// allein genügt nicht — erst die Message-Route beweist Recovery.
export function timelineAutoResumeProbe(input: {
  client: Pick<ReturnType<typeof createOpencodeClient>, "v2">
  sessionID: string
  timeoutMs?: number
}) {
  return input.client.v2.session
    .messages(
      { sessionID: input.sessionID, limit: 1 },
      { signal: AbortSignal.timeout(input.timeoutMs ?? TIMELINE_AUTO_RESUME_PROBE_TIMEOUT_MS) },
    )
    .then((result) => !(result as { error?: unknown }).error)
    .catch(() => false)
}

// Retry a timed-out initial load only after its project-scoped message route responds.
// Backoff caps at one minute and stays armed until the load succeeds or the user switches
// sessions, so a long outage cannot leave the selected timeline stuck permanently.
export function createTimelineAutoResume(input: { probe: (sessionID: string) => Promise<boolean>; resume: () => void }) {
  let episode:
    | { key: string; sessionID: string; attempts: number; cached: boolean; timedOut: boolean; ready: () => boolean }
    | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const stop = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  const settle = (current: NonNullable<typeof episode>, healthy: boolean) => {
    if (episode !== current) return
    if (!healthy) {
      armEpisode({
        active: true,
        cached: current.cached,
        key: current.key,
        sessionID: current.sessionID,
        ready: current.ready,
        timedOut: current.timedOut,
      })
      return
    }
    if (!current.ready()) {
      episode = undefined
      return
    }
    // Keep the episode's attempt count so repeated failures use the capped backoff.
    input.resume()
  }

  const run = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const current = episode
    if (!current || !current.ready()) return
    current.attempts += 1
    void input.probe(current.sessionID).then(
      (healthy) => settle(current, healthy),
      () => settle(current, false),
    )
  }

  const armEpisode = (next: {
    active: boolean
    cached: boolean
    key: string
    sessionID: string
    ready: () => boolean
    timedOut: boolean
  }) => {
    stop()
    const current = {
      key: next.key,
      sessionID: next.sessionID,
      cached: next.cached,
      timedOut: next.timedOut,
      ready: next.ready,
      attempts: episode?.key === next.key ? episode.attempts : 0,
    }
    // The episode object stays as the budget tombstone even when the gate blocks the next
    // probe, so repeated failures can never restart a fresh unbounded cycle; only a
    // successful load, a manual retry or a timeline switch clears it.
    episode = current
    if (
      !shouldAutoResumeTimelineLoad({
        active: next.active,
        cached: current.cached,
        timedOut: current.timedOut,
      })
    ) return
    timer = setTimeout(run, Math.min(TIMELINE_AUTO_RESUME_DELAY_MS * 2 ** current.attempts, TIMELINE_AUTO_RESUME_MAX_DELAY_MS))
  }

  return {
    arm: (next: { key: string; sessionID: string; cached: boolean; active: boolean; error: unknown; ready: () => boolean }) =>
      armEpisode({ ...next, timedOut: isRecoverableTimelineLoadError(next.error) }),
    pending: () => timer !== undefined,
    reset: () => {
      stop()
      episode = undefined
    },
    stop,
  }
}

export function createTimelineModel(input: {
  sessionID: Accessor<string | undefined>
  revertMessageID: Accessor<string | undefined>
  active?: Accessor<boolean>
  onSessionNotFound?: (input: SessionNotFoundDetail) => void
  probe?: (sessionID: string) => Promise<boolean>
}) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const sync = useSync()
  const [loadError, setLoadError] = createSignal<SessionNotFoundDetail>()
  let refreshFrame: number | undefined
  let refreshTimer: number | undefined
  let activeTimeline:
    | { server: ServerConnection.Key; directory: string; sessionID: string; sessionSync: ReturnType<typeof sync> }
    | undefined

  createEffect(() => {
    const id = input.sessionID()
    const current = serverSDK()
    const next = id
      ? {
          server: ServerConnection.key(current.server),
          directory: sdk().directory,
          sessionID: id,
          sessionSync: sync(),
        }
      : undefined
    const previous = activeTimeline
    if (
      previous?.server === next?.server &&
      previous?.directory === next?.directory &&
      previous?.sessionID === next?.sessionID
    )
      return
    if (next) next.sessionSync.session.retain(next.sessionID, next.directory)
    activeTimeline = next
    if (!previous) return
    previous.sessionSync.session.release(previous.sessionID, previous.directory)
    if (!shouldReleaseTimeline(previous, next)) return
    previous.sessionSync.session.releaseTimeline(previous.sessionID, previous.directory)
  })

  const autoResume = createTimelineAutoResume({
    probe: input.probe ?? ((sessionID) => {
      const sdkContext = serverSDK()
      const directory = sdk().directory
      // Kein refcounted Dir-Context: Probe läuft im ownerlosen Timer, dessen
      // onCleanup nie registriert würde. createClient ist refcount-frei und
      // trägt denselben Directory-Scope.
      return timelineAutoResumeProbe({
        client: sdkContext.createClient({ directory, throwOnError: true }),
        sessionID,
      })
    }),
    resume: () => {
      void resourceActions.refetch()
    },
  })

  const busyCatchUpTimer = setInterval(() => {
    const sessionSync = sync()
    const directory = sdk().directory
    const id = input.sessionID()
    if (
      !shouldCatchUpBusySessionTimeline({
        active: input.active?.() ?? true,
        sessionID: id,
        statusType: sessionSync.data.session_status[id ?? ""]?.type,
        activityType: sessionActivity(directory, id ?? "")?.type,
      })
    )
      return
    void sessionSync.session.sync(id!).catch(() => {})
  }, SESSION_BUSY_CATCH_UP_INTERVAL_MS)
  onCleanup(() => clearInterval(busyCatchUpTimer))

  const [resource, resourceActions] = createResource(
    () => {
      const current = serverSDK()
      return [
        ServerConnection.key(current.server),
        sdk().directory,
        input.sessionID(),
        sync(),
        current.scope,
        current.event.reconnect(),
        input.active?.() ?? true,
      ] as const
    },
    ([server, directory, id, sessionSync, scope, reconnect, active]) => {
      clearRefresh()
      if (!id) return Promise.resolve()

      const recovery = timelineReconnectRecoveryForSession({
        active,
        directory,
        generation: reconnect,
        scope,
        sessionID: id,
      })
      if (!recovery.load) return Promise.resolve()
      const recover = recovery.recover

      const cachedMessages = untrack(() => sessionSync.data.message[id])
      const cached = activeSessionReadyForBackgroundPrefetch({
        message: cachedMessages !== undefined,
        info: getSessionPrefetch(scope, directory, id),
      })
      const current = () =>
        input.sessionID() === id &&
        sdk().directory === directory &&
        ServerConnection.key(serverSDK().server) === server
      if (current()) setLoadError(undefined)

      const handleLoadFailure = (error: unknown) => {
        if (!current()) return
        if (!isSessionNotFoundError(error)) {
          if (!cached) {
            setLoadError({ server, directory, error, sessionID: id })
            autoResume.arm({
              key: timelineAutoResumeKey(server, directory, id),
              sessionID: id,
              cached,
              active,
              error,
              ready: () => current() && (input.active?.() ?? true),
            })
          }
          return
        }
        handleMissingTimelineSession({
          server,
          directory,
          error,
          sessionID: id,
          evict: () => sessionSync.session.evict(id, directory),
          onSessionNotFound: input.onSessionNotFound,
        })
      }

      const stale = cached && isSessionPrefetchStale(getSessionPrefetch(scope, directory, id))
      const resetMessages = shouldResetTimelineMessagesOnOpen(cachedMessages?.length ?? 0, recover)

      refreshFrame = requestAnimationFrame(() => {
        refreshFrame = undefined
        refreshTimer = window.setTimeout(() => {
          refreshTimer = undefined
          if (!current()) return
          untrack(() => {
            if (
              stale &&
              isSessionPrefetchStale(getSessionPrefetch(scope, directory, id)) &&
              !recover &&
              !resetMessages
            ) {
              void sessionSync
                .session.sync(id, { force: true })
                .catch(handleLoadFailure)
            }
          })
        }, 0)
      })

      return sessionSync.session
        .sync(id, resetMessages ? { force: true, resetMessages: true } : recover ? { force: true } : undefined)
        .then((loaded) => {
          if (current()) autoResume.reset()
          return loaded
        }, handleLoadFailure)
    },
  )

  const error = createMemo(() => {
    const failure = loadError()
    if (!failure || failure.sessionID !== input.sessionID()) return undefined
    if (failure.directory !== sdk().directory) return undefined
    if (failure.server !== ServerConnection.key(serverSDK().server)) return undefined
    return failure
  })

  const messages = createMemo(() => {
    const id = input.sessionID()
    return id ? (sync().data.message[id] ?? []) : []
  })
  const ready = createMemo(() => {
    const id = input.sessionID()
    return !id || sync().data.message[id] !== undefined
  })
  const userMessages = createMemo(() => selectUserMessages(messages()), emptyUserMessages, { equals: same })
  const visibleUserMessages = createMemo(
    () => {
      const boundary = input.revertMessageID()
      return selectVisibleUserMessages(userMessages(), boundary, messages().find((message) => message.id === boundary))
    },
    emptyUserMessages,
    { equals: same },
  )
  const more = createMemo(() => {
    const id = input.sessionID()
    return id ? sync().session.history.more(id) : false
  })
  const loading = createMemo(() => {
    const id = input.sessionID()
    return id ? sync().session.history.loading(id) : false
  })
  const refreshing = createMemo(() => {
    const id = input.sessionID()
    return id ? sync().session.history.refreshing(id) : false
  })
  const loadOlder = async (options?: { before?: () => void; after?: (done: boolean) => void }) => {
    return loadOlderTimeline({
      sessionID: input.sessionID,
      loaded: () => messages().length,
      visible: () => visibleUserMessages().length,
      more,
      loading,
      loadMore: (sessionID) => sync().session.history.loadMore(sessionID),
      before: options?.before,
      after: options?.after,
    })
  }

  onCleanup(() => {
    autoResume.reset()
    clearRefresh()
    if (!activeTimeline) return
    activeTimeline.sessionSync.session.release(activeTimeline.sessionID, activeTimeline.directory)
    activeTimeline = undefined
  })

  return {
    error,
    history: { loadOlder, loading, more },
    lastUserMessage: createMemo(() => visibleUserMessages().at(-1)),
    messages,
    ready,
    refreshing,
    resource,
    retry: () => {
      autoResume.reset()
      return resourceActions.refetch()
    },
    userMessages,
    visibleUserMessages,
  }

  function clearRefresh() {
    autoResume.stop()
    if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame)
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
    refreshFrame = undefined
    refreshTimer = undefined
  }
}

export function shouldReleaseTimeline(
  previous: { server: ServerConnection.Key; directory: string },
  next: { server: ServerConnection.Key; directory: string } | undefined,
) {
  if (!next) return true
  return previous.server !== next.server || previous.directory !== next.directory
}

export function shouldResetTimelineMessagesOnOpen(messageCount: number, reconnecting: boolean) {
  return !reconnecting && messageCount > SESSION_MESSAGE_REOPEN_LIMIT
}

export function handleMissingTimelineSession(input: SessionNotFoundDetail & {
  evict: () => void
  onSessionNotFound?: (detail: SessionNotFoundDetail) => void
}) {
  if (!isSessionNotFoundError(input.error)) throw input.error
  input.evict()
  input.onSessionNotFound?.({
    server: input.server,
    directory: input.directory,
    error: input.error,
    sessionID: input.sessionID,
  })
}

export function selectUserMessages(messages: Message[]) {
  return messages.filter((message): message is UserMessage => message.role === "user").sort(compareMessageTime)
}

export function selectVisibleUserMessages(messages: UserMessage[], revertMessageID?: string, boundary?: Message) {
  return rollbackUsersBefore(messages, revertMessageID, boundary)
}

export function selectWindowedUserMessages(messages: UserMessage[], options: UserMessageWindowOptions) {
  if (messages.length <= options.limit) return messages

  const targetIndex = options.targetID ? messages.findIndex((message) => message.id === options.targetID) : -1
  const maxStart = messages.length - options.limit
  const start = targetIndex === -1 ? maxStart : Math.max(0, Math.min(maxStart, targetIndex - options.before))
  return messages.slice(start, start + options.limit)
}

export function shouldAutoFillHistory(input: {
  scrollHeight: number
  clientHeight: number
}) {
  return input.scrollHeight <= input.clientHeight + 1
}

export async function loadOlderTimeline(input: {
  sessionID: Accessor<string | undefined>
  loaded: Accessor<number>
  visible: Accessor<number>
  more: Accessor<boolean>
  loading: Accessor<boolean>
  loadMore: (sessionID: string) => Promise<void>
  before?: () => void
  after?: (done: boolean) => void
}) {
  const id = input.sessionID()
  if (!id || !input.more() || input.loading()) return

  // A history page may contain only assistant messages or user turns hidden by a revert boundary.
  const beforeVisible = input.visible()
  let loaded = input.loaded()
  input.before?.()
  while (true) {
    await input.loadMore(id).catch((error) => {
      if (input.sessionID() === id) input.after?.(true)
      throw error
    })
    if (input.sessionID() !== id) return

    const nextLoaded = input.loaded()
    const growth = input.visible() - beforeVisible
    const raw = nextLoaded - loaded
    loaded = nextLoaded
    const done = growth > 0 || raw <= 0 || !input.more()
    input.after?.(done)
    if (done) return
  }
}
