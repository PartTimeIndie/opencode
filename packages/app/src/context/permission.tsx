import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { ConfigAccessControl } from "@opencode-ai/core/config/access-control"
import type { PermissionRequest } from "@opencode-ai/sdk/v2/client"
import { Persist, persisted } from "@/utils/persist"
import { showToast } from "@/utils/toast"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "./server-sync"
import { decode64 } from "@/utils/base64"
import { useSessionRoute } from "@/context/session-route"
import {
  acceptKey,
  directoryAcceptKey,
  isDirectoryAutoAccepting,
  autoRespondsPermission,
  canMigrateGlobalSafetyReview,
  accessControlRespondsPermission,
  accessControlModeProfile,
  liveAccessControlProfile,
  sessionMetadataAccessControlProfile,
  stripSafetyReviewsFromMap,
  stripStoredSafetyReviews,
  parseAccessControlProfile,
  type AccessControlMode,
  type AccessControlProfile,
  type AccessControlSafetyReview,
} from "./permission-auto-respond"
import { loadPendingPermissions, normalizePermissionRequest, respondPermission } from "./permission-request"
import { setSessionMetadata } from "@/utils/session-metadata-patch"

export type { AccessControlMode, AccessControlProfile } from "./permission-auto-respond"

const ACCESS_CONTROL_METADATA_KEY = "access_control"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function accessControlProfile(mode: AccessControlMode): AccessControlProfile {
  // Never bake a concrete safety-review model here; withSafetyReview attaches
  // the live configured review at resolution time.
  return { mode }
}

function normalizeAccessControlMap(value: unknown) {
  return stripSafetyReviewsFromMap(value)
}

function normalizePersistedState(value: unknown) {
  const data = stripStoredSafetyReviews(value)
  if (!isRecord(data)) return data
  const accessControl = isRecord(data.accessControl) ? data.accessControl : {}
  return {
    ...data,
    autoAccept:
      typeof data.autoAccept === "object" && data.autoAccept && !Array.isArray(data.autoAccept)
        ? data.autoAccept
        : typeof data.autoAcceptEdits === "object" && data.autoAcceptEdits && !Array.isArray(data.autoAcceptEdits)
          ? data.autoAcceptEdits
          : {},
    accessControl: {
      user: parseAccessControlProfile(accessControl.user),
      project: normalizeAccessControlMap(accessControl.project),
      session: normalizeAccessControlMap(accessControl.session),
      workspace: normalizeAccessControlMap(accessControl.workspace),
      updateProjectDefault:
        typeof accessControl.updateProjectDefault === "boolean" ? accessControl.updateProjectDefault : false,
      updateUserDefault:
        typeof accessControl.updateUserDefault === "boolean" ? accessControl.updateUserDefault : false,
      safetyReviewMigrated:
        typeof accessControl.safetyReviewMigrated === "boolean" ? accessControl.safetyReviewMigrated : false,
    },
  }
}

type PermissionRespondFn = (input: {
  request: PermissionRequest
  response: "once" | "always" | "reject"
  directory?: string
}) => Promise<void>

function isNonAllowRule(rule: unknown) {
  if (!rule) return false
  if (typeof rule === "string") return rule !== "allow"
  if (typeof rule !== "object") return false
  if (Array.isArray(rule)) return false

  for (const action of Object.values(rule)) {
    if (action !== "allow") return true
  }

  return false
}

