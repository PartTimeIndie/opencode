export * as MirrorClose from "./mirror-close"

import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { Effect, Schema } from "effect"
import type { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { PermissionV2 } from "../../permission"
import type { AgentV2 } from "../../agent"
import type { SessionStore } from "../store"
import type { SessionMessage } from "../message"
import type { SessionSchema } from "../schema"
import { WorkspaceCheckout } from "./checkout"
import { WorkspaceReconcile } from "./reconcile"
import { AgentMirror } from "./agent-mirror"
import { MirrorSession } from "./mirror-session"
import { SessionExecutionOwner } from "../execution/owner"
import { FileMutation } from "../../file-mutation"
import type { SessionFileMutation } from "../file-mutation"

export class CloseError extends Schema.TaggedErrorClass<CloseError>()("MirrorClose.CloseError", {
  message: Schema.String,
}) {}

export class Blocked extends Schema.TaggedErrorClass<Blocked>()("MirrorClose.Blocked", {
  reason: Schema.Literals(["session", "state", "io", "drift", "conflicts", "consent", "authority"]),
}) {
  override get message() {
    return this.reason === "drift"
      ? "The source changed between the reviewed integration plan and its application; prepare the plan again"
      : this.reason === "conflicts"
        ? "The mirror update has conflicts that need explicit resolution before any source change"
        : this.reason === "authority"
          ? "The live write authority for this integration disappeared before commit"
          : `Standalone mirror integration refused (${this.reason})`
  }
}

export type Dependencies = {
  readonly db: Database.Interface["db"]
  readonly store: SessionStore.Interface
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

export type Conflict = { readonly path: string; readonly reason: string }

export type Plan =
  | { readonly status: "conflicts"; readonly conflicts: readonly Conflict[] }
  | { readonly status: "ready"; readonly planDigest: string; readonly changes: readonly Change[] }

type Input = { readonly directory: string; readonly sessionID: string; readonly root: string }
type File = { readonly bytes: Uint8Array; readonly mode: number }
type Located = Awaited<ReturnType<typeof MirrorSession.locate>>
type Derivation =
  | ({ readonly status: "conflicts"; readonly conflicts: readonly Conflict[] } & Pick<Located, "slot" | "lease">)
  | ({ readonly status: "ready"; readonly planDigest: string; readonly changes: readonly Change[]
      readonly contents: ReadonlyMap<string, Uint8Array> } & Pick<Located, "slot" | "lease">)

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** Read one repository-relative candidate. Every existing ancestor must be a
 * plain contained directory and an existing leaf a regular contained file, so
 * symlinks and junctions can never move a read or write outside its root. A
 * missing leaf is absence; a missing ancestor means the whole remainder is
 * absent, which only an add may produce. */
async function entryFile(root: string, relative: string): Promise<File | undefined> {
  const realRoot = await fs.realpath(root)
  const parts = relative.split("/")
  for (const [index] of parts.entries()) {
    const current = path.join(realRoot, ...parts.slice(0, index + 1))
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw new Error(`Mirror path is unreadable: ${relative}`)
    })
    if (!stat) return undefined
    if (index < parts.length - 1) {
      if (!stat.isDirectory()) throw new Error(`Mirror path is not a directory: ${relative}`)
      if (!inside(realRoot, await fs.realpath(current))) throw new Error(`Mirror path escapes its root: ${relative}`)
      continue
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Mirror path is not a regular file: ${relative}`)
    const resolved = await fs.realpath(current)
    if (!inside(realRoot, resolved)) throw new Error(`Mirror path escapes its root: ${relative}`)
    return { bytes: new Uint8Array(await fs.readFile(resolved)), mode: stat.mode & 0o777 }
  }
}

function inside(root: string, file: string) {
  const relative = path.relative(root, file)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

function sameBytes(a: File, b: File) {
  return a.bytes.byteLength === b.bytes.byteLength && sha(a.bytes) === sha(b.bytes)
}

function equal(a: File | undefined, b: File | undefined) {
  return a === undefined || b === undefined ? a === b : a.mode === b.mode && sameBytes(a, b)
}

function ignored(directory: string, file: string) {
  return new Promise<boolean>((resolve, reject) => {
    execFile("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "check-ignore", "-q", "--", file],
      { cwd: directory, windowsHide: true,
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))),
          GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
          GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" } },
      (error) => {
        if (!error) return resolve(true)
        if (typeof error.code === "number" && error.code === 1) return resolve(false)
        reject(new Error(`Could not determine ignore state for ${file}`))
      })
  })
}

/** Read-only fenced Git line listing: no hooks, no repository or inherited
 * execution overrides, user ignores explicitly included by the caller. */
function gitLines(directory: string, args: readonly string[], readUserIgnores = false) {
  return new Promise<string[]>((resolve, reject) => {
    execFile("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", ...args],
      { cwd: directory, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: "buffer",
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))),
          GIT_CONFIG_GLOBAL: readUserIgnores ? process.env.GIT_CONFIG_GLOBAL : "/dev/null",
          GIT_CONFIG_NOSYSTEM: readUserIgnores ? process.env.GIT_CONFIG_NOSYSTEM : "1",
          GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" } },
      (error, stdout) => {
        if (error) return reject(new Error(`Git listing failed in ${directory}`))
        resolve(new TextDecoder("utf-8", { fatal: true }).decode(stdout).split("\0").filter(Boolean))
      })
  })
}

/** Digest over the mirror's current merge-relevant content. Stored with the
 * integrated marker so a later discard re-proves the mirror never changed
 * after the accepted integration. */
async function contentDigest(directory: string) {
  const items = []
  for (const relative of (await AgentMirror.integrationPaths(directory)).sort()) {
    const stat = await fs.lstat(path.join(directory, relative)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!stat || !stat.isFile()) throw new Error("Mirror content digest requires regular files")
    items.push({ path: relative, sha256: sha(new Uint8Array(await fs.readFile(path.join(directory, relative)))),
      mode: stat.mode & 0o777 })
  }
  return sha(Buffer.from(JSON.stringify(items)))
}

/** Read-only plan derivation for one Session-owned standalone mirror. Reads
 * source files only for real merge candidates and never for unchanged or
 * inadmissible paths; writes nothing. */
async function derive(input: Input): Promise<Derivation> {
  const located = await MirrorSession.locate(input)
  const slot = located.slot
  const lease = located.lease
  if (lease.basisSnapshotDigest === undefined)
    throw new Error("Basis snapshot is missing; preserve the Mirror for inspection")
  const source = lease.source
  const recorded = new Map(located.basis.files.map((file) => [file.path, file]))
  // Mirror-side ignored names are enumerated only inside the private mirror so
  // new work at an ignored target becomes an explicit conflict instead of
  // silently vanishing from the merge; the source side is never enumerated.
  const mirrorIgnored = await gitLines(lease.directory,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], true)
  const candidates = [...new Set([...located.basis.files.map((file) => file.path), ...located.basis.deletedPaths,
    ...await AgentMirror.integrationPaths(lease.directory), ...mirrorIgnored])].sort()
  const cleanUntracked = new Set(await AgentMirror.untrackedPaths(source))
  // integrationPaths is cached ∪ clean-untracked, so its difference against the
  // clean-untracked set is exactly the currently tracked index without another
  // Git subprocess.
  const tracked = new Set((await AgentMirror.integrationPaths(source)).filter((file) => !cleanUntracked.has(file)))
  const entries: { path: string; basis: File | undefined; child: File | undefined; main: File | undefined }[] = []
  const conflicts: Conflict[] = []
  for (const relative of candidates) {
    const child = await entryFile(lease.directory, relative)
    const basisEntry = recorded.get(relative)
    if (basisEntry === undefined && child === undefined) continue
    const basis = basisEntry === undefined ? undefined
      : { bytes: await MirrorSession.readBasisBlob(slot, basisEntry), mode: basisEntry.mode }
    if (equal(child, basis)) continue
    if (!tracked.has(relative) && !cleanUntracked.has(relative)) {
      if (basisEntry !== undefined) {
        conflicts.push({ path: relative, reason: "private" })
        continue
      }
      if (await ignored(source, relative)) {
        conflicts.push({ path: relative, reason: "ignored" })
        continue
      }
    }
    entries.push({ path: relative, basis, child, main: await entryFile(source, relative) })
  }
  if (conflicts.length) return { slot, lease, status: "conflicts", conflicts }
  const reconciled = await Effect.runPromise(WorkspaceReconcile.prepare(entries)).catch((error) => {
    throw new Error(error instanceof Error ? error.message : "Workspace merge preparation failed")
  })
  if (reconciled.status === "conflicts") return { slot, lease, status: "conflicts", conflicts: reconciled.conflicts }
  const changes: Change[] = []
  const contents = new Map<string, Uint8Array>()
  for (const [index, entry] of entries.entries()) {
    const candidate = reconciled.files[index]
    if (!candidate) throw new Error("Workspace merge lost a candidate")
    const mainSha = entry.main === undefined ? null : sha(entry.main.bytes)
    const same = (candidate.file === undefined) === (entry.main === undefined) &&
      (candidate.file === undefined || entry.main === undefined ||
        (candidate.file.mode === entry.main.mode && sha(candidate.file.bytes) === mainSha))
    if (same) continue
    changes.push({
      path: entry.path,
      operation: candidate.file === undefined ? "delete" : "write",
      sha256: candidate.file === undefined ? null : sha(candidate.file.bytes),
      bytes: candidate.file === undefined ? null : candidate.file.bytes.byteLength,
      mode: candidate.file === undefined ? null : candidate.file.mode,
      mainSha256: mainSha,
      mainMode: entry.main === undefined ? null : entry.main.mode,
    })
    if (candidate.file !== undefined) contents.set(entry.path, candidate.file.bytes)
  }
  const planDigest = createHash("sha256").update(JSON.stringify({
    version: 1, sessionID: lease.sessionID, basisDigest: lease.basisDigest,
    changes: changes.map((change) => ({ ...change, path: change.path.toLowerCase() })).sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  })).digest("hex")
  return { slot, lease, status: "ready", planDigest, changes, contents }
}

/** Read-only close preparation: the reviewed merge plan for this Session's
 * standalone mirror, or explicit conflicts. Never writes the source. */
export async function close(request: Input): Promise<Plan> {
  const state = await derive(structuredClone(request))
  return state.status === "conflicts"
    ? { status: "conflicts", conflicts: state.conflicts }
    : { status: "ready", planDigest: state.planDigest, changes: state.changes }
}

const deriveEffect = (input: Input) =>
  Effect.tryPromise({ try: () => derive(input), catch: (cause) =>
    new CloseError({ message: cause instanceof Error ? cause.message : "Mirror close preparation failed" }) })

async function markIntegrated(slot: string, mirrorDirectory: string, planDigest: string, changes: number) {
  await fs.writeFile(path.join(slot, "integrated.json"), JSON.stringify({
    version: 1, planDigest, integratedAt: new Date().toISOString(), changes,
    mirrorDigest: await contentDigest(mirrorDirectory),
  }), { flag: "wx" })
}

/** Prepare or apply one reviewed standalone-mirror update into this Session's
 * source checkout. Preparation is read-only; application re-derives the whole
 * plan against the current source, refuses drift, requires one fresh
 * single-use host consent for the exact plan and records every mutation in
 * this Session's file-mutation journal. This is the only supported route into
 * the source; the CLI never writes it. */
export const integrate = Effect.fn("MirrorClose.integrate")(function* (
  dependencies: Dependencies,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly agent: AgentV2.ID
    readonly planDigest: string
    readonly root: string
    readonly assistantMessageID: SessionMessage.ID
    readonly callID: string
  },
) {
  const owner = yield* SessionExecutionOwner.assertOwner(dependencies.db, input.sessionID)
  const session = yield* dependencies.store.get(input.sessionID)
  if (!session || session.revert || session.time.archived) return yield* new Blocked({ reason: "session" })
  const checkout = yield* dependencies.checkouts.resolve(session.location.directory)
  const pinned = yield* WorkspaceCheckout.pinPlacement(session.location.directory, checkout)
  const deriveInput = { directory: session.location.directory, sessionID: input.sessionID, root: input.root }
  const state = yield* deriveEffect(deriveInput)
  if (state.status === "conflicts") return yield* new Blocked({ reason: "conflicts" })
  if (state.planDigest !== input.planDigest) return yield* new Blocked({ reason: "drift" })
  if (state.changes.length === 0) {
    yield* Effect.tryPromise({ try: () => markIntegrated(state.slot, state.lease.directory, input.planDigest, 0),
      catch: (cause) => new CloseError({ message: cause instanceof Error ? cause.message : "Integrated marker failed" }) })
    return { applied: [] as readonly { path: string; sha256: string | null }[], integrated: true }
  }
  // One fresh single-use human review per plan; remembered rules and earlier
  // approvals never cover this source update.
  const authorize = dependencies.permission.assertSingleUse
  if (!authorize) return yield* new Blocked({ reason: "consent" })
  yield* authorize(PermissionV2.singleUse({
    id: PermissionV2.ID.create(), sessionID: input.sessionID, agent: input.agent,
    action: "mirror_main_integrate", resources: [`mirror:${input.sessionID}:integrate:${input.planDigest}`],
    source: { type: "tool", messageID: input.assistantMessageID, callID: input.callID },
    metadata: { purpose: "Apply exactly this reviewed standalone-mirror update to the source checkout. Any source change in between voids the plan.",
      planDigest: input.planDigest,
      files: state.changes.map((change) => `${change.operation} ${change.path}${change.sha256 ? ` (${change.sha256.slice(0, 12)})` : ""}`) },
  }))
  const reviewed = yield* deriveEffect(deriveInput)
  if (reviewed.status !== "ready" || reviewed.planDigest !== input.planDigest)
    return yield* new Blocked({ reason: "drift" })
  const changes = reviewed.changes
  const contents = reviewed.contents
  if (changes.some((change) => change.operation === "write" && !contents.get(change.path)) ||
    changes.some((change) => change.operation === "delete" && change.mainSha256 === null))
    return yield* new Blocked({ reason: "state" })
  const fence = <A, E2>(operation: Effect.Effect<A, E2>) =>
    Effect.gen(function* () {
      const live = yield* SessionExecutionOwner.assertOwner(dependencies.db, input.sessionID)
      if (!isDeepStrictEqual(live, owner)) return yield* new Blocked({ reason: "authority" })
      yield* WorkspaceCheckout.revalidatePlacement(pinned).pipe(
        Effect.catch(() => new Blocked({ reason: "authority" })),
      )
      const current = yield* deriveEffect(deriveInput).pipe(
        Effect.mapError(() => new Blocked({ reason: "authority" })),
      )
      if (current.lease.sessionID !== state.lease.sessionID || current.status !== "ready" ||
        current.planDigest !== input.planDigest || (yield* Effect.tryPromise({
          try: () => MirrorSession.integratedMarker(current.slot).then((marker) => marker !== undefined),
          catch: () => true,
        })))
        return yield* new Blocked({ reason: "authority" })
      return yield* operation
    }).pipe(Effect.mapError((error) => error instanceof Blocked ? error : new Blocked({ reason: "authority" })))
  const results = yield* dependencies.files.transact<Blocked>(
    changes.map((change) => {
      const target = { canonical: path.join(checkout, change.path), resource: change.path }
      if (change.operation === "delete")
        return { type: "delete" as const, target,
          expected: { exists: true as const, sha256: change.mainSha256 ?? "", mode: change.mainMode ?? undefined } }
      const bytes = contents.get(change.path)
      return change.mainSha256 === null
        ? { type: "add" as const, target, content: bytes ?? "", mode: change.mode ?? undefined }
        : { type: "update" as const, target, content: bytes ?? "", mode: change.mode ?? undefined,
          expected: { exists: true as const, sha256: change.mainSha256, mode: change.mainMode ?? undefined } }
    }),
    {
      fence,
      journal: (settled) => EventV2.atomic(dependencies.db, dependencies.journal.record({
        sessionID: input.sessionID, assistantMessageID: input.assistantMessageID, callID: input.callID,
        mutations: settled.map((result) => result.mutation),
      })).pipe(Effect.mapError(() => new Blocked({ reason: "io" }))),
    },
  )
  // The integrated marker only lands after the transaction committed; a failed
  // marker write keeps discard blocked instead of hiding the gap.
  const markerError = yield* Effect.tryPromise({
    try: () => markIntegrated(state.slot, state.lease.directory, input.planDigest, changes.length).then(() => undefined),
    catch: (cause) => cause instanceof Error ? cause.message : "Integrated marker failed",
  }).pipe(Effect.catch((message: string) => Effect.succeed(message)))
  return {
    applied: results.map((result, index) => ({
      path: changes[index]?.path ?? result.target,
      sha256: result.checkpoint.after.sha256 ?? null,
    })),
    integrated: markerError === undefined,
    markerError,
  }
})

/** Explicitly authorized discard of this Session's integrated standalone
 * mirror. Requires the integrated marker and a mirror content digest that
 * still matches the one recorded at integration, so any post-integration
 * change keeps the workspace for review. Deletes only the private slot. */
export async function discard(request: Input) {
  const input = structuredClone(request)
  const state = await MirrorSession.locate(input)
  const marker = await MirrorSession.integratedMarker(state.slot)
  if (!marker) throw new Error("Mirror is not integrated; discard requires a completed integrate")
  if (await contentDigest(state.lease.directory) !== marker.mirrorDigest)
    throw new Error("Mirror changed after integration; preserve it and review before discarding")
  const resolved = await fs.realpath(state.slot)
  if (path.relative(await fs.realpath(path.dirname(state.slot)), resolved).startsWith(".."))
    throw new Error("Mirror slot escapes its storage root")
  await fs.rm(resolved, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 })
  return { status: "discarded" as const, directory: state.slot }
}
