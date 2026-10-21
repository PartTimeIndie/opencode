import { Binary } from "@opencode-ai/core/util/binary"
import type { Session } from "@opencode-ai/sdk/v2/client"

export function mergeSessionList(list: Session[], info: Session) {
  const normalized = normalizeSession(info)
  if (!normalized) return
  const result = Binary.search(list, normalized.id, (item) => item.id)
  if (result.found) {
    syncSession(list[result.index]!, normalized)
    return
  }
  list.splice(result.index, 0, normalized)
}

export function replaceSessionList(list: Session[], next: Session[]) {
  const valid = next.flatMap((session) => {
    const normalized = normalizeSession(session)
    return normalized ? [normalized] : []
  })
  const ids = new Set(valid.map((session) => session.id))
  for (let index = list.length - 1; index >= 0; index--) {
    if (!ids.has(list[index]!.id)) list.splice(index, 1)
  }

  valid.forEach((info, index) => {
    const current = list[index]
    if (current?.id === info.id) {
      syncSession(current, info)
      return
    }

    const found = list.findIndex((session, currentIndex) => currentIndex > index && session.id === info.id)
    if (found < 0) {
      list.splice(index, 0, info)
      return
    }

    const moved = list.splice(found, 1)[0]!
    list.splice(index, 0, moved)
    syncSession(moved, info)
  })

  if (list.length > valid.length) list.splice(valid.length)
}

function syncSession(current: Session, next: Session) {
  Object.assign(current, next)
  // Complete snapshots omit revert after restoration; assignment alone would
  // retain the old marker and keep the restored dialogue hidden.
  if (!next.revert) delete current.revert
}

function normalizeSession(session: Session) {
  const runtime = session as Session & {
    time?: { created?: unknown; updated?: unknown; archived?: unknown }
  }
  const created = timestamp(runtime.time?.created)
  if (!runtime.id || created === undefined) return
  const updated = timestamp(runtime.time?.updated) ?? created
  const archived = timestamp(runtime.time?.archived)
  if (
    runtime.time?.created === created &&
    runtime.time?.updated === updated &&
    runtime.time?.archived === archived
  )
    return session
  return {
    ...session,
    time: {
      ...session.time,
      created,
      updated,
      archived,
    },
  }
}

function timestamp(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string") return
  const parsed = Date.parse(value)
  if (Number.isFinite(parsed)) return parsed
}