function hasPermissionPromptRules(permission: unknown) {
  if (!permission) return false
  if (typeof permission === "string") return permission !== "allow"
  if (typeof permission !== "object") return false
  if (Array.isArray(permission)) return false

  const config = permission as Record<string, unknown>
  return Object.values(config).some(isNonAllowRule)
}

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  gate: false,
  init: () => {
    const params = useSessionRoute()
    const serverSDK = useServerSDK()
    const serverSync = useServerSync()

    const permissionsEnabled = createMemo(() => {
      const directory = decode64(params.dir)
      if (!directory) return false
      const [store] = serverSync().child(directory)
      return hasPermissionPromptRules(store.config.permission)
    })

    const [store, setStore, _, ready] = persisted(
      {
        ...Persist.serverGlobal(serverSDK().scope, "permission", ["permission.v3"]),
        migrate: normalizePersistedState,
      },
      createStore({
        autoAccept: {} as Record<string, boolean>,
        accessControl: {
          user: undefined as AccessControlProfile | undefined,
          project: {} as Record<string, AccessControlProfile | undefined>,
          session: {} as Record<string, AccessControlProfile | undefined>,
          workspace: {} as Record<string, AccessControlProfile | undefined>,
          updateProjectDefault: false,
          updateUserDefault: false,
          safetyReviewMigrated: false,
        },
      }),
    )

    const [pendingSafetyReview, setPendingSafetyReview] = createSignal<AccessControlSafetyReview | undefined>()
    const safetyReviewWrites = { tail: Promise.resolve() }

    function defaultSafetyReview(): AccessControlSafetyReview {
      const review = ConfigAccessControl.DEFAULT_INFO.safety_review
      if (!review) return {}
      const { chain, ...rest } = review
      return {
        ...rest,
        ...(chain ? { chain: chain.map((step) => ({ ...step })) } : {}),
      }
    }

    function configuredSafetyReview() {
      const profile = serverSync().data.config.access_control
      if (!isRecord(profile) || !isRecord(profile.safety_review)) return undefined
      return profile.safety_review as AccessControlSafetyReview
    }

    function globalSafetyReview() {
      return pendingSafetyReview() ?? configuredSafetyReview() ?? defaultSafetyReview()
    }

    function setGlobalSafetyReview(safety_review: AccessControlSafetyReview) {
      setPendingSafetyReview(safety_review)
      const update = safetyReviewWrites.tail.then(async () => {
        await serverSync().updateConfig((config) => ({
          access_control: {
            ...(isRecord(config.access_control) ? config.access_control : {}),
            safety_review,
          },
        }))
        if (pendingSafetyReview() === safety_review) setPendingSafetyReview(undefined)
      })
      safetyReviewWrites.tail = update.catch(() => undefined)
      return update.catch((error) => {
        if (pendingSafetyReview() === safety_review) setPendingSafetyReview(undefined)
        showToast({
          variant: "error",
          title: "Could not save safety-review settings",
          description: error instanceof Error ? error.message : String(error),
        })
        throw error
      })
    }

    // When config has permission: "allow", auto-enable directory-level auto-accept
    createEffect(() => {
      if (!ready()) return
      const directory = decode64(params.dir)
      if (!directory) return
      const [childStore] = serverSync().child(directory)
      const perm = childStore.config.permission
      if (typeof perm === "string" && perm === "allow") {
        const key = directoryAcceptKey(directory)
        if (store.autoAccept[key] === undefined) {
          setStore(
            produce((draft) => {
              draft.autoAccept[key] = true
            }),
          )
        }
      }
    })

    createEffect(() => {
      const migration = {
        persistenceReady: ready(),
        bootstrapReady: serverSync().data.ready,
        globalConfigLoaded: serverSync().configLoaded,
        migrated: store.accessControl.safetyReviewMigrated,
        configured: !!configuredSafetyReview(),
      }
      if (!canMigrateGlobalSafetyReview(migration)) return
      // Live server config is the only trusted reviewer source. Mirrored
      // copies (persisted store, session metadata) are stale by definition
      // and must never be promoted into global config.
      if (configuredSafetyReview()) {
        setStore("accessControl", "safetyReviewMigrated", true)
        return
      }
      void setGlobalSafetyReview(defaultSafetyReview())
        .then(() => setStore("accessControl", "safetyReviewMigrated", true))
        .catch(() => undefined)
    })

    const MAX_RESPONDED = 1000
    const RESPONDED_TTL_MS = 60 * 60 * 1000
    const responded = new Map<string, number>()
    const enableVersion = new Map<string, number>()

    function sessionInfo(sessionID: string, directory: string) {
      const session = serverSync().child(directory, { bootstrap: false })[0].session
      return session.find((item) => item.id === sessionID)
    }

    function sessionMetadataProfile(sessionID: string, directory: string) {
      // Session metadata historically embedded a frozen copy of the global
      // safety review. Read it mode-only so sessions follow reviewer changes.
      return sessionMetadataAccessControlProfile(
        sessionInfo(sessionID, directory)?.metadata?.[ACCESS_CONTROL_METADATA_KEY],
      )
    }

    function userDefaultProfile() {
      // Live server config wins over the persisted mirror: the mirror can hold
      // a stale safety-review copy from before the reviewer was changed.
      return liveAccessControlProfile(
        serverSync().data.config.access_control,
        store.accessControl.user,
      )
    }

    function projectDefaultProfile(directory: string) {
      return liveAccessControlProfile(
        serverSync().child(directory, { bootstrap: false })[0].config.access_control,
        store.accessControl.project[directoryAcceptKey(directory)],
      )
    }

    function configDerivedProfile(directory: string) {
      const permission = serverSync().child(directory, { bootstrap: false })[0].config.permission
      if (!permission) return undefined
      if (typeof permission === "string") {
        if (permission === "allow") return accessControlProfile("full_access")
        if (permission === "ask") return accessControlProfile("ask")
        return accessControlProfile("ask")
      }
      if (hasPermissionPromptRules(permission)) return accessControlProfile("ask")
      return accessControlProfile("full_access")
    }

    function legacyProfile(sessionID: string | undefined, directory: string) {
      if (!sessionID) return isDirectoryAutoAccepting(store.autoAccept, directory) ? accessControlProfile("full_access") : undefined
      if (!directory) return store.autoAccept[sessionID] ? accessControlProfile("full_access") : undefined
      const session = serverSync().child(directory, { bootstrap: false })[0].session
      return autoRespondsPermission(store.autoAccept, session, { sessionID }, directory)
        ? accessControlProfile("full_access")
        : undefined
    }

    function withSafetyReview(profile: AccessControlProfile): AccessControlProfile {
      // The safety review is global server-config state. Only attach it when
      // the profile does not carry its own; never freeze a mirror copy here.
      if (profile.safety_review) return profile
      if (profile.mode !== "approve_for_me") return { mode: profile.mode }
      return { ...profile, safety_review: globalSafetyReview() }
    }

    function effectiveProfile(sessionID: string | undefined, directory: string) {
      if (sessionID) {
        return withSafetyReview(
          store.accessControl.session[acceptKey(sessionID, directory)] ??
            sessionMetadataProfile(sessionID, directory) ??
            userDefaultProfile() ??
            projectDefaultProfile(directory) ??
            configDerivedProfile(directory) ??
            legacyProfile(sessionID, directory) ??
            accessControlProfile("approve_for_me"),
        )
      }

      return withSafetyReview(
        store.accessControl.workspace[directoryAcceptKey(directory)] ??
          userDefaultProfile() ??
          projectDefaultProfile(directory) ??
          configDerivedProfile(directory) ??
          legacyProfile(undefined, directory) ??
          accessControlProfile("approve_for_me"),
      )
    }

    function pruneResponded(now: number) {
      for (const [id, ts] of responded) {
        if (now - ts < RESPONDED_TTL_MS) break
        responded.delete(id)
      }

      for (const id of responded.keys()) {
        if (responded.size <= MAX_RESPONDED) break
        responded.delete(id)
      }
    }

    const respond: PermissionRespondFn = (input) => respondPermission(serverSDK().client, input)

    function respondOnce(permission: PermissionRequest, directory?: string) {
      const now = Date.now()
      const hit = responded.has(permission.id)
      responded.delete(permission.id)
      responded.set(permission.id, now)
      pruneResponded(now)
      if (hit) return
      respond({
        request: permission,
        response: "once",
        directory,
      }).catch(() => {
        responded.delete(permission.id)
      })
    }

    function isAutoAccepting(sessionID: string, directory?: string) {
      if (!directory) return legacyProfile(sessionID, "")?.mode === "full_access"
      return accessControlRespondsPermission(effectiveProfile(sessionID, directory), { permission: "read" })
    }

    function isAutoAcceptingDirectory(directory: string) {
      return accessControlRespondsPermission(effectiveProfile(undefined, directory), { permission: "read" })
    }

    function shouldAutoRespond(permission: PermissionRequest, directory?: string) {
      if (!directory) return legacyProfile(permission.sessionID, "")?.mode === "full_access"
      return accessControlRespondsPermission(effectiveProfile(permission.sessionID, directory), permission)
    }

    function bumpEnableVersion(sessionID: string, directory?: string) {
      const key = acceptKey(sessionID, directory)
      const next = (enableVersion.get(key) ?? 0) + 1
      enableVersion.set(key, next)
      return next
    }

    const unsubscribe = serverSDK().event.listen((e) => {
      const event = e.details
      if (event?.type !== "permission.asked" && event?.type !== "permission.v2.asked") return

      const perm = normalizePermissionRequest(event.properties)
      if (!shouldAutoRespond(perm, e.name)) return

      respondOnce(perm, e.name)
    })
    onCleanup(unsubscribe)

    function disable(sessionID: string, directory?: string) {
      bumpEnableVersion(sessionID, directory)
      const key = directory ? acceptKey(sessionID, directory) : sessionID
      setStore(
        produce((draft) => {
          draft.autoAccept[key] = false
          if (!directory) return
          delete draft.autoAccept[sessionID]
        }),
      )
    }

    function replayPending(sessionID: string | undefined, directory: string) {
      loadPendingPermissions(serverSDK().client, directory)
        .then((snapshot) => {
          for (const perm of snapshot.pending) {
            if (!perm?.id) continue
            if (sessionID && perm.sessionID !== sessionID) continue
            if (!shouldAutoRespond(perm, directory)) continue
            respondOnce(perm, directory)
          }
        })
        .catch(() => undefined)
    }

    function writeSessionProfile(sessionID: string, directory: string, profile: AccessControlProfile) {
      // Session metadata carries the mode only; the reviewer always resolves
      // from live global config at execution time and must never be frozen
      // into per-session metadata.
      const stored = accessControlModeProfile(profile)
      const current = sessionInfo(sessionID, directory)?.metadata ?? {}
      if (JSON.stringify(current[ACCESS_CONTROL_METADATA_KEY]) === JSON.stringify(stored)) return Promise.resolve()
      return serverSDK()
        .client.session.update({
          sessionID,
          directory,
          metadataPatch: setSessionMetadata(ACCESS_CONTROL_METADATA_KEY, stored),
        })
        .then(() => undefined)
        .catch(() => undefined)
    }

    function syncAccessControlProfile(sessionID: string, directory: string) {
      const stored = accessControlModeProfile(effectiveProfile(sessionID, directory))
      const current = sessionInfo(sessionID, directory)?.metadata ?? {}
      if (JSON.stringify(current[ACCESS_CONTROL_METADATA_KEY]) === JSON.stringify(stored)) return Promise.resolve()
      const metadata = {
        ...current,
        [ACCESS_CONTROL_METADATA_KEY]: stored,
      }
      setTimeout(() => {
        void serverSDK()
          .client.session.update({
            sessionID,
            directory,
            metadataPatch: setSessionMetadata(ACCESS_CONTROL_METADATA_KEY, stored),
          })
          .then(() => undefined)
          .catch(() => undefined)
      }, 250)
      serverSync().child(directory, { bootstrap: false })[1](
        "session",
        produce((draft) => {
          const session = draft.find((item) => item.id === sessionID)
          if (session) session.metadata = metadata
        }),
      )
      return Promise.resolve()
    }

    function sessionProfileMetadata(profile: AccessControlProfile, metadata?: Record<string, unknown>) {
      // Same contract as writeSessionProfile: persist the mode only so the
      // reviewer stays owned by live global config.
      return {
        ...(metadata ?? {}),
        [ACCESS_CONTROL_METADATA_KEY]: accessControlModeProfile(profile),
      }
    }

    function setProjectDefault(directory: string, profile: AccessControlProfile) {
      setStore(
        produce((draft) => {
          draft.accessControl.project[directoryAcceptKey(directory)] = accessControlModeProfile(profile)
        }),
      )
      serverSDK()
        .client.config.update({ directory, config: { access_control: accessControlModeProfile(profile) } })
        .catch(() => undefined)
    }

    function setUserDefault(profile: AccessControlProfile) {
      setStore(
        produce((draft) => {
          draft.accessControl.user = accessControlModeProfile(profile)
        }),
      )
      // Merge instead of replace so a default-mode write can never clobber the
      // global safety_review living in the same config object.
      serverSync()
        .updateConfig((config) => ({
          access_control: {
            ...(isRecord(config.access_control) ? config.access_control : {}),
            ...accessControlModeProfile(profile),
          },
        }))
        .catch(() => undefined)
    }

    function setAccessControlProfile(input: { sessionID?: string; directory: string; profile: AccessControlProfile }) {
      const profile = input.profile
      if (input.sessionID) {
        const sessionID = input.sessionID
        setStore(
          produce((draft) => {
            draft.accessControl.session[acceptKey(sessionID, input.directory)] = profile
          }),
        )
        void writeSessionProfile(sessionID, input.directory, profile)
      } else {
        setStore(
          produce((draft) => {
            draft.accessControl.workspace[directoryAcceptKey(input.directory)] = profile
          }),
        )
      }

      if (store.accessControl.updateProjectDefault) setProjectDefault(input.directory, profile)
      if (store.accessControl.updateUserDefault) setUserDefault(profile)
      replayPending(input.sessionID, input.directory)
    }

    function applySessionAccessControlProfile(input: { sessionID: string; directory: string; profile: AccessControlProfile }) {
      setStore(
        produce((draft) => {
          draft.accessControl.session[acceptKey(input.sessionID, input.directory)] = input.profile
        }),
      )
      const result = writeSessionProfile(input.sessionID, input.directory, input.profile)
      replayPending(input.sessionID, input.directory)
      return result
    }

    function setAccessControlMode(input: { sessionID?: string; directory: string; mode: AccessControlMode }) {
      const current = effectiveProfile(input.sessionID, input.directory)
      setAccessControlProfile({
        ...input,
        profile: accessControlModeProfile({ ...current, mode: input.mode }),
      })
    }

    function applyAccessControlDefault(sessionID: string, directory: string) {
      const profile = accessControlModeProfile(effectiveProfile(undefined, directory))
      setStore(
        produce((draft) => {
          draft.accessControl.session[acceptKey(sessionID, directory)] = profile
        }),
      )
      writeSessionProfile(sessionID, directory, profile)
      replayPending(sessionID, directory)
    }

    return {
      ready,
      respond,
      autoResponds(permission: PermissionRequest, directory?: string) {
        return shouldAutoRespond(permission, directory)
      },
      isAutoAccepting,
      isAutoAcceptingDirectory,
      toggleAutoAccept(sessionID: string, directory: string) {
        setAccessControlMode({ sessionID, directory, mode: isAutoAccepting(sessionID, directory) ? "ask" : "full_access" })
      },
      toggleAutoAcceptDirectory(directory: string) {
        setAccessControlMode({ directory, mode: isAutoAcceptingDirectory(directory) ? "ask" : "full_access" })
      },
      enableAutoAccept(sessionID: string, directory: string) {
        if (isAutoAccepting(sessionID, directory)) return
        setAccessControlMode({ sessionID, directory, mode: "full_access" })
      },
      disableAutoAccept(sessionID: string, directory?: string) {
        if (!directory) {
          disable(sessionID, directory)
          return
        }
        setAccessControlMode({ sessionID, directory, mode: "ask" })
      },
      accessControlProfile: effectiveProfile,
      globalSafetyReview,
      globalConfigReady() {
        return serverSync().configLoaded && serverSync().data.ready
      },
      setGlobalSafetyReview,
      setAccessControlMode,
      applySessionAccessControlProfile,
      syncAccessControlProfile,
      sessionProfileMetadata,
      applyAccessControlDefault,
      accessControlUpdateProjectDefault() {
        return store.accessControl.updateProjectDefault
      },
      accessControlUpdateUserDefault() {
        return store.accessControl.updateUserDefault
      },
      setAccessControlUpdateProjectDefault(value: boolean) {
        setStore("accessControl", "updateProjectDefault", value)
      },
      setAccessControlUpdateUserDefault(value: boolean) {
        setStore("accessControl", "updateUserDefault", value)
      },
      permissionsEnabled,
      isPermissionAllowAll(directory: string) {
        const [childStore] = serverSync().child(directory)
        const perm = childStore.config.permission
        return typeof perm === "string" && perm === "allow"
      },
    }
  },
})
