import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useTabs, type SessionTab } from "@/context/tabs"
import { formatServerError } from "@/utils/server-errors"
import { showToast } from "@/utils/toast"

export function useDockStateActions() {
  const language = useLanguage()
  const layout = useLayout()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const tabs = useTabs()

  const errorDescription = (error: unknown) => formatServerError(error, language.t)

  const cleanupEmptySession = (tab: SessionTab) => {
    if (!tab.createdEmpty) return
    const directory = atob(tab.dirBase64)
    const store = serverSync().child(directory, { bootstrap: false })[0]
    const status = store.session_status[tab.sessionId]
    if (status && status.type !== "idle") return
    const messages = store.message[tab.sessionId] ?? []
    if (messages.length > 0) return

    serverSDK()
      .createDirSdkContext(directory)
      .client.session.delete({ sessionID: tab.sessionId })
      .then(() => {
        serverSync().session.forget(directory, tab.sessionId)
      })
      .catch((error) => {
        console.warn("Failed to clean up empty session", error)
        showToast({
          variant: "error",
          title: language.t("session.delete.failed.title"),
          description: errorDescription(error),
        })
      })
  }

  const moveChatPaneProject = (tab: SessionTab, directory: string) => {
    const currentDirectory = atob(tab.dirBase64)
    if (currentDirectory === directory) return Promise.resolve(true)
    const status = serverSync().child(currentDirectory, { bootstrap: false })[0].session_status[tab.sessionId]
    if (status && status.type !== "idle") {
      showToast({
        title: language.t("common.requestFailed"),
        description: "Session is still running.",
      })
      return Promise.resolve(false)
    }
    return serverSDK()
      .client.experimental.controlPlane.moveSession({
        sessionID: tab.sessionId,
        destination: { directory },
      })
      .then((result) => {
        const moved = result.data
        if (!moved) throw new Error(language.t("common.requestFailed"))
        tabs.moveSessions({
          fromDirectory: currentDirectory,
          toDirectory: moved.directory,
          sessionIDs: moved.sessionIDs,
          selectSessionID: tab.sessionId,
        })
        layout.projects.open(moved.directory)
        return true
      })
      .catch((error) => {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: errorDescription(error),
        })
        return false
      })
  }

  return {
    cleanupEmptySession,
    moveChatPaneProject,
  }
}
