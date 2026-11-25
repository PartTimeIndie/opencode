import { Binary } from "@opencode-ai/core/util/binary"
import { produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type {
  Message,
  Part,
  PermissionRequest,
  PermissionV2Request,
  Project,
  SurfaceRequest,
  Session,
  SessionStatus,
  SnapshotFileDiff,
  Todo,
} from "@opencode-ai/sdk/v2/client"
import type { State, VcsCache } from "./types"
import { sessionTrimPreserveIDs, trimSessions } from "./session-trim"
import { dropSessionCaches } from "./session-cache"
import { diffs as list, message as clean } from "@/utils/diffs"
import { idleSignalSettlesActivity, type TurnCompletionStatus } from "@/utils/session-status"
import { markQuestionChanged } from "./question-revision"
import { markPermissionChanged } from "./permission-revision"
import { normalizePermissionRequest } from "../permission-request"
import { clearSurfaceRequestProtocol, isSurfaceRequestSettled, markSurfaceRequestProtocol } from "../question-request"
import {
  dismissSessionActivity,
  finishSessionActivity,
  sessionActivityStartedAt,
  startSessionActivity,
  updateSessionActivity,
} from "@/utils/session-activity"
import { resolvePartText } from "@opencode-ai/ui/message-part-text"
import { mergeSessionList, replaceSessionList } from "./session-list"
import { mergePartsPreservingText } from "./session-message-window"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])

function mergeAccumulatedText(input: { part: Part; accumulated: string | undefined }) {
  if (!("text" in input.part) || typeof input.part.text !== "string")
    return { part: input.part, keepAccumulated: false }
  const resolved = resolvePartText(input.part.text, input.accumulated)
  if (resolved.text === input.part.text) return { part: input.part, keepAccumulated: resolved.keepAccumulated }
  return { part: { ...input.part, text: resolved.text } as Part, keepAccumulated: resolved.keepAccumulated }
}

function hasActiveAncestorTimeline(store: Store<State>, sessionID: string, seen = new Set<string>()): boolean {
  if (seen.has(sessionID)) return false
  seen.add(sessionID)
  const parentID = store.session.find((session) => session.id === sessionID)?.parentID
  if (!parentID) return false
  if (store.message[parentID]) return true
  return hasActiveAncestorTimeline(store, parentID, seen)
}

export function applyGlobalEvent(input: {
  event: { type: string; properties?: unknown }
  project: Project[]
  setGlobalProject: (next: Project[] | ((draft: Project[]) => Project[])) => void
  refresh: () => void
}) {
  if (input.event.type === "global.disposed") {
    input.refresh()
    return
  }

  if (input.event.type !== "project.updated") return
  const properties = input.event.properties as Project
  const result = Binary.search(input.project, properties.id, (s) => s.id)
  if (result.found) {
    input.setGlobalProject(
      produce((draft) => {
        draft[result.index] = { ...draft[result.index], ...properties }
      }),
    )
    return
  }
  input.setGlobalProject(
    produce((draft) => {
      draft.splice(result.index, 0, properties)
    }),
  )
}

function cleanupSessionCaches(
  setStore: SetStoreFunction<State>,
  directory: string,
  sessionID: string,
  setSessionTodo?: (directory: string, sessionID: string, todos: Todo[] | undefined) => void,
  setSessionTurnCompletion?: (directory: string, sessionID: string, status: TurnCompletionStatus | undefined) => void,
) {
  if (!sessionID) return
  setSessionTodo?.(directory, sessionID, undefined)
  setSessionTurnCompletion?.(directory, sessionID, undefined)
  setStore(
    produce((draft) => {
      dropSessionCaches(draft, [sessionID])
    }),
  )
}

