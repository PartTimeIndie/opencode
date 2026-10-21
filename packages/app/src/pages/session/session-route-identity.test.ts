import { describe, expect, test } from "bun:test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { ServerConnection } from "@/context/server"
import type { DraftTab, SessionTab } from "@/context/tabs-domain"
import { mobileRootDraftSuppressedAtBoot, sessionDirectoryRouteKey, sessionRouteParamsForCapturedTab } from "./session-route-identity"

const server = ServerConnection.Key.make("http://127.0.0.1:4096")
const directory = base64Encode("C:/OpenCode/Plan")

const session = (sessionId: string): SessionTab => ({
  type: "session",
  server,
  dirBase64: directory,
  sessionId,
})

const otherDirectory = (sessionId: string): SessionTab => ({
  type: "session",
  server,
  dirBase64: base64Encode("C:/OpenCode/Other"),
  sessionId,
})

const draft = (draftID: string): DraftTab => ({
  type: "draft",
  draftID,
  server,
  directory: "C:/OpenCode/Plan",
})

describe("sessionDirectoryRouteKey", () => {
  test("keeps the keyed session subtree stable across same-directory tab switches", () => {
    const planning = session("ses_plan")
    const other = session("ses_other")
    expect(sessionDirectoryRouteKey(planning)).toBe(sessionDirectoryRouteKey(other))
    expect(sessionDirectoryRouteKey(planning)).not.toBe(sessionDirectoryRouteKey(otherDirectory("ses_other")))
    expect(sessionDirectoryRouteKey(draft("draft_a"))).toBe("draft:draft_a")
    expect(sessionDirectoryRouteKey(draft("draft_a"))).not.toBe(sessionDirectoryRouteKey(draft("draft_b")))
    expect(sessionDirectoryRouteKey(undefined)).toBeUndefined()
  })
})

describe("sessionRouteParamsForCapturedTab", () => {
  test("follows the active session id without replacing the captured directory identity", () => {
    const captured = session("ses_plan")
    expect(sessionRouteParamsForCapturedTab(captured, session("ses_other"))).toEqual({
      dir: directory,
      id: "ses_other",
    })
    expect(sessionRouteParamsForCapturedTab(captured, otherDirectory("ses_other"))).toEqual({
      dir: directory,
      id: "ses_plan",
    })
    expect(sessionRouteParamsForCapturedTab(captured, draft("draft_a"))).toEqual({
      dir: directory,
      id: "ses_plan",
    })
    expect(sessionRouteParamsForCapturedTab(captured, undefined)).toEqual({
      dir: directory,
      id: "ses_plan",
    })
  })
})

describe("mobileRootDraftSuppressedAtBoot", () => {
  test("arms the mobile root draft only for genuine mobile root boots without a session marker", () => {
    expect(mobileRootDraftSuppressedAtBoot({ isRootRoute: true, restoresSession: false, mobileViewport: true })).toBe(
      false,
    )
  })

  test("keeps a restored session across a mobile root reload", () => {
    expect(mobileRootDraftSuppressedAtBoot({ isRootRoute: true, restoresSession: true, mobileViewport: true })).toBe(
      true,
    )
  })

  test("keeps the active session when a desktop boot later resizes to a mobile viewport", () => {
    expect(mobileRootDraftSuppressedAtBoot({ isRootRoute: true, restoresSession: false, mobileViewport: false })).toBe(
      true,
    )
  })

  test("keeps the hijack suppressed when a desktop boot remounts after a responsive layout switch", () => {
    // SessionRoute remounts re-run this decision with the module-captured boot
    // facts only; the live viewport after the resize must not re-arm the draft.
    const bootFacts = { isRootRoute: true, restoresSession: false, mobileViewport: false }
    expect(mobileRootDraftSuppressedAtBoot(bootFacts)).toBe(true)
    expect(mobileRootDraftSuppressedAtBoot(bootFacts)).toBe(true)
  })

  test("keeps the session for deep links opened on mobile", () => {
    expect(mobileRootDraftSuppressedAtBoot({ isRootRoute: false, restoresSession: false, mobileViewport: true })).toBe(
      true,
    )
  })
})
