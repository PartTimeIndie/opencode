import { createEffect, createMemo, type Accessor } from "solid-js"
import { useServerSync, type ServerSync } from "@/context/server-sync"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { sessionPermissionRequest, sessionSurfaceRequest } from "@/pages/session/composer/session-request-tree"
import { latestAssistantCompletedBefore, latestAssistantSettled, resolveLifecycleStatus, resolveSessionStatus, sessionIsWorking } from "@/utils/session-status"
import { selectSessionTabStore, selectSessionTabSync } from "./session-tab-sync"
import { sessionActivity, sessionActivitySettled, sessionActivityStartedAt } from "@/utils/session-activity"
import { sessionTabStatus, sessionTabUnread } from "./project-avatar-unread"

export function useSessionTabAvatarState(
  directory: Accessor<string>,
  sessionId: Accessor<string>,
  active: Accessor<boolean> = () => true,
  sync?: Accessor<ServerSync | undefined>,
  activeServer: Accessor<boolean> = () => true,
) {
  const contextSync = useServerSync()
  const notification = useNotification()
  const permission = usePermission()
  const serverSync = createMemo(() =>
    selectSessionTabSync({
      context: contextSync(),
      injected: sync?.(),
    }),
  )
  const store = createMemo(() => {
    const current = serverSync()
    if (!current) return
    return selectSessionTabStore({ directory: directory(), sync: current })
  })
  createEffect(() => {
    const current = serverSync()
    const currentStore = store()
    if (!current || !currentStore || currentStore.session_status[sessionId()]) return
    void current.session.refreshStatus(directory(), sessionId())
  })
  const lifecycleStatus = createMemo(() => {
    const current = store()
    const sessionID = sessionId()
    return resolveLifecycleStatus({
      activity: sessionActivity(directory(), sessionID)?.type,
      activityTracked: current
        ? latestAssistantCompletedBefore(current, sessionID, sessionActivityStartedAt(directory(), sessionID))
        : false,
      activitySettled: sessionActivitySettled(directory(), sessionID),
      store: current?.session_status[sessionID]?.type,
      latestAssistantSettled: current ? latestAssistantSettled(current, sessionID) : false,
    })
  })
  const working = createMemo(() => {
    const current = store()
    if (!current) return false
    return sessionIsWorking(current, sessionId(), lifecycleStatus(), sessionActivitySettled(directory(), sessionId()))
  })
  const turnCompletion = createMemo(
    () => store()?.turnCompletion[sessionId()] ?? serverSync()?.turnCompletion.get(directory(), sessionId()),
  )
  const hasPermissions = createMemo(() => {
    const current = store()
    if (!current) return false
    return !!sessionPermissionRequest(current.session, current.permission, sessionId(), (item) => {
      if (!activeServer()) return true
      return !permission.autoResponds(item, directory())
    })
  })
  const hasQuestions = createMemo(() => {
    const current = store()
    if (!current) return false
    return !!sessionSurfaceRequest(current.session, current.question, sessionId())
  })
  const unread = createMemo(() =>
    sessionTabUnread({
      active: active(),
      hasPermissions: hasPermissions(),
      hasQuestions: hasQuestions(),
      notificationUnread: activeServer() && notification.session.unseenCount(sessionId()) > 0,
    }),
  )
  const resolved = createMemo(() =>
    resolveSessionStatus({
      working: working(),
      question: hasQuestions(),
      permission: hasPermissions(),
      status: lifecycleStatus(),
      turnCompletion: turnCompletion(),
    }),
  )
  const loading = createMemo(() => resolved() === "running")
  const status = createMemo(() =>
    sessionTabStatus({
      active: active(),
      unread: unread(),
      hasQuestions: hasQuestions(),
      resolved: resolved(),
    }),
  )
  return { unread, loading, status }
}
