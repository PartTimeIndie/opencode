import { describe, expect, test } from "bun:test"
import type { PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/core/util/encode"
import {
  accessControlModeProfile,
  accessControlRespondsPermission,
  accessControlWithGlobalSafetyReview,
  autoRespondsPermission,
  canMigrateGlobalSafetyReview,
  isDirectoryAutoAccepting,
  liveAccessControlProfile,
  parseAccessControlProfile,
  sessionMetadataAccessControlProfile,
  stripStoredSafetyReviews,
  type AccessControlMode,
} from "./permission-auto-respond"

const session = (input: { id: string; parentID?: string }) =>
  ({
    id: input.id,
    parentID: input.parentID,
  }) as Session

const permission = (sessionID: string) =>
  ({
    sessionID,
  }) as Pick<PermissionRequest, "sessionID">

describe("autoRespondsPermission", () => {
  test("uses a parent session's directory-scoped auto-accept", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/root`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(true)
  })

  test("uses a parent session's legacy auto-accept key", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]

    expect(autoRespondsPermission({ root: true }, sessions, permission("child"), "/tmp/project")).toBe(true)
  })

  test("defaults to requiring approval when no lineage override exists", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" }), session({ id: "other" })]
    const autoAccept = {
      other: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), "/tmp/project")).toBe(false)
  })

  test("inherits a parent session's false override", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/root`]: false,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(false)
  })

  test("prefers a child override over parent override", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/root`]: false,
      [`${base64Encode(directory)}/child`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(true)
  })

  test("falls back to directory-level auto-accept", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("root"), directory)).toBe(true)
  })

  test("session-level override takes precedence over directory-level", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: true,
      [`${base64Encode(directory)}/root`]: false,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("root"), directory)).toBe(false)
  })
})

describe("isDirectoryAutoAccepting", () => {
  test("returns true when directory key is set", () => {
    const directory = "/tmp/project"
    const autoAccept = { [`${base64Encode(directory)}/*`]: true }
    expect(isDirectoryAutoAccepting(autoAccept, directory)).toBe(true)
  })

  test("returns false when directory key is not set", () => {
    expect(isDirectoryAutoAccepting({}, "/tmp/project")).toBe(false)
  })

  test("returns false when directory key is explicitly false", () => {
    const directory = "/tmp/project"
    const autoAccept = { [`${base64Encode(directory)}/*`]: false }
    expect(isDirectoryAutoAccepting(autoAccept, directory)).toBe(false)
  })
})

describe("accessControlRespondsPermission", () => {
  test("full access responds to any permission request", () => {
    expect(accessControlRespondsPermission({ mode: "full_access" }, { permission: "bash" })).toBe(true)
  })

  test("approve for me does not use the old app-side built-in safe list", () => {
    expect(accessControlRespondsPermission({ mode: "approve_for_me" }, { permission: "read" })).toBe(false)
    expect(accessControlRespondsPermission({ mode: "approve_for_me" }, { permission: "edit" })).toBe(false)
    expect(accessControlRespondsPermission({ mode: "approve_for_me" }, { permission: "bash" })).toBe(false)
  })

  test("ask never auto-responds", () => {
    expect(accessControlRespondsPermission({ mode: "ask" }, { permission: "read" })).toBe(false)
  })
})

describe("global safety-review composition", () => {
  test("keeps only scoped mode data in persisted profiles", () => {
    expect(
      accessControlModeProfile({
        mode: "approve_for_me",
        safety_review: { model: "test/scoped", fallback: { model: "test/scoped-fallback" } },
      }),
    ).toEqual({ mode: "approve_for_me" })
  })

  test("replaces scoped reviewer data with the global reviewer pair", () => {
    expect(
      accessControlWithGlobalSafetyReview(
        { mode: "approve_for_me", safety_review: { model: "test/scoped" } },
        { model: "test/global", fallback: { model: "test/global-fallback" } },
      ),
    ).toEqual({
      mode: "approve_for_me",
      safety_review: { model: "test/global", fallback: { model: "test/global-fallback" } },
    })
  })
})

describe("parseAccessControlProfile", () => {
  test("does not fabricate a default safety review for approve_for_me", () => {
    // The global safety review is owned by server config; parsing a stored
    // profile must not bake a hard-coded reviewer model into it.
    expect(parseAccessControlProfile({ mode: "approve_for_me" })).toEqual({ mode: "approve_for_me" })
  })

  test("keeps an explicit safety review and normalizes custom mode", () => {
    const review = { model: "zhipuai-coding-plan/glm-5.2", fallback: { model: "openai/gpt-5.6-sol" } }
    expect(parseAccessControlProfile({ mode: "custom", safety_review: review })).toEqual({
      mode: "ask",
      safety_review: review,
    })
  })

  test("rejects unknown shapes", () => {
    expect(parseAccessControlProfile(undefined)).toBeUndefined()
    expect(parseAccessControlProfile("ask")).toBeUndefined()
    expect(parseAccessControlProfile({ mode: "sometimes" as unknown as AccessControlMode })).toBeUndefined()
  })
})

describe("liveAccessControlProfile", () => {
  const staleMirror = { mode: "approve_for_me" as const, safety_review: { model: "opencode/deepseek-v4-flash-free" } }
  const fresh = { mode: "approve_for_me" as const, safety_review: { model: "openai/gpt-5.6-terra" } }

  test("prefers the live server config over a stale persisted mirror", () => {
    expect(liveAccessControlProfile(fresh, staleMirror)).toEqual(fresh)
  })

  test("falls back to the persisted mirror when no live profile exists", () => {
    expect(liveAccessControlProfile(undefined, staleMirror)).toEqual(staleMirror)
    expect(liveAccessControlProfile("garbage", staleMirror)).toEqual(staleMirror)
    expect(liveAccessControlProfile({}, staleMirror)).toEqual(staleMirror)
  })

  test("returns undefined when neither source has a usable profile", () => {
    expect(liveAccessControlProfile(undefined, undefined)).toBeUndefined()
    expect(liveAccessControlProfile({}, { mode: "sometimes" as unknown as AccessControlMode })).toBeUndefined()
  })
})

describe("sessionMetadataAccessControlProfile", () => {
  const frozen = { mode: "approve_for_me" as const, safety_review: { model: "opencode/deepseek-v4-flash-free" } }

  test("reads session metadata mode-only so sessions follow reviewer changes", () => {
    expect(sessionMetadataAccessControlProfile(frozen)).toEqual({ mode: "approve_for_me" })
  })

  test("returns undefined for missing or invalid metadata", () => {
    expect(sessionMetadataAccessControlProfile(undefined)).toBeUndefined()
    expect(sessionMetadataAccessControlProfile({})).toBeUndefined()
    expect(sessionMetadataAccessControlProfile("ask")).toBeUndefined()
  })

  test("keeps a valid mode-only profile unchanged", () => {
    expect(sessionMetadataAccessControlProfile({ mode: "full_access" })).toEqual({ mode: "full_access" })
  })
})

describe("canMigrateGlobalSafetyReview", () => {
  const ready = {
    persistenceReady: true,
    bootstrapReady: true,
    globalConfigLoaded: true,
    migrated: false,
  }

  test("waits for the global config query even after bootstrap is ready", () => {
    expect(canMigrateGlobalSafetyReview({ ...ready, globalConfigLoaded: false })).toBe(false)
  })

  test("allows one migration only after persisted state and global config are ready", () => {
    expect(canMigrateGlobalSafetyReview(ready)).toBe(true)
    expect(canMigrateGlobalSafetyReview({ ...ready, migrated: true })).toBe(false)
    expect(canMigrateGlobalSafetyReview({ ...ready, persistenceReady: false })).toBe(false)
  })
})

describe("stripStoredSafetyReviews", () => {
  const stored = {
    autoAccept: {},
    accessControl: {
      user: { mode: "approve_for_me", safety_review: { model: "opencode/deepseek-v4-flash-free" } },
      project: {
        "abc/*": { mode: "approve_for_me", safety_review: { model: "opencode/deepseek-v4-flash-free" } },
        "def/*": { mode: "full_access" },
        "junk/*": "not-an-object",
      },
      workspace: { "ghi/*": { mode: "ask", safety_review: { model: "x/y" } } },
      session: {
        "abc/ses_1": { mode: "approve_for_me", safety_review: { model: "opencode/deepseek-v4-flash-free" } },
        "abc/ses_2": null,
      },
      updateProjectDefault: true,
      updateUserDefault: false,
      safetyReviewMigrated: true,
    },
  }

  test("removes embedded safety reviews from every stored profile", () => {
    const cleaned = JSON.parse(JSON.stringify(stripStoredSafetyReviews(stored)))
    expect(JSON.stringify(cleaned)).not.toContain("safety_review")
    expect(cleaned.accessControl.user).toEqual({ mode: "approve_for_me" })
    expect(cleaned.accessControl.project["def/*"]).toEqual({ mode: "full_access" })
    expect(cleaned.accessControl.project["junk/*"]).toBe("not-an-object")
    expect(cleaned.accessControl.updateProjectDefault).toBe(true)
    expect(cleaned.accessControl.safetyReviewMigrated).toBe(true)
  })

  test("tolerates malformed shapes and is idempotent", () => {
    const once = stripStoredSafetyReviews({ accessControl: { session: [1, 2], user: 7 }, extra: true })
    expect(JSON.stringify(once)).not.toContain("safety_review")
    expect(stripStoredSafetyReviews(once)).toEqual(once)
    expect(stripStoredSafetyReviews("junk")).toBe("junk")
  })
})
