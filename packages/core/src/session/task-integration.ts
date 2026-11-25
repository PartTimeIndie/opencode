export * as TaskIntegration from "./task-integration"

import { Effect, Schema } from "effect"
import { and, desc, eq, isNull } from "drizzle-orm"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import fs from "node:fs/promises"
import path from "node:path"
import type { ContentStore } from "../content-store"
import type { Database } from "../database/database"
import { EventV2 } from "../event"
import { PermissionV2 } from "../permission"
import type { AgentV2 } from "../agent"
import type { SessionStore } from "./store"
import type { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { WorkspaceCheckout } from "./workspace/checkout"
import { WorkspaceBasis } from "./workspace/basis"
import { WorkspaceReconcile } from "./workspace/reconcile"
import { SessionExecutionOwner } from "./execution/owner"
import { FileMutation } from "../file-mutation"
import type { SessionFileMutation } from "./file-mutation"
import { SessionActivityTable, SessionInputTable } from "./sql"

export class Blocked extends Schema.TaggedErrorClass<Blocked>()("TaskIntegration.Blocked", {
  reason: Schema.Literals(["child", "state", "io", "drift", "conflicts", "consent", "authority"]),
}) {
  override get message() {
    return this.reason === "drift"
      ? "Main changed between the reviewed integration plan and its application; prepare the plan again"
      : this.reason === "conflicts"
        ? "The child workspace update has conflicts that need explicit resolution before any Main change"
        : this.reason === "authority"
          ? "The live write authority for this integration disappeared before commit"
          : `Native task integration refused (${this.reason})`
  }
}

export type Dependencies = {
  readonly db: Database.Interface["db"]
  readonly store: SessionStore.Interface
  readonly content: ContentStore.Interface
  readonly permission: PermissionV2.Interface
  readonly checkouts: WorkspaceCheckout.Interface
  readonly files: FileMutation.Interface
  readonly journal: SessionFileMutation.Interface
}

export type Change = {
  readonly path: string
  readonly operation: "write" | "delete"
  readonly sha256: string | null
  readonly bytes: number | null
  readonly mode: number | null
  readonly mainSha256: string | null
  readonly mainMode: number | null
}

export type Plan =
  | { readonly status: "conflicts"; readonly conflicts: readonly WorkspaceReconcile.Conflict[] }
  | { readonly status: "ready"; readonly planDigest: string; readonly changes: readonly Change[] }

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** Only a verified absence at a physically contained regular file counts as a
 * deletion candidate. Symlinks, escapes and every other I/O failure refuse the
 * whole preparation instead of silently becoming Main deletions. */
const readFile = (root: string, relative: string) =>
  Effect.tryPromise({
    try: async () => {
      const realRoot = await fs.realpath(root)
      const target = path.join(realRoot, relative)
      const info = await fs.lstat(target).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return undefined
        throw new Error("io")
      })
      if (info === undefined) return undefined
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("io")
      const resolved = await fs.realpath(target)
      const contained = path.relative(realRoot, resolved)
      if (contained.startsWith("..") || path.isAbsolute(contained)) throw new Error("state")
      return { bytes: new Uint8Array(await fs.readFile(resolved)), mode: info.mode & 0o777 }
    },
    catch: (cause) => new Blocked({ reason: cause instanceof Error && cause.message === "state" ? "state" : "io" }),
  })

const terminalChild = (db: Database.Interface["db"], childID: SessionSchema.ID, allowInput?: string) =>
  Effect.gen(function* () {
    const pending = yield* db.select({ id: SessionInputTable.id }).from(SessionInputTable)
      .where(and(eq(SessionInputTable.session_id, childID), isNull(SessionInputTable.promoted_seq)))
      .limit(2).all().pipe(Effect.orDie)
    if (pending.some((row) => row.id !== allowInput)) return false
    const activity = yield* db.select({ status: SessionActivityTable.status })
      .from(SessionActivityTable).where(eq(SessionActivityTable.session_id, childID))
      .orderBy(desc(SessionActivityTable.opened_seq)).limit(1).get().pipe(Effect.orDie)
    return activity === undefined || (activity.status !== "running" && activity.status !== "recovering")
  })

/** Prepare or apply one reviewed Main update from a terminal native mirror
 * child. Preparation is read-only and never writes Main; application re-derives
 * the whole plan against the current Main, refuses drift, requires one fresh
 * single-use host consent and records every mutation in the parent journal. */
