import { createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { PermissionRequest, SurfaceBlockingRequest, Todo } from "@opencode-ai/sdk/v2"
import { showToast } from "@/utils/toast"
import type { TurnCompletionStatus } from "@/utils/session-status"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import {
  isDetachedSurfaceRequest,
  sessionPermissionRequest,
  sessionSurfaceRequest,
  sessionSurfaceRequests,
} from "./session-request-tree"
import { useSessionRoute } from "@/context/session-route"
import { todoState } from "./session-composer-todo-state"

export { todoState } from "./session-composer-todo-state"

const idle = { type: "idle" as const }

export function createSessionComposerState(options?: { closeMs?: number | (() => number) }) {
  const params = useSessionRoute()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const language = useLanguage()
  const permission = usePermission()

  const questionRequest = createMemo((): SurfaceBlockingRequest | undefined => {
    // Follow-up questions still block their tool call until the user answers or dismisses them.
    return sessionSurfaceRequest(
      sync().data.session,
      sync().data.question,
      params.id,
      (item): item is SurfaceBlockingRequest => item.mode === "blocking" && !isDetachedSurfaceRequest(item),
    ) as SurfaceBlockingRequest | undefined
  })
  const questionRequests = createMemo((): SurfaceBlockingRequest[] => {
    return sessionSurfaceRequests(
      sync().data.session,
      sync().data.question,
      params.id,
      (item): item is SurfaceBlockingRequest => item.mode === "blocking" && !isDetachedSurfaceRequest(item),
    ) as SurfaceBlockingRequest[]
  })

  const permissionRequest = createMemo((): PermissionRequest | undefined => {
    return sessionPermissionRequest(sync().data.session, sync().data.permission, params.id, (item) => {
      return !permission.autoResponds(item, sdk().directory)
    })
  })

  const blocked = createMemo(() => {
    const id = params.id
    if (!id) return false
    return !!permissionRequest() || !!questionRequest()
  })

  const todos = createMemo((): Todo[] => {
    const id = params.id
    if (!id) return []
    return sync().data.todo[id] ?? serverSync().todo.get(sdk().directory, id) ?? []
  })

  const done = createMemo(
    () => todos().length > 0 && todos().every((todo) => todo.status === "completed" || todo.status === "cancelled"),
  )

  const live = createMemo(() => sync().data.session_working(params.id ?? "") || blocked())

  const turnStatus = createMemo((): TurnCompletionStatus | undefined => {
    const id = params.id
    if (!id) return undefined
    return sync().data.turnCompletion[id]
  })

  const badgeStatus = createMemo((): "hidden" | "neutral" | "done" | "incomplete" | "unknown" => {
    if (todos().length === 0) return "hidden"
    if (live()) return "neutral"
    return turnStatus() ?? "neutral"
  })

  const [store, setStore] = createStore({
    responding: undefined as string | undefined,
    dock: todos().length > 0 && live(),
    closing: false,
    opening: false,
  })

  const permissionResponding = createMemo(() => {
    const perm = permissionRequest()
    if (!perm) return false
    return store.responding === perm.id
  })

  const decide = (response: "once" | "always" | "reject") => {
    const perm = permissionRequest()
    if (!perm) return
    if (store.responding === perm.id) return

    setStore("responding", perm.id)
    permission
      .respond({ request: perm, response, directory: sdk().directory })
      .catch((err: unknown) => {
        const description = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description })
      })
      .finally(() => {
        setStore("responding", (id) => (id === perm.id ? undefined : id))
      })
  }

  let timer: number | undefined
  let staleClearTimer: number | undefined
  let raf: number | undefined

  const closeMs = () => {
    const value = options?.closeMs
    if (typeof value === "function") return Math.max(0, value())
    if (typeof value === "number") return Math.max(0, value)
    return 400
  }

  const scheduleClose = () => {
    if (timer) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      setStore({ dock: false, closing: false })
      timer = undefined
    }, closeMs())
  }

  const scheduleStaleClear = () => {
    if (staleClearTimer) window.clearTimeout(staleClearTimer)
    staleClearTimer = window.setTimeout(() => {
      staleClearTimer = undefined
      if (todos().length === 0 || live() || turnStatus()) return
      clear()
    }, 1000)
  }

  // Keep stale turn todos from reopening if the model never clears them.
  const clear = () => {
    const id = params.id
    if (!id) return
    serverSync().todo.set(sdk().directory, id, [])
    sync().set("todo", id, [])
  }

  createEffect(
    on(
      () => [todos().length, done(), live(), turnStatus()] as const,
      ([count, complete, active, status]) => {
        if (raf) cancelAnimationFrame(raf)
        raf = undefined
        if (staleClearTimer) {
          window.clearTimeout(staleClearTimer)
          staleClearTimer = undefined
        }

        const next = todoState({
          count,
          done: complete,
          live: active,
          turnStatus: status,
        })

        if (next === "hide") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          setStore({ dock: false, closing: false, opening: false })
          return
        }

        if (next === "clear") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          // A todo.updated event can arrive just before session.turn.completed.
          // Keep the snapshot briefly so the completion status can win instead of
          // clearing the dock between the two lifecycle events.
          setStore({ dock: true, closing: false, opening: false })
          scheduleStaleClear()
          return
        }

        if (next === "open") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          const hidden = !store.dock || store.closing
          setStore({ dock: true, closing: false })
          if (hidden) {
            setStore("opening", true)
            raf = requestAnimationFrame(() => {
              setStore("opening", false)
              raf = undefined
            })
            return
          }
          setStore("opening", false)
          return
        }

        setStore({ dock: true, opening: false, closing: true })
        if (!timer) scheduleClose()
      },
    ),
  )

  onCleanup(() => {
    if (!timer) return
    window.clearTimeout(timer)
  })

  onCleanup(() => {
    if (!staleClearTimer) return
    window.clearTimeout(staleClearTimer)
  })

  onCleanup(() => {
    if (!raf) return
    cancelAnimationFrame(raf)
  })

  return {
    blocked,
    questionRequest,
    questionRequests,
    permissionRequest,
    permissionResponding,
    decide,
    todos,
    badgeStatus,
    dock: () => store.dock,
    closing: () => store.closing,
    opening: () => store.opening,
  }
}

export type SessionComposerState = ReturnType<typeof createSessionComposerState>
