import { base64Encode } from "@opencode-ai/core/util/encode"

export type AccessControlMode = "ask" | "approve_for_me" | "full_access"
export type AccessControlSafetyReview = {
  chain_id?: string
  chain?: Array<{ providerID: string; modelID: string; variant?: string }>
  model?: string
  variant?: string
  generation?: {
    maxTokens?: number
    temperature?: number
    topP?: number
    topK?: number
  }
  options?: Record<string, unknown>
  fallback?: {
    model?: string
    variant?: string
    generation?: AccessControlSafetyReview["generation"]
    options?: Record<string, unknown>
  }
  prompt?: string
  auto_save?: boolean
}
export type AccessControlProfile = {
  mode: AccessControlMode
  safety_review?: AccessControlSafetyReview
}

export function canMigrateGlobalSafetyReview(input: {
  persistenceReady: boolean
  bootstrapReady: boolean
  globalConfigLoaded: boolean
  migrated: boolean
}) {
  return input.persistenceReady && input.bootstrapReady && input.globalConfigLoaded && !input.migrated
}

export function accessControlModeProfile(profile: AccessControlProfile): AccessControlProfile {
  return { mode: profile.mode }
}

export function accessControlWithGlobalSafetyReview(
  profile: AccessControlProfile,
  safetyReview: AccessControlSafetyReview,
): AccessControlProfile {
  return { mode: profile.mode, safety_review: safetyReview }
}

export function parseAccessControlProfile(value: unknown): AccessControlProfile | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const mode = record.mode
  if (mode !== "ask" && mode !== "approve_for_me" && mode !== "full_access" && mode !== "custom") return undefined
  return {
    // The global safety review is owned by server config. Parsing a stored
    // profile must never fabricate a hard-coded reviewer model.
    ...(typeof record.safety_review === "object" && record.safety_review !== null && !Array.isArray(record.safety_review)
      ? { safety_review: record.safety_review as AccessControlSafetyReview }
      : {}),
    mode: mode === "custom" ? ("ask" as const) : mode,
  }
}

// Server config is the source of truth for access-control profiles; the
// persisted mirror is only an offline fallback and must not shadow it.
export function liveAccessControlProfile(
  live: unknown,
  stored: AccessControlProfile | undefined,
): AccessControlProfile | undefined {
  return parseAccessControlProfile(live) ?? parseAccessControlProfile(stored)
}

// Session metadata historically froze a copy of the global safety review.
// Reading it mode-only lets existing sessions follow later reviewer changes
// instead of being pinned to the stale embedded copy.
export function sessionMetadataAccessControlProfile(value: unknown): AccessControlProfile | undefined {
  const parsed = parseAccessControlProfile(value)
  return parsed ? accessControlModeProfile(parsed) : undefined
}

type UnknownRecordMap = Record<string, unknown>

export function stripSafetyReviewsFromMap(map: unknown): UnknownRecordMap {
  if (typeof map !== "object" || map === null || Array.isArray(map)) return {}
  return Object.fromEntries(
    Object.entries(map as UnknownRecordMap).map(([key, profile]) => {
      if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return [key, profile]
      const { safety_review: _removed, ...rest } = profile as UnknownRecordMap
      return [key, rest]
    }),
  )
}

// Persisted profiles used to embed a copy of the global safety review. That
// copy goes stale whenever the reviewer changes in settings, so it is stripped
// from persisted state on load and never written back.
export function stripStoredSafetyReviews(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value
  const data = value as UnknownRecordMap
  if (typeof data.accessControl !== "object" || data.accessControl === null || Array.isArray(data.accessControl)) {
    return data
  }
  const accessControl = data.accessControl as UnknownRecordMap
  const cleaned: UnknownRecordMap = {
    user: (() => {
      if (typeof accessControl.user !== "object" || accessControl.user === null) return undefined
      const { safety_review: _removed, ...rest } = accessControl.user as UnknownRecordMap
      return rest
    })(),
    project: stripSafetyReviewsFromMap(accessControl.project),
    workspace: stripSafetyReviewsFromMap(accessControl.workspace),
    session: stripSafetyReviewsFromMap(accessControl.session),
    updateProjectDefault:
      typeof accessControl.updateProjectDefault === "boolean" ? accessControl.updateProjectDefault : false,
    updateUserDefault: typeof accessControl.updateUserDefault === "boolean" ? accessControl.updateUserDefault : false,
    safetyReviewMigrated: typeof accessControl.safetyReviewMigrated === "boolean" ? accessControl.safetyReviewMigrated : false,
  }
  return { ...data, accessControl: cleaned }
}

export function acceptKey(sessionID: string, directory?: string) {
  if (!directory) return sessionID
  return `${base64Encode(directory)}/${sessionID}`
}

export function directoryAcceptKey(directory: string) {
  return `${base64Encode(directory)}/*`
}

function accepted(autoAccept: Record<string, boolean>, sessionID: string, directory?: string) {
  const key = acceptKey(sessionID, directory)
  const directoryKey = directory ? directoryAcceptKey(directory) : undefined
  return autoAccept[key] ?? autoAccept[sessionID] ?? (directoryKey ? autoAccept[directoryKey] : undefined)
}

export function isDirectoryAutoAccepting(autoAccept: Record<string, boolean>, directory: string) {
  const key = directoryAcceptKey(directory)
  return autoAccept[key] ?? false
}

function sessionLineage(session: { id: string; parentID?: string }[], sessionID: string) {
  const parent = session.reduce((acc, item) => {
    if (item.parentID) acc.set(item.id, item.parentID)
    return acc
  }, new Map<string, string>())
  const seen = new Set([sessionID])
  const ids = [sessionID]

  for (const id of ids) {
    const parentID = parent.get(id)
    if (!parentID || seen.has(parentID)) continue
    seen.add(parentID)
    ids.push(parentID)
  }

  return ids
}

export function autoRespondsPermission(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string },
  directory?: string,
) {
  const value = sessionLineage(session, permission.sessionID)
    .map((id) => accepted(autoAccept, id, directory))
    .find((item): item is boolean => item !== undefined)
  return value ?? false
}

export function accessControlRespondsPermission(
  profile: AccessControlProfile,
  permission: { permission: string },
) {
  void permission
  if (profile.mode === "full_access") return true
  return false
}
