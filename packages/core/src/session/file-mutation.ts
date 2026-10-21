export * as SessionFileMutation from "./file-mutation"

import { createHash } from "crypto"
import { asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { ContentStore } from "../content-store"
import { FileMutation } from "../file-mutation"
import { FSUtil } from "../fs-util"
import { Identifier } from "../util/identifier"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionFileBlobTable, SessionFileMutationTable, SessionMessageTable } from "./sql"

export interface RecordInput {
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly callID: string
  readonly mutations: ReadonlyArray<FileMutation.RecordedMutation>
}

export interface RestoreInput {
  readonly sessionID: SessionSchema.ID
  readonly revert: SessionSchema.Revert
  // Only an already-applied journal checkpoint may be used as the transition base.
  readonly from?: SessionSchema.Revert
}

export interface RestoreResult {
  readonly mutations: number
  readonly conflicts: SessionSchema.RevertConflict[]
  readonly verifiedEmpty?: boolean
}

export interface Interface {
  readonly record: (input: RecordInput) => Effect.Effect<void>
  readonly revert: (input: RestoreInput) => Effect.Effect<RestoreResult>
  readonly unrevert: (input: RestoreInput) => Effect.Effect<RestoreResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionFileMutation") {}

type MutationRow = typeof SessionFileMutationTable.$inferSelect
type MessageRow = typeof SessionMessageTable.$inferSelect
type RestoreMode = "revert" | "unrevert"
const decodeStoredMessage = Schema.decodeUnknownSync(SessionMessage.Message)

const baseLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const fs = yield* FSUtil.Service
    const fileMutation = yield* FileMutation.Service
    const content = yield* ContentStore.Service

    const checkpointState = (content: Uint8Array): FileMutation.CheckpointState => ({
      exists: true,
      bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    })