export function cleanupDroppedSessionCaches(
  store: Store<State>,
  setStore: SetStoreFunction<State>,
  next: Session[],
  directory: string,
  setSessionTodo?: (directory: string, sessionID: string, todos: Todo[] | undefined) => void,
  setSessionTurnCompletion?: (directory: string, sessionID: string, status: TurnCompletionStatus | undefined) => void,
) {
  const keep = new Set(next.map((item) => item.id))
  const working = new Set(
    Object.entries(store.session_status)
      .filter(([, status]) => (status?.type ?? "idle") !== "idle")
      .map(([sessionID]) => sessionID),
  )
  const stale = [
    ...Object.keys(store.message),
    ...Object.keys(store.session_diff),
    ...Object.keys(store.todo),
    ...Object.keys(store.turnCompletion),
    ...Object.keys(store.permission),
    ...Object.keys(store.question),
    ...Object.keys(store.session_status),
    ...Object.values(store.part)
      .map((parts) => parts?.find((part) => !!part?.sessionID)?.sessionID)
      .filter((sessionID): sessionID is string => !!sessionID),
  ].filter(
    (sessionID, index, list) => !keep.has(sessionID) && !working.has(sessionID) && list.indexOf(sessionID) === index,
  )
  if (stale.length === 0) return
  for (const sessionID of stale) {
    setSessionTodo?.(directory, sessionID, undefined)
    setSessionTurnCompletion?.(directory, sessionID, undefined)
  }
  setStore(
    produce((draft) => {
      dropSessionCaches(draft, stale)
    }),
  )
}

