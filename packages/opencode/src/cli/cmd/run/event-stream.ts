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
  extensionMs?: number
  maxExtensions?: number
  readDurable?: () => Promise<"done" | "incomplete" | "unknown" | undefined>
}) {
  // A deferred desktop completion listener can start after 65s, then claim for
  // 55s; a 5s scan interval completes that bounded terminal wait.
  const timeoutMs = input.timeoutMs ?? 125_000
  // The server decides the verdict asynchronously: a continuation successor
  // defers it, and an evaluation retry releases its claim with exponential
  // backoff (5s up to 5min). Under load those decisions can outlast the plain
  // terminal deadline, which used to fail the whole run with a missing-verdict
  // error even though the still-open event stream would deliver the verdict
  // moments later. Extensions are opt-in and bounded so callers keep a hard
  // ceiling; a closed event stream can never gain more wait.
  const extensionMs = input.extensionMs ?? 0
  const maxExtensions = input.maxExtensions ?? 0
  let extensions = 0
  let activityID: string | undefined
  let waitedActivityID: string | undefined
  let deadline = Date.now() + timeoutMs
  let nextDurableRead = 0
  while (!input.interrupted()) {
    const verdict = input.tracker.get(input.messageID)
    if (verdict !== undefined) return verdict
    if (input.readDurable && Date.now() >= nextDurableRead) {
      nextDurableRead = Date.now() + 1_000
      const durable = await input.readDurable()
      if (durable !== undefined) return durable
    }
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
    if (input.done()) return input.tracker.get(input.messageID)
    if (Date.now() >= deadline) {
      if (extensions >= maxExtensions) return input.tracker.get(input.messageID)
      extensions += 1
      deadline = Date.now() + extensionMs
      continue
    }
    await Promise.race([input.completed, Bun.sleep(input.pollMs ?? 25)])
  }
}

export function turnCompletionError(verdict: "done" | "incomplete" | "unknown" | undefined, required: boolean) {
  if (verdict === "done" || (verdict === undefined && !required)) return
  const error = new Error(
    verdict === "incomplete"
      ? "Turn remained incomplete after automatic continuations"
      : verdict === "unknown"
        ? "Turn completion verdict unavailable: the bound final verdict is unknown"
        : "Turn completion verdict unavailable: no bound final verdict arrived before the completion wait ended",
  )
  error.name = verdict === "incomplete" ? "TurnCompletionIncompleteError" : "TurnCompletionVerdictUnavailableError"
  return error
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

export async function waitForTerminalAssistant<T>(input: {
  wait: Promise<unknown>
  observe: (signal?: AbortSignal) => Promise<{ terminal: boolean; assistant?: T }>
  interrupted: () => boolean
  pollMs?: number
}): Promise<T | undefined> {
  const controller = new AbortController()
  const stopped = new Promise<void>((resolve) => {
    if (controller.signal.aborted) resolve()
    else controller.signal.addEventListener("abort", () => resolve(), { once: true })
  })
  const poll = async (): Promise<T | undefined> => {
    while (!input.interrupted()) {
      if (controller.signal.aborted) return undefined
      const state = await input.observe(controller.signal)
      // A settled wait — fulfilled or rejected — ends the race lifetime: a late
      // observation must never start or continue a further polling round.
      if (controller.signal.aborted || input.interrupted()) return undefined
      if (state.terminal && state.assistant) return state.assistant
      await Promise.race([Bun.sleep(input.pollMs ?? 250), stopped])
      if (controller.signal.aborted || input.interrupted()) return undefined
    }
    return undefined
  }
  try {
    return await Promise.race([input.wait.then(() => undefined), poll()])
  } finally {
    controller.abort()
  }
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
