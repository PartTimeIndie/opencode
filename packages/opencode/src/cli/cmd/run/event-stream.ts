import { EventV2 } from "@opencode-ai/core/event"

export function createTurnCompletionTracker(sessionID: string) {
  const verdicts = new Map<string, { status: "done" | "incomplete" | "unknown"; order: number }>()
  const activities = new Map<string, { activityID: string; tasks: Set<string>; order: number; terminal: boolean }>()
  const promoted = new Set<string>()
  let activity: { activityID: string; tasks: Set<string>; order: number; terminal: boolean } | undefined
  let newActivity = true
  let liveActivity = false
  function start(activityID: string) {
    const id = EventV2.ID.fromExternal({ namespace: "session-turn-completion", key: activityID })
    if (activities.has(id)) return
    activity = { activityID, tasks: new Set(promoted), order: activities.size, terminal: false }
    activities.set(id, activity)
    newActivity = true
  }
  function latest(messageID: string) {
    return [...activities.values()].findLast((activity) => activity.tasks.has(messageID))
  }
  return {
    seed(activityID: string) {
      if (!liveActivity) start(activityID)
    },
    observe(event: { id?: string; type: string; properties?: unknown }) {
      if (!event.properties || typeof event.properties !== "object") return
      const properties = event.properties as Record<string, unknown>
      if (properties.sessionID !== sessionID) return
      if (
        (event.type === "session.next.activity.started" || event.type === "session.next.activity.recovered") &&
        typeof properties.activityID === "string"
      ) {
        liveActivity = true
        start(properties.activityID)
      }
      if (event.type === "session.next.prompt.promoted" && typeof properties.messageID === "string") {
        if (newActivity) promoted.clear()
        newActivity = false
        promoted.add(properties.messageID)
        if (activity) {
          activity.tasks.clear()
          for (const messageID of promoted) activity.tasks.add(messageID)
        }
      }
      if (
        [
          "session.next.activity.completed",
          "session.next.activity.failed",
          "session.next.activity.interrupted",
        ].includes(event.type) &&
        typeof properties.activityID === "string"
      ) {
        const terminal = activities.get(
          EventV2.ID.fromExternal({ namespace: "session-turn-completion", key: properties.activityID }),
        )
        if (terminal) terminal.terminal = true
      }
      if (
        event.type === "session.turn.completed" &&
        (properties.status === "done" || properties.status === "incomplete" || properties.status === "unknown")
      ) {
        // A continuation has no new user input. Keep its original anchors;
        // a later activity with fresh prompts replaces them on first promotion.
        const completed = event.id ? activities.get(event.id) : undefined
        if (!completed) return
        for (const messageID of completed.tasks) {
          // A delayed scan of an older activity must not supersede the verdict
          // of a successor for the same admitted input.
          if ((verdicts.get(messageID)?.order ?? -1) <= completed.order)
            verdicts.set(messageID, { status: properties.status, order: completed.order })
        }
      }
    },
    activity(messageID: string) {
      const activity = latest(messageID)
      return activity ? { activityID: activity.activityID, terminal: activity.terminal } : undefined
    },
    get(messageID: string) {
      const verdict = verdicts.get(messageID)
      return verdict && verdict.order === latest(messageID)?.order ? verdict.status : undefined
    },
  }
}

export async function waitForTurnCompletion(input: {
  messageID: string
  tracker: ReturnType<typeof createTurnCompletionTracker>
  completed: Promise<string | undefined>
  done: () => boolean
  interrupted: () => boolean
  wait: () => Promise<unknown>
  timeoutMs?: number
  pollMs?: number
}) {
  // A deferred desktop completion listener can start after 65s, then claim for
  // 55s; a 5s scan interval completes that bounded terminal wait.
  const timeoutMs = input.timeoutMs ?? 125_000
  let activityID: string | undefined
  let waitedActivityID: string | undefined
  let deadline = Date.now() + timeoutMs
  while (!input.interrupted()) {
    const verdict = input.tracker.get(input.messageID)
    if (verdict !== undefined) return verdict
    const activity = input.tracker.activity(input.messageID)
    if (activity?.activityID !== activityID) {
      activityID = activity?.activityID
      deadline = Date.now() + timeoutMs
    }
    if (activity && !activity.terminal && activity.activityID !== waitedActivityID) {
      waitedActivityID = activity.activityID
      // The terminal deadline must never cancel a real continuation's tools or
      // provider stream. Join its owner first, then begin a fresh verdict wait.
      await waitForRunCompletion({ completed: input.completed, wait: input.wait() })
      deadline = Date.now() + timeoutMs
      continue
    }
    if (input.done() || Date.now() >= deadline) return input.tracker.get(input.messageID)
    await Promise.race([input.completed, Bun.sleep(input.pollMs ?? 25)])
  }
}

export async function waitForRunCompletion(input: { completed: Promise<string | undefined>; wait: Promise<unknown> }) {
  // EOF (or a legacy idle event) is a transport observation, not proof that the
  // admitted V2 activity finished. In particular, never dispose its local runner
  // merely because the event stream ended while a tool/provider is still active.
  await Promise.race([
    input.wait,
    input.completed.then((error) => {
      if (error) throw new Error(error)
      return input.wait
    }),
  ])
}

export async function settleEventStream(input: {
  completed: Promise<string | undefined>
  done: () => boolean
  abort: () => void
  graceMs?: number
}) {
  if (!input.done()) {
    await Promise.race([input.completed, Bun.sleep(input.graceMs ?? 1_000)])
  }
  if (input.done()) return input.completed

  input.abort()
  return Promise.race([input.completed, Bun.sleep(input.graceMs ?? 1_000).then(() => undefined)])
}

export async function waitForCompletedAssistant<T>(input: {
  previousMarker: string
  read: () => Promise<T | undefined>
  interrupted: () => boolean
  completed: (assistant: T) => boolean
  error: (assistant: T) => unknown
  timeoutMs?: number
  pollMs?: number
}) {
  if (input.interrupted()) return
  const deadline = Date.now() + (input.timeoutMs ?? 5_000)
  while (Date.now() < deadline) {
    if (input.interrupted()) return
    const assistant = await input.read()
    if (input.interrupted()) return
    const fresh = JSON.stringify(assistant ?? null) !== input.previousMarker
    if (fresh && assistant) {
      const error = input.error(assistant)
      if (error !== undefined) throw error
      if (input.completed(assistant)) return assistant
    }
    await Bun.sleep(input.pollMs ?? 100)
  }
  if (input.interrupted()) return
  throw new Error("Session became idle without a completed assistant response")
}