    const currentState = Effect.fn("SessionFileMutation.currentState")(function* (target: string) {
      return yield* fs.readFile(target).pipe(
        Effect.map(checkpointState),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed({ exists: false })),
        Effect.catch(() => Effect.succeed({ exists: true })),
      )
    })

    const insertBlob = (state: FileMutation.ContentState) => {
      if (!state.exists || state.content === undefined || state.sha256 === undefined) return Effect.void
      return content.putBlob({ bytes: state.content, mime: "application/octet-stream" }).pipe(
        Effect.flatMap((blob) =>
          blob.sha256 === state.sha256
            ? Effect.void
            : Effect.die(`File mutation content hash changed while storing: ${state.sha256}`),
        ),
        Effect.orDie,
      )
    }

    const record = Effect.fn("SessionFileMutation.record")(function* (input: RecordInput) {
      if (input.mutations.length === 0) return
      for (const mutation of input.mutations) {
        // Measured bottleneck (script/tool-round-benchmark.ts --write-bench):
        // content-addressed blob writes dominate journal cost and the two sides
        // are independent and immutable. Store them concurrently; the journal
        // row commits only after both blobs are durable.
        yield* Effect.all([insertBlob(mutation.before), insertBlob(mutation.after)], {
          concurrency: 2,
          discard: true,
        })
        yield* db
          .insert(SessionFileMutationTable)
          .values({
            id: `sfm_${Identifier.ascending()}`,
            session_id: input.sessionID,
            assistant_message_id: input.assistantMessageID,
            call_id: input.callID,
            target: mutation.target,
            resource: mutation.resource,
            before_exists: mutation.before.exists,
            before_bytes: mutation.before.bytes ?? null,
            before_sha256: mutation.before.sha256 ?? null,
            after_exists: mutation.after.exists,
            after_bytes: mutation.after.bytes ?? null,
            after_sha256: mutation.after.sha256 ?? null,
          })
          .run()
          .pipe(Effect.orDie)
      }
    })

    const blobContent = Effect.fn("SessionFileMutation.blobContent")(function* (sha256: string) {
      const managed = yield* content.readBlob({ sha256 }).pipe(Effect.orDie)
      if (managed) return managed
      const row = yield* db
        .select({ content: SessionFileBlobTable.content })
        .from(SessionFileBlobTable)
        .where(eq(SessionFileBlobTable.sha256, sha256))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.die(`Missing file mutation blob: ${sha256}`)
      return row.content
    })

    const messagesForSession = Effect.fn("SessionFileMutation.messagesForSession")(function* (
      sessionID: SessionSchema.ID,
    ) {
      return yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
    })

    const selectedMutations = Effect.fn("SessionFileMutation.selectedMutations")(function* (input: RestoreInput) {
      const messages = yield* messagesForSession(input.sessionID)
      const target = messages.find((message) => message.id === input.revert.messageID)
      if (!target) return []
      const byID = new Map(messages.map((message) => [message.id, message]))
      const mutations = yield* db
        .select()
        .from(SessionFileMutationTable)
        .where(eq(SessionFileMutationTable.session_id, input.sessionID))
        .orderBy(asc(SessionFileMutationTable.time_created), asc(SessionFileMutationTable.id))
        .all()
        .pipe(Effect.orDie)
      return mutations.filter((mutation) => ownsRevertedMutation(mutation, byID, target, input.revert.partID))
    })

    const restore = (mode: RestoreMode) =>
      Effect.fn(`SessionFileMutation.${mode}`)(function* (input: RestoreInput) {
        const range = yield* selectedMutations(input)
        const previous = input.from ? yield* selectedMutations({ sessionID: input.sessionID, revert: input.from }) : []
        const rangeIDs = new Set(range.map((mutation) => mutation.id))
        const previousIDs = new Set(previous.map((mutation) => mutation.id))
        const forward =
          mode === "revert" && input.from !== undefined && range.every((mutation) => previousIDs.has(mutation.id))
        const mutations = forward
          ? previous.filter((mutation) => !rangeIDs.has(mutation.id))
          : range.filter((mutation) => !previousIDs.has(mutation.id))
        const ignoredIDs = forward ? rangeIDs : previousIDs
        const changes = groupedChanges(mutations, forward ? "unrevert" : mode)
        const selectedIDs = new Set(mutations.map((mutation) => mutation.id))
        const timeline = yield* db
          .select()
          .from(SessionFileMutationTable)
          .orderBy(asc(SessionFileMutationTable.time_created), asc(SessionFileMutationTable.id))
          .all()
          .pipe(Effect.orDie)
        const conflicts = yield* Effect.forEach(changes, (change) =>
          currentState(change.target).pipe(
            Effect.map((actual) => {
              // Still-reverted rows are not interleaved writes. Foreign and
              // unrecorded mutations keep the same strict continuity checks.
              const path = timeline.filter(
                (mutation) => mutation.target === change.target && !ignoredIDs.has(mutation.id),
              )
              const ownedIndexes = path.flatMap((mutation, index) => (selectedIDs.has(mutation.id) ? [index] : []))
              const first = ownedIndexes[0]
              const interleaved =
                first !== undefined && path.slice(first + 1).some((mutation) => !selectedIDs.has(mutation.id))
              if (sameCheckpoint(actual, change.expected) && !interleaved && !change.discontinuous) return []
              return [
                {
                  target: change.target,
                  resource: change.resource,
                  expected: change.expected,
                  actual,
                  message: change.discontinuous
                    ? `${change.resource} has an unrecorded change between session-owned mutations.`
                    : interleaved
                      ? `${change.resource} has a later mutation from another session in the same checkout.`
                      : `${change.resource} changed outside this reverted session range.`,
                } satisfies SessionSchema.RevertConflict,
              ]
            }),
          ),
        ).pipe(Effect.map((items) => items.flat()))
        if (conflicts.length > 0) return { mutations: range.length, conflicts }

        const contents = yield* Effect.forEach(changes, (change) =>
          change.desired.exists && change.desired.sha256
            ? blobContent(change.desired.sha256)
            : change.desired.exists
              ? Effect.die(`Missing file mutation content hash: ${change.target}`)
              : Effect.succeed(undefined),
        )
        const transactions: FileMutation.TransactionChange[] = changes.flatMap(
          (change, index): FileMutation.TransactionChange[] => {
            if (!change.expected.exists && !change.desired.exists) return []
            const target = { canonical: change.target, resource: change.resource }
            if (!change.expected.exists) return [{ type: "add" as const, target, content: contents[index]! }]
            const expected = { exists: true as const, sha256: change.expected.sha256! }
            if (!change.desired.exists) return [{ type: "delete" as const, target, expected }]
            return [{ type: "update" as const, target, content: contents[index]!, expected }]
          },
        )
        const stale = yield* fileMutation.transact(transactions).pipe(
          Effect.as(false),
          Effect.catchTag("FileMutation.StaleContentError", () => Effect.succeed(true)),
          Effect.catchTag("FileMutation.TargetExistsError", () => Effect.succeed(true)),
          Effect.orDie,
        )
        if (stale) {
          return {
            mutations: range.length,
            conflicts: yield* Effect.forEach(changes, (change) =>
              currentState(change.target).pipe(
                Effect.map((actual) => ({
                  target: change.target,
                  resource: change.resource,
                  expected: change.expected,
                  actual,
                  message: `${change.resource} changed during rollback; no files were restored.`,
                })),
              ),
            ),
          }
        }
        if (mode === "unrevert" && range.length === 0) {
          const messages = yield* messagesForSession(input.sessionID)
          const target = messages.find((message) => message.id === input.revert.messageID)
          const byID = new Map(messages.map((message) => [message.id, message]))
          const owned = timeline.filter((mutation) => mutation.session_id === input.sessionID)
          // An empty suffix needs actual journal ownership too; a missing journal
          // must not masquerade as the no-op checkpoint after the final write.
          if (
            target &&
            owned.length > 0 &&
            owned.every(
              (mutation) =>
                byID.get(mutation.assistant_message_id)?.type === "assistant" &&
                !ownsRevertedMutation(mutation, byID, target, input.revert.partID),
            )
          )
            return { mutations: 0, conflicts: [], verifiedEmpty: true }
        }
        // Moving past the last write is still a verified journal transition.
        return { mutations: Math.max(range.length, previous.length), conflicts: [] }
      })

    return Service.of({ record, revert: restore("revert"), unrevert: restore("unrevert") })
  }),
)