export function applyDirectoryEvent(input: {
  event: { type: string; properties?: unknown }
  store: Store<State>
  setStore: SetStoreFunction<State>
  push: (directory: string) => void
  directory: string
  loadLsp: () => void
  vcsCache?: VcsCache
  setSessionTodo?: (directory: string, sessionID: string, todos: Todo[] | undefined) => void
  setSessionTurnCompletion?: (directory: string, sessionID: string, status: TurnCompletionStatus | undefined) => void
  retainedLimit?: number
  preserveSessionIDs?: ReadonlySet<string>
}) {
  const event = input.event
  const limit = Math.max(input.store.limit, input.retainedLimit ?? 0)
  const preserve = () =>
    sessionTrimPreserveIDs({
      retained: input.preserveSessionIDs,
      status: input.store.session_status,
      permission: input.store.permission,
      question: input.store.question,
    })
  switch (event.type) {
    case "server.instance.disposed": {
      input.push(input.directory)
      return
    }
    case "session.created": {
      const info = (event.properties as { info: Session }).info
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (result.found) {
        input.setStore(
          "session",
          produce((draft) => mergeSessionList(draft, info)),
        )
        break
      }
      const next = input.store.session.slice()
      next.splice(result.index, 0, info)
      const trimmed = trimSessions(next, {
        limit,
        permission: input.store.permission,
        preserve: preserve(),
      })
      input.setStore(
        "session",
        produce((draft) => replaceSessionList(draft, trimmed)),
      )
      cleanupDroppedSessionCaches(
        input.store,
        input.setStore,
        trimmed,
        input.directory,
        input.setSessionTodo,
        input.setSessionTurnCompletion,
      )
      if (!info.parentID) input.setStore("sessionTotal", (value) => value + 1)
      break
    }
    case "session.next.metadata.patched": {
      const properties = event.properties as {
        sessionID: string
        set?: Record<string, unknown>
        unset?: string[]
      }
      const result = Binary.search(input.store.session, properties.sessionID, (s) => s.id)
      if (!result.found) break
      input.setStore(
        "session",
        produce((draft) => {
          const session = draft[result.index]
          if (!session) return
          const metadata = { ...(session.metadata ?? {}), ...(properties.set ?? {}) }
          for (const key of properties.unset ?? []) delete metadata[key]
          session.metadata = metadata
        }),
      )
      break
    }
    case "session.updated": {
      const info = (event.properties as { info: Session }).info
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (info.time.archived) {
        if (result.found && input.store.session[result.index]?.time.archived === info.time.archived) break
        if (result.found) {
          input.setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 1)
            }),
          )
        }
        cleanupSessionCaches(
          input.setStore,
          input.directory,
          info.id,
          input.setSessionTodo,
          input.setSessionTurnCompletion,
        )
        if (info.parentID || !result.found) break
        input.setStore("sessionTotal", (value) => Math.max(0, value - 1))
        break
      }
      if (result.found) {
        input.setStore(
          "session",
          produce((draft) => mergeSessionList(draft, info)),
        )
        break
      }
      const next = input.store.session.slice()
      next.splice(result.index, 0, info)
      const trimmed = trimSessions(next, {
        limit,
        permission: input.store.permission,
        preserve: preserve(),
      })
      input.setStore(
        "session",
        produce((draft) => replaceSessionList(draft, trimmed)),
      )
      cleanupDroppedSessionCaches(
        input.store,
        input.setStore,
        trimmed,
        input.directory,
        input.setSessionTodo,
        input.setSessionTurnCompletion,
      )
      break
    }
    case "session.next.title.updated": {
      const props = event.properties as { sessionID: string; title: string; timestamp: number }
      const result = Binary.search(input.store.session, props.sessionID, (session) => session.id)
      if (!result.found) {
        input.push(input.directory)
        break
      }
      input.setStore(
        "session",
        produce((draft) =>
          mergeSessionList(draft, {
            ...input.store.session[result.index],
            title: props.title,
            time: { ...input.store.session[result.index]!.time, updated: props.timestamp },
          }),
        ),
      )
      break
    }
    case "session.deleted": {
      const info = (event.properties as { info: Session }).info
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (result.found) {
        input.setStore(
          "session",
          produce((draft) => {
            draft.splice(result.index, 1)
          }),
        )
      }
      cleanupSessionCaches(
        input.setStore,
        input.directory,
        info.id,
        input.setSessionTodo,
        input.setSessionTurnCompletion,
      )
      if (info.parentID) break
      input.setStore("sessionTotal", (value) => Math.max(0, value - 1))
      break
    }
    case "session.diff": {
      const props = event.properties as { sessionID: string; diff: SnapshotFileDiff[] }
      input.setStore("session_diff", props.sessionID, reconcile(list(props.diff), { key: "file" }))
      break
    }
    case "todo.updated": {
      const props = event.properties as { sessionID: string; todos: Todo[] }
      input.setStore("todo", props.sessionID, reconcile(props.todos, { merge: false }))
      input.setSessionTodo?.(input.directory, props.sessionID, props.todos)
      break
    }
    case "session.turn.completed": {
      const props = event.properties as { sessionID: string; status: unknown }
      if (props.status !== "done" && props.status !== "incomplete" && props.status !== "unknown") break
      // A deferred verdict can arrive while a newer activity is already streaming (for
      // example after an auto-resume). Storing it would flag the red incomplete badge
      // next to live output; the running state wins until that activity settles.
      if ((input.store.session_status[props.sessionID]?.type ?? "idle") !== "idle") break
      input.setStore("turnCompletion", props.sessionID, props.status)
      input.setSessionTurnCompletion?.(input.directory, props.sessionID, props.status)
      break
    }
    case "session.next.activity.started":
    case "session.next.activity.recovered": {
      const props = event.properties as { sessionID: string; activityID?: string; timestamp?: unknown }
      const evidence = typeof props.timestamp === "number" && props.timestamp > 0 ? { timestamp: props.timestamp } : undefined
      if (!startSessionActivity(input.directory, props.sessionID, props.activityID, evidence)) break
      input.setStore("session_status", props.sessionID, { type: "busy" })
      input.setStore(
        "turnCompletion",
        produce((draft) => {
          delete draft[props.sessionID]
        }),
      )
      input.setSessionTurnCompletion?.(input.directory, props.sessionID, undefined)
      break
    }
    case "session.next.activity.interrupted":
    case "session.next.activity.completed":
    case "session.next.activity.failed": {
      const props = event.properties as { sessionID: string; activityID?: string }
      if (!finishSessionActivity(input.directory, props.sessionID, props.activityID)) break
      input.setStore("session_status", props.sessionID, { type: "idle" })
      break
    }
    case "session.status": {
      const props = event.properties as { sessionID: string; status: SessionStatus }
      if (
        props.status.type === "idle" &&
        idleSignalSettlesActivity(input.store, props.sessionID, sessionActivityStartedAt(input.directory, props.sessionID))
      ) {
        finishSessionActivity(input.directory, props.sessionID)
      }
      input.setStore("session_status", props.sessionID, reconcile(props.status))
      updateSessionActivity(input.directory, props.sessionID, props.status)
      if (props.status.type !== "idle") {
        input.setStore(
          "turnCompletion",
          produce((draft) => {
            delete draft[props.sessionID]
          }),
        )
        input.setSessionTurnCompletion?.(input.directory, props.sessionID, undefined)
      }
      break
    }
    case "message.updated": {
      const info = clean((event.properties as { info: Message }).info)
      const messages = input.store.message[info.sessionID]
      // Timeline arrays are created explicitly when a session is opened. Background
      // events must not hydrate every inactive long session retained by open tabs.
      // Descendants of an active timeline are part of that visible request tree.
      if (!messages && !hasActiveAncestorTimeline(input.store, info.sessionID)) break
      if (!messages) input.setStore("message", info.sessionID, [])
      const timeline = input.store.message[info.sessionID]!
      const result = Binary.search(timeline, info.id, (m) => m.id)
      if (result.found) {
        input.setStore("message", info.sessionID, result.index, reconcile(info))
        break
      }
      input.setStore(
        "message",
        info.sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, info)
        }),
      )
      break
    }
    case "message.removed":
    case "session.next.revert.cleaned": {
      const props = event.properties as {
        sessionID: string
        messageID?: string
        messageIDs?: string[]
        revert?: Pick<NonNullable<Session["revert"]>, "messageID" | "partID">
      }
      const messageIDs =
        event.type === "message.removed" ? (props.messageID ? [props.messageID] : []) : (props.messageIDs ?? [])
      if (event.type === "message.removed" && messageIDs.length === 0) break
      input.setStore(
        produce((draft) => {
          if (event.type === "session.next.revert.cleaned" && props.revert) {
            const revert = props.revert
            const result = Binary.search(draft.session, props.sessionID, (session) => session.id)
            const current = result.found ? draft.session[result.index]?.revert : undefined
            if (current?.messageID === revert.messageID && current.partID === revert.partID) {
              delete draft.session[result.index]!.revert
            }
            const parts = draft.part[revert.messageID]
            if (parts && revert.partID) {
              // V2 text content is adapted to a message-scoped part ID; tool and reasoning IDs stay unchanged.
              const index = parts.findIndex(
                (part) => part.id === revert.partID || part.id === `${revert.messageID}:${revert.partID}`,
              )
              if (index >= 0) {
                for (const part of parts.splice(index)) delete draft.part_text_accum_delta[part.id]
                if (parts.length === 0) delete draft.part[revert.messageID]
              }
            }
          }
          const messages = draft.message[props.sessionID]
          for (const messageID of messageIDs) {
            if (messages) {
              const result = Binary.search(messages, messageID, (m) => m.id)
              if (result.found) messages.splice(result.index, 1)
            }
            const parts = draft.part[messageID]
            if (parts) {
              for (const part of parts) {
                delete draft.part_text_accum_delta[part.id]
              }
            }
            delete draft.part[messageID]
          }
        }),
      )
      break
    }
    case "message.part.updated": {
      const incoming = (event.properties as { part: Part }).part
      // Ignore orphaned background parts when their session timeline is not active.
      if (!input.store.message[incoming.sessionID]) break
      const merged = mergeAccumulatedText({
        part: incoming,
        accumulated: input.store.part_text_accum_delta[incoming.id],
      })
      const part = merged.part
      if (SKIP_PARTS.has(part.type)) break
      input.setStore(
        produce((draft) => {
          if (!merged.keepAccumulated) delete draft.part_text_accum_delta[part.id]
        }),
      )
      const parts = input.store.part[part.messageID]
      if (part.type === "file") {
        input.setStore(
          "part",
          part.messageID,
          reconcile(mergePartsPreservingText(parts ?? [], [part], input.store.part_text_accum_delta), { key: "id" }),
        )
        break
      }
      if (!parts) {
        input.setStore("part", part.messageID, [part])
        break
      }
      const result = Binary.search(parts, part.id, (p) => p.id)
      if (result.found) {
        input.setStore("part", part.messageID, result.index, reconcile(part))
        break
      }
      input.setStore(
        "part",
        part.messageID,
        produce((draft) => {
          draft.splice(result.index, 0, part)
        }),
      )
      break
    }
    case "message.part.removed": {
      const props = event.properties as { messageID: string; partID: string }
      input.setStore(
        produce((draft) => {
          delete draft.part_text_accum_delta[props.partID]
        }),
      )
      const parts = input.store.part[props.messageID]
      if (!parts) break
      const result = Binary.search(parts, props.partID, (p) => p.id)
      if (result.found) {
        input.setStore(
          produce((draft) => {
            const list = draft.part[props.messageID]
            if (!list) return
            const next = Binary.search(list, props.partID, (p) => p.id)
            if (!next.found) return
            list.splice(next.index, 1)
            if (list.length === 0) delete draft.part[props.messageID]
          }),
        )
      }
      break
    }
    case "message.part.delta": {
      const props = event.properties as { messageID: string; partID: string; field: string; delta: string }
      const parts = input.store.part[props.messageID]
      if (!parts) break
      const result = Binary.search(parts, props.partID, (p) => p.id)
      if (!result.found) break
      const field = props.field as keyof (typeof parts)[number]
      const current = parts[result.index]?.[field]
      input.setStore(
        "part_text_accum_delta",
        props.partID,
        (existing) => (existing ?? (typeof current === "string" ? current : "")) + props.delta,
      )
      input.setStore(
        "part",
        props.messageID,
        produce((draft) => {
          const part = draft[result.index]
          const field = props.field as keyof typeof part
          const existing = part[field] as string | undefined
          ;(part[field] as string) = (existing ?? "") + props.delta
        }),
      )
      break
    }
    case "vcs.branch.updated": {
      const props = event.properties as { branch?: string }
      if (input.store.vcs?.branch === props.branch) break
      const next = { ...input.store.vcs, branch: props.branch }
      input.setStore("vcs", next)
      if (input.vcsCache) input.vcsCache.setStore("value", next)
      break
    }
    case "permission.asked":
    case "permission.v2.asked": {
      const permission = normalizePermissionRequest(event.properties as PermissionRequest | PermissionV2Request)
      markPermissionChanged(input.store, permission.id)
      const permissions = input.store.permission[permission.sessionID]
      if (!permissions) {
        input.setStore("permission", permission.sessionID, [permission])
        break
      }
      const result = Binary.search(permissions, permission.id, (p) => p.id)
      if (result.found) {
        input.setStore("permission", permission.sessionID, result.index, reconcile(permission))
        break
      }
      input.setStore(
        "permission",
        permission.sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, permission)
        }),
      )
      break
    }
    case "permission.replied":
    case "permission.v2.replied": {
      const props = event.properties as { sessionID: string; requestID: string }
      markPermissionChanged(input.store, props.requestID)
      const permissions = input.store.permission[props.sessionID]
      if (!permissions) break
      const result = Binary.search(permissions, props.requestID, (p) => p.id)
      if (!result.found) break
      input.setStore(
        "permission",
        props.sessionID,
        produce((draft) => {
          draft.splice(result.index, 1)
        }),
      )
      break
    }
    case "surface.asked": {
      const question = markSurfaceRequestProtocol(event.properties as SurfaceRequest, "v2")
      if (isSurfaceRequestSettled(question)) break
      markQuestionChanged(input.store, question.id)
      const questions = input.store.question[question.sessionID]
      if (!questions) {
        input.setStore("question", question.sessionID, [question])
        break
      }
      const result = Binary.search(questions, question.id, (q) => q.id)
      if (result.found) {
        input.setStore("question", question.sessionID, result.index, reconcile(question))
        break
      }
      input.setStore(
        "question",
        question.sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, question)
        }),
      )
      break
    }
    case "surface.replied":
    case "surface.dismissed": {
      const props = event.properties as { sessionID: string; requestID: string }
      if (event.type === "surface.dismissed") dismissSessionActivity(input.directory, props.sessionID)
      clearSurfaceRequestProtocol({ sessionID: props.sessionID, id: props.requestID })
      markQuestionChanged(input.store, props.requestID)
      const questions = input.store.question[props.sessionID]
      if (!questions) break
      const result = Binary.search(questions, props.requestID, (q) => q.id)
      if (!result.found) break
      input.setStore(
        "question",
        props.sessionID,
        produce((draft) => {
          draft.splice(result.index, 1)
        }),
      )
      break
    }
    case "lsp.updated": {
      input.loadLsp()
      break
    }
  }
}
