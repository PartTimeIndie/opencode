export * as WorkspaceCheckout from "./checkout"

import fs from "node:fs/promises"
import { realpathSync, statSync } from "node:fs"
import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { and, eq, isNull, lte, ne, or } from "drizzle-orm"
import type { Database } from "../../database/database"
import { SessionAgentPolicy } from "../agent-policy"
import { SessionExecutionOwner } from "../execution/owner"
import { SessionMessage } from "../message"
import type { SessionSchema } from "../schema"
import { SessionActivityTable, SessionInputTable, SessionTable } from "../sql"
import { WorkspaceBasis } from "./basis"

export function pathKey(value: string) {
  const file = value.replaceAll("\\", "/")
  const normalized = file === "/" || /^[a-zA-Z]:\/$/.test(file) ? file : file.replace(/\/$/, "")
  return process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized
}

export class ResolutionError extends Schema.TaggedErrorClass<ResolutionError>()("WorkspaceCheckout.ResolutionError", {
  directory: Schema.String,
}) {}

export class Blocked extends Schema.TaggedErrorClass<Blocked>()("WorkspaceCheckout.Blocked", {
  sessionID: Schema.String,
  reason: Schema.Literals([
    "missing_placement",
    "placement_changed",
    "session_directory_mismatch",
    "policy_mismatch",
    "read_only",
    "owner_lost",
    "no_target",
    "outside_checkout",
    "input_boundary",
  ]),
}) {
  override get message() {
    switch (this.reason) {
      case "missing_placement": return "The task's persisted execution placement is missing or unreadable"
      case "placement_changed": return "The task's physical execution placement changed"
      case "session_directory_mismatch": return "The task session does not own this execution directory"
      case "policy_mismatch": return "The task's policy or consent binding no longer matches this execution"
      case "read_only": return "A read-only task cannot write files"
      case "owner_lost": return "The task's execution owner is no longer active"
      case "no_target": return "The write target or checkout root is missing"
      case "outside_checkout": return "The write target is outside the task checkout"
      case "input_boundary": return "A pending session input invalidates this task assignment"
    }
  }
}

