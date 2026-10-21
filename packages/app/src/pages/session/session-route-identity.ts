import type { SessionTab, Tab } from "@/context/tabs-domain"

export function sessionDirectoryRouteKey(tab: Tab | undefined) {
  if (!tab) return
  if (tab.type === "draft") return `draft:${tab.draftID}`
  return `${tab.server}:${tab.dirBase64}`
}

export function sessionRouteParamsForCapturedTab(captured: SessionTab, current: Tab | undefined) {
  if (current?.type === "session" && current.server === captured.server && current.dirBase64 === captured.dirBase64) {
    return { dir: current.dirBase64, id: current.sessionId }
  }
  return { dir: captured.dirBase64, id: captured.sessionId }
}

// Replacing a restored session with a fresh draft is a boot-time decision for
// mobile root visits. It must never fire for a desktop boot that later resizes
// to a mobile viewport, because that would discard the user's active session.
export function mobileRootDraftSuppressedAtBoot(input: {
  isRootRoute: boolean
  restoresSession: boolean
  mobileViewport: boolean
}) {
  return !input.isRootRoute || input.restoresSession || !input.mobileViewport
}