export const layer = baseLayer.pipe(Layer.provide(FileMutation.layer.pipe(Layer.provide(FSUtil.defaultLayer))))

function ownsRevertedMutation(
  mutation: MutationRow,
  messages: ReadonlyMap<string, MessageRow>,
  target: MessageRow,
  partID: string | undefined,
) {
  const assistant = messages.get(mutation.assistant_message_id)
  if (!assistant) return false
  if (assistant.seq > target.seq) return true
  if (assistant.seq < target.seq) return false
  if (partID === undefined) return true

  const message = decodeStoredMessage({ ...target.data, id: target.id, type: target.type })
  if (message.type !== "assistant") return false
  const partIndex = message.content.findIndex((item) => item.id === partID)
  const toolIndex = message.content.findIndex((item) => item.id === mutation.call_id)
  return partIndex >= 0 && toolIndex >= partIndex
}

function groupedChanges(mutations: MutationRow[], mode: RestoreMode) {
  const groups = new Map<string, MutationRow[]>()
  for (const mutation of mutations) groups.set(mutation.target, [...(groups.get(mutation.target) ?? []), mutation])
  return Array.from(groups.values()).map((group) => {
    const first = group[0]!
    const last = group[group.length - 1]!
    return {
      target: first.target,
      resource: first.resource,
      expected: mode === "revert" ? afterState(last) : beforeState(first),
      desired: mode === "revert" ? beforeState(first) : afterState(last),
      discontinuous: group.some(
        (mutation, index) => index > 0 && !sameCheckpoint(beforeState(mutation), afterState(group[index - 1]!)),
      ),
    }
  })
}

function beforeState(row: MutationRow): FileMutation.CheckpointState {
  return row.before_exists
    ? { exists: true, bytes: row.before_bytes ?? undefined, sha256: row.before_sha256 ?? undefined }
    : { exists: false }
}

function afterState(row: MutationRow): FileMutation.CheckpointState {
  return row.after_exists
    ? { exists: true, bytes: row.after_bytes ?? undefined, sha256: row.after_sha256 ?? undefined }
    : { exists: false }
}

function sameCheckpoint(actual: FileMutation.CheckpointState, expected: FileMutation.CheckpointState) {
  if (actual.exists !== expected.exists) return false
  if (!actual.exists) return true
  return actual.sha256 !== undefined && actual.sha256 === expected.sha256
}

export const defaultLayer: Layer.Layer<Service, never, never> = layer.pipe(
  Layer.provide(ContentStore.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
)
