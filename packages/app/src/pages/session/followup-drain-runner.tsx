import { batch, createEffect, createRoot, createSignal, untrack } from "solid-js"
import { sendFollowupDraft } from "@/components/prompt-input/submit"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useTabs } from "@/context/tabs"
import { decode64 } from "@/utils/base64"
import { pathKey } from "@/utils/path-key"
import { Identifier } from "@/utils/id"
import { formatServerError } from "@/utils/server-errors"
import { showToast } from "@/utils/toast"
import { sessionActivitySettled } from "@/utils/session-activity"
import {
  isDetachedSurfaceRequest,
  sessionPermissionRequest,
  sessionSurfaceRequest,
} from "./composer/session-request-tree"
import { followupSendKey, selectNextDrainableFollowup, type DrainableFollowupStore } from "./followup-drain"
import {
  claimFollowupSend,
  followupCacheVersion,
  followupClaimVersion,
  followupStore,
  followupStoreEntries,
  releaseFollowupSend,
  sendingFollowups,
} from "./followup-store"

// Only the active tab renders a Session component, so the per-page drain could
// not release a parked followup while its own tab sat in the background — the
// message only sent after the user re-selected the tab. This runner mounts once
// per server scope and drains every followup store of that scope as soon as the
// target session settles, independent of which tab is visible. Drafts send with
// the agent they were queued under; the only pause is the dock's explicit user
// control, so this runner never writes a pause itself.
export function FollowupQueueDrain() {
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const permission = usePermission()
  const tabs = useTabs()
  const server = useServer()
  const language = useLanguage()
  const [releasing, setReleasing] = createSignal(false)

  // Plain child stores, not ref-counted createDirSyncContext handles: those
  // attach their release cleanup to the calling owner, so caching them across
  // effect re-runs would dispose contexts this runner still needs.
  const storeFor = (directory: string) => serverSync().child(directory)[0]

  // A store that has not finished bootstrapping has no reliable session,
  // permission, or question snapshot yet; treat its sessions as busy (park)
  // instead of guessing.
  const busy = (sessionID: string, directory: string) => {
    const store = storeFor(directory)
    if (store.status !== "complete") return true
    return store.session_working(sessionID)
  }

  const isChild = (sessionID: string, directory: string) =>
    storeFor(directory).session.find((session) => session.id === sessionID)?.parentID !== undefined

  const blocked = (sessionID: string, directory: string) => {
    const store = storeFor(directory)
    return (
      !!sessionPermissionRequest(store.session, store.permission, sessionID, (item) =>
        !permission.autoResponds(item, directory),
      ) || !!sessionSurfaceRequest(store.session, store.question, sessionID, (item) => !isDetachedSurfaceRequest(item))
    )
  }

  const release = (next: { directory: string; item: Parameters<typeof followupSendKey>[1] }) => {
    const scope = serverSDK().scope
    const key = followupSendKey(scope, next.item)
    if (!claimFollowupSend(key)) return
    const [followupState, setFollowup] = followupStore({ scope, directory: next.directory })
    const item = next.item
    const index = Math.max(
      0,
      (followupState.items[item.sessionID] ?? []).findIndex((entry) => entry.id === item.id),
    )

    setReleasing(true)
    setFollowup("items", item.sessionID, (items) => (items ?? []).filter((entry) => entry.id !== item.id))

    const restore = () => {
      setFollowup("items", item.sessionID, (items) => {
        const list = items ?? []
        if (list.some((entry) => entry.id === item.id)) return list
        const at = Math.min(index, list.length)
        return [...list.slice(0, at), item, ...list.slice(at)]
      })
    }
    const fail = (err: unknown) => {
      batch(() => {
        restore()
        setFollowup("failed", item.sessionID, item.id)
      })
      showToast({
        variant: "error",
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: formatServerError(err, language.t),
      })
    }

    // The sync context must outlive this effect run: the failed send removes its
    // optimistic entries through it after the admission await, so its refcount
    // cleanup is owned by a dedicated root until the send settles instead of the
    // scan effect's owner.
    let send: Promise<boolean>
    try {
      const { sync, dispose } = createRoot((dispose) => ({
        dispose,
        sync: untrack(() => serverSync().createDirSyncContext(item.sessionDirectory)),
      }))
      const messageID = Identifier.ascending("message")
      send = sendFollowupDraft({
        client: serverSDK().createClient({ directory: item.sessionDirectory, throwOnError: true }),
        sync,
        serverSync: serverSync(),
        draft: { ...item, messageID },
        messageID,
        optimisticBusy: true,
        queued: true,
        delivery: "queue",
      }).finally(dispose)
    } catch (err) {
      fail(err)
      releaseFollowupSend(key)
      setReleasing(false)
      return
    }

    send
      .catch((err) => fail(err))
      .finally(() => {
        releaseFollowupSend(key)
        setReleasing(false)
      })
  }

  createEffect(() => {
    if (releasing()) return
    // The store cache, store hydration, and claim state are not reactive by
    // themselves; all three must re-trigger this scan, or a queue that appears
    // or frees up after the last state change would sit unsent.
    followupCacheVersion()
    followupClaimVersion()
    const activeTab = tabs.active()
    const activeSessionTab = activeTab?.type === "session" ? activeTab : undefined
    // Tracked tab count so the untracked discovery loop below re-runs when a
    // tab is opened or restored without activation.
    tabs.store.length

    // Restored tabs of this server hydrate their stores even when never
    // selected, so a persisted background queue is discovered after a reload.
    untrack(() => {
      for (const tab of tabs.store) {
        if (tab.type !== "session" || tab.server !== server.key) continue
        const directory = decode64(tab.dirBase64)
        if (!directory) continue
        followupStore({ scope: serverSDK().scope, directory })
      }
    })

    const stores: DrainableFollowupStore[] = []
    for (const entry of followupStoreEntries(serverSDK().scope)) {
      const [followup, , ready] = entry.store
      if (!ready()) continue
      stores.push({ directory: entry.directory, followup })
    }

    const activeDirectory = activeSessionTab ? decode64(activeSessionTab.dirBase64) : undefined
    const next = selectNextDrainableFollowup({
      stores,
      activeSessionID: activeSessionTab?.sessionId,
      activeDirectory: activeDirectory ? pathKey(activeDirectory) : undefined,
      isBusy: busy,
      isActivitySettled: (sessionID, directory) => sessionActivitySettled(directory, sessionID),
      isChild,
      isBlocked: blocked,
      isReady: (directory) => storeFor(directory).status === "complete",
      isClaimed: (item) => sendingFollowups.has(followupSendKey(serverSDK().scope, item)),
    })
    if (!next) return

    release(next)
  })

  return null
}