const build = Effect.fn("TaskIntegration.build")(function* (
  dependencies: Dependencies,
  input: { readonly parentID: SessionSchema.ID; readonly childID: SessionSchema.ID; readonly paths?: readonly string[] },
) {
  const parent = yield* dependencies.store.get(input.parentID)
  const child = yield* dependencies.store.get(input.childID)
  const mirror = child?.agentPolicy?.mirrorWorkspace
  const placement = child?.agentPolicy?.executionPlacement
  if (!parent || parent.revert || parent.time.archived || !child || child.parentID !== input.parentID ||
    child.agentPolicy?.source.type !== "task" || child.agentPolicy.source.sessionID !== input.parentID ||
    child.time.archived || child.revert || !mirror || mirror.taskID !== input.childID ||
    !placement || placement.directory !== child.location.directory ||
    WorkspaceBasis.digest(mirror.basis) !== mirror.basisDigest)
    return yield* new Blocked({ reason: "child" })
  if (!(yield* terminalChild(dependencies.db, input.childID))) return yield* new Blocked({ reason: "child" })
  const checkout = yield* dependencies.checkouts.resolve(parent.location.directory)
  const manifestPaths = [...mirror.basis.files.map((file) => file.path), ...mirror.basis.deletedPaths]
  const selection = input.paths === undefined ? [...manifestPaths].sort() : input.paths
  if (selection.some((entry) => !manifestPaths.includes(entry)) ||
    new Set(selection.map((entry) => entry.toLowerCase())).size !== selection.length)
    return yield* new Blocked({ reason: "state" })
  const entries = yield* Effect.forEach(selection, (entry) => Effect.gen(function* () {
    const recorded = mirror.basis.files.find((file) => file.path === entry)
    const stored = recorded === undefined ? undefined : yield* dependencies.content
      .readBlob({ sha256: recorded.sha256 })
    // The manifest digest binds the intended ancestor; re-verify the stored
    // bytes so same-length blob corruption cannot become a merge ancestor.
    if (recorded !== undefined && (stored === undefined || sha(stored) !== recorded.sha256 ||
      stored.byteLength !== recorded.bytes))
      return yield* new Blocked({ reason: "state" })
    return {
      path: entry,
      basis: recorded === undefined || stored === undefined ? undefined : { bytes: stored, mode: recorded.mode },
      // Repository-relative basis paths resolve under the mirror repository
      // root, never the child Session's private subdirectory.
      child: yield* readFile(placement.checkout, entry),
      main: yield* readFile(checkout, entry),
    }
  }))
  const reconciled = yield* WorkspaceReconcile.prepare(entries)
  if (reconciled.status === "conflicts") return { status: "conflicts" as const, conflicts: reconciled.conflicts }
  const changes: Change[] = []
  const contents = new Map<string, Uint8Array>()
  for (const [index, entry] of entries.entries()) {
    const candidate = reconciled.files[index]
    if (!candidate) return yield* new Blocked({ reason: "state" })
    const mainFile = entry.main
    const candidateFile = candidate.file
    const mainSha = mainFile === undefined ? null : sha(mainFile.bytes)
    const same = (candidateFile === undefined) === (mainFile === undefined) &&
      (candidateFile === undefined || mainFile === undefined ||
        (candidateFile.mode === mainFile.mode && sha(candidateFile.bytes) === mainSha))
    if (same) continue
    changes.push({
      path: entry.path,
      operation: candidateFile === undefined ? "delete" : "write",
      sha256: candidateFile === undefined ? null : sha(candidateFile.bytes),
      bytes: candidateFile === undefined ? null : candidateFile.bytes.byteLength,
      mode: candidateFile === undefined ? null : candidateFile.mode,
      mainSha256: mainSha,
      mainMode: mainFile === undefined ? null : mainFile.mode,
    })
    if (candidateFile !== undefined) contents.set(entry.path, candidateFile.bytes)
  }
  const planDigest = createHash("sha256").update(JSON.stringify({
    version: 2, childID: input.childID, basisDigest: mirror.basisDigest, selection,
    changes: changes.map((change) => ({ ...change, path: change.path.toLowerCase() })).sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  })).digest("hex")
  return { status: "ready" as const, planDigest, changes, contents, checkout, mirror, placement }
})

export const prepare = Effect.fn("TaskIntegration.prepare")(function* (
  dependencies: Dependencies,
  input: { readonly parentID: SessionSchema.ID; readonly childID: SessionSchema.ID; readonly paths?: readonly string[] },
) {
  const plan = yield* build(dependencies, input)
  if (plan.status === "conflicts") return { status: "conflicts" as const, conflicts: plan.conflicts }
  return { status: "ready" as const, planDigest: plan.planDigest, changes: plan.changes }
})