export interface Interface {
  readonly resolve: (directory: string) => Effect.Effect<string, ResolutionError>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/v2/WorkspaceCheckout") {}

const placements = new WeakMap<object, { directory: string; checkout: string; identity: string }>()

function placementIdentity(directory: string, checkout: string) {
  return JSON.stringify([directory, checkout].map((value) => {
    const physical = realpathSync(value)
    const stat = statSync(physical, { bigint: true })
    if (!stat.isDirectory()) throw new Error("Checkout placement is not a directory")
    return [pathKey(physical), String(stat.dev), String(stat.ino)]
  }))
}

/** Pin resolved placement outside admission. The final check is bounded to the
 * two pinned directories; it does not search ancestors or walk repository files. */
export const pinPlacement = (directory: string, checkout: string) => Effect.try({
  try: () => {
    const identity = placementIdentity(directory, checkout)
    const token = Object.freeze({})
    placements.set(token, { directory, checkout, identity })
    return token
  },
  catch: () => new ResolutionError({ directory }),
})

export const revalidatePlacement = (token: object) => Effect.try({
  try: () => {
    const saved = placements.get(token)
    if (!saved || placementIdentity(saved.directory, saved.checkout) !== saved.identity)
      throw new Error("Checkout placement changed")
  },
  catch: () => new ResolutionError({ directory: placements.get(token)?.directory ?? "unknown" }),
})

export const executionPlacement = (token: object) => Effect.try({
  try: () => {
    const saved = placements.get(token)
    if (!saved) throw new Error("Unknown checkout placement")
    return { version: 1 as const, ...saved }
  },
  catch: () => new ResolutionError({ directory: placements.get(token)?.directory ?? "unknown" }),
})

/** The replayed native Session policy is the owner of this ceiling. Missing
 * placement on a native dispatch child must not turn it into an ordinary chat. */
export const assertSession = Effect.fn("WorkspaceCheckout.assertSession")(function* (
  db: Pick<Database.Interface["db"], "select">,
  sessionID: SessionSchema.ID,
) {
  const session = yield* db.select({ directory: SessionTable.directory, policy: SessionTable.agent_policy,
    dispatch: SessionTable.fork_dispatch_digest }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
  if (!session?.dispatch) return false
  const placement = yield* Schema.decodeUnknownEffect(SessionAgentPolicy.ExecutionPlacement)(session.policy?.executionPlacement)
    .pipe(Effect.mapError(() => new Blocked({ sessionID, reason: "missing_placement" })))
  if (session.policy?.source.type !== "task" || pathKey(session.directory) !== pathKey(placement.directory))
    return yield* new Blocked({ sessionID, reason: "session_directory_mismatch" })
  // A follow-up scope chains admitted inputs. Pending steers may refine the
  // bound assignment only inside its original, privately owned live activity.
  // Queued work and later activities cannot reuse that assignment's ceiling.
  const boundInput = (id: string | undefined) =>
    Effect.gen(function* () {
      if (!id) return true
      const bound = yield* db.select({ promotedSeq: SessionInputTable.promoted_seq }).from(SessionInputTable)
        .where(and(eq(SessionInputTable.session_id, sessionID), eq(SessionInputTable.id, SessionMessage.ID.make(id))))
        .get().pipe(Effect.orDie)
      if (!bound) return true
      const pending = and(eq(SessionInputTable.session_id, sessionID), ne(SessionInputTable.id, SessionMessage.ID.make(id)),
        isNull(SessionInputTable.promoted_seq), isNull(SessionInputTable.held_at))
      const live = yield* db.select({ id: SessionInputTable.id }).from(SessionInputTable)
        .where(pending).limit(1).get().pipe(Effect.orDie)
      if (!live) return false
      if (bound.promotedSeq === null) return true
      const owner = yield* SessionExecutionOwner.assertOwner(db, sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!owner) return true
      const activity = yield* db.select({ openedSeq: SessionActivityTable.opened_seq }).from(SessionActivityTable)
        .where(eq(SessionActivityTable.id, owner.activityID)).get().pipe(Effect.orDie)
      if (activity?.openedSeq === null || activity?.openedSeq === undefined || activity.openedSeq >= bound.promotedSeq) return true
      const invalid = yield* db.select({ id: SessionInputTable.id }).from(SessionInputTable)
        .where(and(pending, or(ne(SessionInputTable.delivery, "steer"), lte(SessionInputTable.admitted_seq, bound.promotedSeq))))
        .limit(1).get().pipe(Effect.orDie)
      return invalid !== undefined
    })
  if (session.policy.readOnly === true) {
    if (!SessionAgentPolicy.isReadOnly(session.policy))
      return yield* new Blocked({ sessionID, reason: "policy_mismatch" })
    if (yield* boundInput(session.policy.readOnlyInputID))
      return yield* new Blocked({ sessionID, reason: "input_boundary" })
  } else if (session.policy.mirrorWorkspace) {
    const mirror = yield* Schema.decodeUnknownEffect(SessionAgentPolicy.MirrorWorkspace)(session.policy.mirrorWorkspace)
      .pipe(Effect.mapError(() => new Blocked({ sessionID, reason: "policy_mismatch" })))
    if (mirror.taskID !== sessionID || mirror.directory !== placement.directory ||
      mirror.dispatchDigest !== session.dispatch || mirror.sourcePlacement.checkout === placement.checkout ||
      mirror.basis.sourceSessionID !== session.policy.source.sessionID ||
      pathKey(mirror.basis.sourceDirectory) !== pathKey(mirror.sourcePlacement.checkout) ||
      WorkspaceBasis.digest(mirror.basis) !== mirror.basisDigest)
      return yield* new Blocked({ sessionID, reason: "policy_mismatch" })
    if (yield* boundInput(mirror.inputID))
      return yield* new Blocked({ sessionID, reason: "input_boundary" })
  } else {
    const consent = yield* Schema.decodeUnknownEffect(SessionAgentPolicy.MainWriteConsent)(session.policy.mainWriteConsent)
      .pipe(Effect.mapError(() => new Blocked({ sessionID, reason: "policy_mismatch" })))
    if (consent.dispatchDigest !== session.dispatch || consent.placementIdentity !== placement.identity)
      return yield* new Blocked({ sessionID, reason: "policy_mismatch" })
    if (yield* boundInput(consent.inputID))
      return yield* new Blocked({ sessionID, reason: "input_boundary" })
  }
  yield* Effect.try({
    try: () => {
      if (placementIdentity(placement.directory, placement.checkout) !== placement.identity)
        throw new Error("Task placement changed")
    },
    catch: () => new Blocked({ sessionID, reason: "placement_changed" }),
  })
  return true
})

export const assertRunner = Effect.fn("WorkspaceCheckout.assertRunner")(function* (
  db: Pick<Database.Interface["db"], "select">,
  sessionID: SessionSchema.ID,
) {
  if (!(yield* assertSession(db, sessionID))) return
  yield* SessionExecutionOwner.assertOwner(db, sessionID).pipe(Effect.mapError(() => new Blocked({ sessionID, reason: "owner_lost" })))
})

/** Native tools pass canonical host-resolved targets/workdirs, never raw model
 * paths. Shell's cwd fence is not an OS sandbox for arbitrary command effects. */
export const assertWrite = Effect.fn("WorkspaceCheckout.assertWrite")(function* (
  db: Pick<Database.Interface["db"], "select">,
  sessionID: SessionSchema.ID,
  canonicalTarget: string | undefined,
) {
  if (!(yield* assertSession(db, sessionID))) return
  yield* SessionExecutionOwner.assertOwner(db, sessionID).pipe(Effect.mapError(() => new Blocked({ sessionID, reason: "owner_lost" })))
  const row = yield* db.select({ policy: SessionTable.agent_policy }).from(SessionTable)
    .where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
  const root = row?.policy?.executionPlacement?.checkout
  if (row?.policy?.readOnly)
    return yield* new Blocked({ sessionID, reason: "read_only" })
  if (!root || !canonicalTarget)
    return yield* new Blocked({ sessionID, reason: "no_target" })
  const relative = path.relative(pathKey(root), pathKey(canonicalTarget))
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
    return yield* new Blocked({ sessionID, reason: "outside_checkout" })
})

/** Physical checkout identity, shared by Sessions rooted in its subdirectories.
 * This read-only traversal belongs outside database write transactions. It is
 * placement evidence, not a reservation, write grant or durable execution owner. */
export const layer = Layer.succeed(Service, Service.of({
  resolve: (directory) => Effect.tryPromise({
    try: async () => {
      const original = await fs.realpath(directory)
      const find = async (current: string): Promise<string> => {
        const git = await fs.lstat(path.join(current, ".git")).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })
        // Files and links are checkout boundaries too. Falling through a linked
        // .git would assign different ownership domains to root and subdirectory.
        if (git) return pathKey(current)
        const parent = path.dirname(current)
        return parent === current ? pathKey(original) : find(parent)
      }
      return find(original)
    },
    catch: () => new ResolutionError({ directory }),
  }),
}))
