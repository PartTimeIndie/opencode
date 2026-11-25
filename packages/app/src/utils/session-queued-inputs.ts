import { createStore, produce } from "solid-js/store"
import { directoryKey } from "@/context/global-sync/utils"

// Server-held queued inputs: the core runner admits delivery="queue" prompts into
// session_input and keeps them invisible to the transcript until a turn boundary
// promotes them. The transcript therefore shows no signal that the message
// arrived, which reads as "never submitted" during long activities. This store
// mirrors the PromptLifecycle admitted/promoted events so the composer can show a
// waiting count per session.
//
// Idempotency: admitted and promoted arrive once each, but event replays across
// reconnects can reorder them. `resolved` keeps a bounded tombstone list so a
// replayed admitted event cannot resurrect an already promoted message.

type QueuedInputs = {
  ids: Record<string, true>
  resolved: string[]
}

const RESOLVED_TOMBSTONE_LIMIT = 256

const [queued, setQueued] = createStore<Record<string, QueuedInputs | undefined>>({})

const key = (directory: string, sessionID: string) => `${directoryKey(directory)}\n${sessionID}`

export function recordQueuedInput(directory: string, sessionID: string, messageID: string) {
  const id = key(directory, sessionID)
  const state = queued[id]
  if (!state) {
    setQueued(id, { ids: { [messageID]: true }, resolved: [] })
    return
  }
  if (state.ids[messageID]) return
  if (state.resolved.includes(messageID)) return
  setQueued(id, "ids", messageID, true)
}

export function resolveQueuedInput(directory: string, sessionID: string, messageID: string) {
  const id = key(directory, sessionID)
  const state = queued[id]
  if (!state) {
    setQueued(id, { ids: {}, resolved: [messageID] })
    return
  }
  if (state.resolved.includes(messageID)) return
  setQueued(
    id,
    produce((draft) => {
      if (!draft) return
      delete draft.ids[messageID]
      draft.resolved.push(messageID)
      if (draft.resolved.length > RESOLVED_TOMBSTONE_LIMIT)
        draft.resolved.splice(0, draft.resolved.length - RESOLVED_TOMBSTONE_LIMIT)
    }),
  )
}

export function sessionQueuedInputCount(directory: string, sessionID: string) {
  return Object.keys(queued[key(directory, sessionID)]?.ids ?? {}).length
}

export function clearSessionQueuedInputs(directory: string, sessionID: string) {
  setQueued(key(directory, sessionID), { ids: {}, resolved: [] })
}