export const apply = Effect.fn("TaskIntegration.apply")(function* (
  dependencies: Dependencies,
  input: {
    readonly parentID: SessionSchema.ID
    readonly childID: SessionSchema.ID
    readonly parentAgent: AgentV2.ID
    readonly planDigest: string
    readonly paths?: readonly string[]
    readonly assistantMessageID: SessionMessage.ID
    readonly callID: string
  },
) {
  const owner = yield* SessionExecutionOwner.assertOwner(dependencies.db, input.parentID)
  const parent = yield* dependencies.store.get(input.parentID)
  if (!parent || parent.revert || parent.time.archived) return yield* new Blocked({ reason: "child" })
  const parentCheckout = yield* dependencies.checkouts.resolve(parent.location.directory)
  const pinned = yield* WorkspaceCheckout.pinPlacement(parent.location.directory, parentCheckout)
  const plan = yield* build(dependencies, input)
  if (plan.status === "conflicts") return yield* new Blocked({ reason: "conflicts" })
  if (plan.planDigest !== input.planDigest) return yield* new Blocked({ reason: "drift" })
  if (plan.changes.length === 0) return { applied: [] as readonly { path: string; sha256: string | null }[] }
  // One fresh single-use human review per plan; remembered rules and earlier
  // approvals never cover this Main update.
  const authorize = dependencies.permission.assertSingleUse
  if (!authorize) return yield* new Blocked({ reason: "consent" })
  yield* authorize(PermissionV2.singleUse({
    id: PermissionV2.ID.create(), sessionID: input.parentID, agent: input.parentAgent,
    action: "task_main_integrate", resources: [`task:${input.childID}:integrate:${input.planDigest}`],
    source: { type: "tool", messageID: input.assistantMessageID, callID: input.callID },
    metadata: { purpose: "Apply exactly this reviewed mirror-task update to the physical Main checkout. Any Main change in between voids the plan.",
      childSessionID: input.childID, planDigest: input.planDigest,
      files: plan.changes.map((change) => `${change.operation} ${change.path}${change.sha256 ? ` (${change.sha256.slice(0, 12)})` : ""}`) },
  }))
  // The host click awaited: live authority, physical placement, binding and
  // terminal state are rechecked under the transaction's target locks before
  // a single byte moves, and the journal batch commits with the same fence.
  const reviewed = yield* build(dependencies, input)
  if (reviewed.status === "conflicts" || reviewed.planDigest !== input.planDigest)
    return yield* new Blocked({ reason: "drift" })
  if (reviewed.changes.some((change) => change.operation === "write" && !reviewed.contents.get(change.path)) ||
    reviewed.changes.some((change) => change.operation === "delete" && change.mainSha256 === null))
    return yield* new Blocked({ reason: "state" })
  const fence = <A, E2>(operation: Effect.Effect<A, E2>) =>
    Effect.gen(function* () {
      const live = yield* SessionExecutionOwner.assertOwner(dependencies.db, input.parentID)
      if (!isDeepStrictEqual(live, owner)) return yield* new Blocked({ reason: "authority" })
      yield* WorkspaceCheckout.revalidatePlacement(pinned).pipe(
        Effect.catch(() => new Blocked({ reason: "authority" })),
      )
      const child = yield* dependencies.store.get(input.childID)
      const mirror = child?.agentPolicy?.mirrorWorkspace
      if (!child || child.revert || child.time.archived || !mirror || mirror.taskID !== input.childID ||
        mirror.inputID === undefined || mirror.dispatchDigest !== child.agentPolicy?.mirrorWorkspace?.dispatchDigest ||
        !(yield* terminalChild(dependencies.db, input.childID)))
        return yield* new Blocked({ reason: "authority" })
      return yield* operation
    }).pipe(Effect.mapError((error) =>
      error instanceof Blocked ? error : new Blocked({ reason: "authority" })))
  const results = yield* dependencies.files.transact<Blocked>(
    reviewed.changes.map((change) => {
      const target = { canonical: path.join(reviewed.checkout, change.path), resource: change.path }
      if (change.operation === "delete")
        return { type: "delete" as const, target,
          expected: { exists: true as const, sha256: change.mainSha256 ?? "", mode: change.mainMode ?? undefined } }
      const bytes = reviewed.contents.get(change.path)
      return change.mainSha256 === null
        ? { type: "add" as const, target, content: bytes ?? "", mode: change.mode ?? undefined }
        : { type: "update" as const, target, content: bytes ?? "", mode: change.mode ?? undefined,
          expected: { exists: true as const, sha256: change.mainSha256, mode: change.mainMode ?? undefined } }
    }),
    {
      fence,
      journal: (settled) => EventV2.atomic(dependencies.db, dependencies.journal.record({
        sessionID: input.parentID, assistantMessageID: input.assistantMessageID, callID: input.callID,
        mutations: settled.map((result) => result.mutation),
      })).pipe(Effect.mapError(() => new Blocked({ reason: "io" }))),
    },
  )
  return {
    applied: results.map((result, index) => ({
      path: reviewed.changes[index]?.path ?? result.target,
      sha256: result.checkpoint.after.sha256 ?? null,
    })),
  }
})
