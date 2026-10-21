import { Show } from "solid-js"
import { createEffect, createSignal, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "@/context/sdk"
import {
  USAGE_POLL_INTERVAL_MS,
  formatRunDuration,
  isStaleRunningActivity,
  runDurationMs,
  shouldPollUsage,
  usageStatusSegments,
  usageStatusTitle,
  type UsageSummary,
} from "./session-usage-status"

/**
 * Footer token counter next to the running status: current run + whole session,
 * each including nested subagents. Reads the session usage endpoint at most
 * once in flight, refreshes on session/activity changes, every 15s while
 * running, and once after settling. Unknown run measurements remain visibly unknown.
 */
export function SessionUsageStatus(props: {
  sessionID: string
  running: () => boolean
  activityID: () => string | undefined
  activityGeneration: () => number
  activitySettled: () => boolean
}) {
  const sdk = useSDK()
  const [summary, setSummary] = createSignal<UsageSummary | undefined>(undefined)
  const [clock, setClock] = createStore({
    elapsed: 0,
    frozenDuration: undefined as { activityID: string; duration: number | undefined } | undefined,
  })
  let generation = 0
  let inFlight = false
  let refreshPending = false
  let wasRunning = false
  let terminalRefreshActivityID: string | undefined
  let currentSessionID: string | undefined
  let observedActivity: { sessionID: string; generation: number; activityID?: string; settled: boolean } | undefined

  const load = async () => {
    if (inFlight) {
      refreshPending = true
      return
    }
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return
    inFlight = true
    const run = generation
    const activityGeneration = props.activityGeneration()
    const activityID = props.activityID()
    try {
      const response = await sdk().client.experimental.session.usage({
        sessionID: props.sessionID,
        ...(activityID ? { activityID } : {}),
      })
      if (run !== generation) return
      if (activityGeneration !== props.activityGeneration() || activityID !== props.activityID()) {
        refreshPending = true
        return
      }
      // Malformed or error payloads (missing totals) must not render as zeros.
      const data = response.data
      if (!data?.session?.total) {
        // Reload/rehydration: keep last valid summary visible, do not erase with empty payload.
        return
      }
      const current = summary()
      if (isStaleRunningActivity(data, props.activityID(), props.activitySettled()) && data.run) {
        if (terminalRefreshActivityID !== data.run.activityID) {
          terminalRefreshActivityID = data.run.activityID
          refreshPending = true
        }
        if (current?.run?.activityID === data.run.activityID) {
          if (clock.frozenDuration?.activityID !== data.run.activityID) {
            setClock("frozenDuration", { activityID: data.run.activityID, duration: runDurationMs(current, clock.elapsed) })
          }
        }
        return
      }
      if (terminalRefreshActivityID !== data.run?.activityID) terminalRefreshActivityID = undefined
      setSummary(data)
      if (!data.run?.running) {
        setClock("frozenDuration", undefined)
        if (terminalRefreshActivityID === data.run?.activityID) terminalRefreshActivityID = undefined
      } else setClock("frozenDuration", (current) => current?.activityID === data.run?.activityID ? current : undefined)
    } catch {
      // Keep the last valid server snapshot visible across transient read failures.
    } finally {
      inFlight = false
      if (refreshPending) {
        refreshPending = false
        void load()
      }
    }
  }

  createEffect(() => {
    const sessionID = props.sessionID
    if (sessionID === currentSessionID) {
      // After reload: restore only if session stable and summary missing; bounded load.
      const s = summary()
      if ((!s || !s.session?.total) && !inFlight) {
        untrack(() => void load())
      }
      return
    }
    currentSessionID = sessionID
    generation += 1
    terminalRefreshActivityID = undefined
    setSummary(undefined)
    setClock({ elapsed: 0, frozenDuration: undefined })
    untrack(() => void load())
  })

  createEffect(() => {
    const sessionID = props.sessionID
    const activityGeneration = props.activityGeneration()
    const activityID = props.activityID()
    const settled = props.activitySettled()
    if (!observedActivity || observedActivity.sessionID !== sessionID) {
      observedActivity = { sessionID, generation: activityGeneration, activityID, settled }
      return
    }
    if (
      observedActivity.generation === activityGeneration &&
      observedActivity.activityID === activityID &&
      observedActivity.settled === settled
    ) return
    const previous = observedActivity
    observedActivity = { sessionID, generation: activityGeneration, activityID, settled }
    if (settled) {
      const current = summary()
      if (current?.run?.running && current.run.activityID === activityID) {
        setClock("frozenDuration", {
          activityID: current.run.activityID,
          duration: runDurationMs(current, clock.elapsed),
        })
      }
    } else if (activityID) {
      terminalRefreshActivityID = undefined
      const current = summary()
      if (previous.activityID !== activityID && current?.run?.running && current.run.activityID === previous.activityID) {
        setClock("frozenDuration", {
          activityID: current.run.activityID,
          duration: runDurationMs(current, clock.elapsed),
        })
      } else setClock("frozenDuration", undefined)
    }
    void load()
  })

  createEffect(() => {
    const snapshot = summary()
    if (!snapshot?.run?.running) {
      setClock("elapsed", 0)
      return
    }
    const snapshotTime = performance.now()
    setClock("elapsed", 0)
    const ticker = setInterval(() => setClock("elapsed", performance.now() - snapshotTime), 1_000)
    onCleanup(() => clearInterval(ticker))
  })

  createEffect(() => {
    if (!shouldPollUsage(summary(), props.running())) return
    const timer = setInterval(() => void load(), USAGE_POLL_INTERVAL_MS)
    onCleanup(() => clearInterval(timer))
  })

  // One final read when the session settles so idle values are current.
  createEffect(() => {
    const running = props.running() || summary()?.run?.running === true
    if (running) {
      wasRunning = true
      return
    }
    if (wasRunning) {
      wasRunning = false
      void load()
    }
  })

  onCleanup(() => {
    generation += 1
  })

  const duration = () => {
    const run = summary()?.run
    if (!run) return undefined
    const frozen = clock.frozenDuration
    if (frozen?.activityID === run.activityID) return frozen.duration
    return runDurationMs(summary(), clock.elapsed)
  }
  const text = () => {
    const segments = usageStatusSegments(summary()).map((item) => item.text)
    const elapsed = formatRunDuration(duration())
    return `· ${[...(elapsed ? [elapsed] : []), ...segments].join(" · ")}`
  }

  return (
    <Show when={usageStatusSegments(summary()).length > 0}>
      <span
        data-slot="session-usage-token"
        class="min-w-0 truncate text-12-regular text-text-weak"
        title={usageStatusTitle(summary(), clock.elapsed, duration() ?? null)}
      >
        {text()}
      </span>
    </Show>
  )
}
