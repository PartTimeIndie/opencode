export * as KnownFileMutation from "./known-file-mutation"

import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { ToolFailure } from "@opencode-ai/llm"
import type { Database } from "../database/database"
import { FileKnowledge } from "../file-knowledge"
import { FileMutationPendingTable } from "../file-knowledge.sql"
import { FileMutation } from "../file-mutation"
import type { LocationMutation } from "../location-mutation"
import type { SessionFileMutation } from "../session/file-mutation"
import type { Tool } from "./tool"

export type Operation = {
  type: "write" | "edit" | "add" | "delete"
  path: string
  target: LocationMutation.Target
  before?: Uint8Array
  content?: string
  expected?: FileMutation.ExpectedState
}

const text = (value: Uint8Array) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(value)
const lineCount = (value: string) => (value === "" ? 0 : value.replace(/\r?\n$/, "").split(/\r?\n/).length)
const known = (coverage: FileKnowledge.Coverage, line: number) =>
  coverage.ranges.some(([start, end]) => line >= start && line <= end)

/** Changes are checked against whole known lines. Insertions need a known anchor. */
export function changedCoverage(
  before: string,
  after: string,
  coverage: FileKnowledge.Coverage,
): FileKnowledge.Coverage | undefined {
  if (FileKnowledge.full(coverage))
    return { ranges: lineCount(after) ? [[1, lineCount(after)]] : [], end: lineCount(after) }
  const left = before.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const right = after.match(/[^\n]*\n|[^\n]+$/g) ?? []
  let prefix = 0
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++
  let suffix = 0
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - suffix - 1] === right[right.length - suffix - 1]
  )
    suffix++
  const rows = left.length - prefix - suffix
  const columns = right.length - prefix - suffix
  // Bound alignment work; a broad ambiguous edit needs a complete read instead.
  if ((rows + 1) * (columns + 1) > 1_000_000) return
  const width = columns + 1
  const alignment = new Uint32Array((rows + 1) * width)
  for (let i = rows - 1; i >= 0; i--)
    for (let j = columns - 1; j >= 0; j--)
      alignment[i * width + j] =
        left[prefix + i] === right[prefix + j]
          ? 1 + alignment[(i + 1) * width + j + 1]!
          : Math.max(alignment[(i + 1) * width + j]!, alignment[i * width + j + 1]!)
  const ranges: [number, number][] = []
  for (let i = 0; i < prefix; i++) if (known(coverage, i + 1)) ranges.push([i + 1, i + 1])
  let i = 0
  let j = 0
  while (i < rows || j < columns) {
    if (i < rows && j < columns && left[prefix + i] === right[prefix + j]) {
      if (known(coverage, prefix + i + 1)) ranges.push([prefix + j + 1, prefix + j + 1])
      i++
      j++
      continue
    }
    if (i < rows && (j === columns || alignment[(i + 1) * width + j]! >= alignment[i * width + j + 1]!)) {
      if (!known(coverage, prefix + i + 1)) return
      i++
      continue
    }
    if (!known(coverage, Math.max(1, prefix + i)) && !known(coverage, prefix + i + 1)) return
    ranges.push([prefix + j + 1, prefix + j + 1])
    j++
  }
  for (let k = 0; k < suffix; k++)
    if (known(coverage, left.length - suffix + k + 1))
      ranges.push([right.length - suffix + k + 1, right.length - suffix + k + 1])
  return FileKnowledge.merge({ ranges: [] }, { ranges, end: lineCount(after) })
}

export function commit(input: {
  context: Tool.Context
  operations: ReadonlyArray<Operation>
  database?: Database.Interface
  files: FileMutation.Interface
  resolution: LocationMutation.Interface
  journal?: SessionFileMutation.Interface
}) {
  return Effect.gen(function* () {
    if (!input.database)
      return yield* new ToolFailure({ message: "File knowledge storage is unavailable; no files were changed." })
    const db = input.database.db
    const store = FileKnowledge.make(db)
    if (!(yield* store.validContext(input.context)))
      return yield* new ToolFailure({
        message: "File knowledge request identity or frozen cutoff is missing. No files were changed.",
      })
    const operationID = randomUUID()
    const prepared = yield* Effect.forEach(input.operations, (operation) =>
      Effect.gen(function* () {
        const basis = yield* store.basisFor(input.context, operation.target.canonical)
        const actual = operation.before === undefined ? undefined : FileKnowledge.hash(operation.before)
        if (
          operation.expected &&
          (operation.expected.exists ? operation.expected.sha256 !== actual : actual !== undefined)
        )
          return yield* new ToolFailure({
            message: `Stale SHA-256 or expected state for ${operation.path}; current SHA-256: ${actual ?? "absent"}. Read the file again.`,
          })
        if (operation.type === "add" && actual !== undefined)
          return yield* new ToolFailure({
            message: `Target already exists: ${operation.path}. Read it before editing.`,
          })
        if (actual !== undefined && (!basis || basis.sha256 !== actual))
          return yield* new ToolFailure({
            message: `Read required for ${operation.path}; current SHA-256: ${actual}. No files were changed.`,
          })
        const content = operation.content ?? ""
        const coverage =
          actual === undefined
            ? ({
                ranges: lineCount(content) ? [[1, lineCount(content)]] : [],
                end: lineCount(content),
              } satisfies FileKnowledge.Coverage)
            : operation.type === "write" || operation.type === "delete"
              ? FileKnowledge.full(basis!.coverage)
                ? ({
                    ranges: lineCount(content) ? [[1, lineCount(content)]] : [],
                    end: lineCount(content),
                  } satisfies FileKnowledge.Coverage)
                : undefined
              : changedCoverage(text(operation.before!), content, basis!.coverage)
        if (!coverage)
          return yield* new ToolFailure({
            message: `Unread content in ${operation.path}. Read the affected lines (the whole file for replacement/deletion) before writing.`,
          })
        const change: FileMutation.TransactionChange =
          actual === undefined
            ? { type: "add", target: operation.target, content }
            : operation.type === "delete"
              ? { type: "delete", target: operation.target, expected: { exists: true, sha256: actual } }
              : { type: "update", target: operation.target, expected: { exists: true, sha256: actual }, content }
        return { operation, basis, coverage, change }
      }),
    )
    const clear = db
      .delete(FileMutationPendingTable)
      .where(eq(FileMutationPendingTable.operation_id, operationID))
      .run()
      .pipe(
        Effect.asVoid,
        Effect.mapError(() => new FileKnowledge.StorageError()),
      )
    const results = yield* input.files
      .transact(
        prepared.map((item) => item.change),
        {
          before: Effect.gen(function* () {
            for (const item of prepared) {
              const resolved = yield* input.resolution
                .resolve({ path: item.operation.path, kind: "file" })
                .pipe(
                  Effect.mapError(
                    () => new ToolFailure({ message: "File target changed while waiting; read and retry manually." }),
                  ),
                )
              if (resolved.canonical !== item.operation.target.canonical)
                return yield* new ToolFailure({
                  message: `File target changed: ${item.operation.path}. No files were changed.`,
                })
              const pending = yield* db
                .select()
                .from(FileMutationPendingTable)
                .where(eq(FileMutationPendingTable.target, resolved.canonical))
                .get()
                .pipe(Effect.mapError(() => new FileKnowledge.StorageError()))
              // A fresh delivered FULL read explicitly permits a new guarded attempt,
              // without silently replaying or restoring the uncertain old operation.
              if (
                pending &&
                (!item.basis ||
                  item.basis.origin !== "read" ||
                  !(yield* store.fullReadAfter(
                    input.context,
                    resolved.canonical,
                    item.basis.sha256,
                    pending.receipt_id,
                  )))
              )
                return yield* new ToolFailure({
                  message:
                    item.operation.before === undefined
                      ? `Unconfirmed missing/deleted state at ${item.operation.path}; manual recovery required. A missing file cannot satisfy a full read. Do not recreate or bypass the pending operation.`
                      : `Unconfirmed file operation at ${item.operation.path}. Read the whole current file before a new guarded attempt; a crash lock needs manual recovery.`,
                })
            }
            yield* db
              .transaction((tx) =>
                Effect.gen(function* () {
                  for (const item of prepared)
                    yield* tx
                      .insert(FileMutationPendingTable)
                      .values({
                        target: item.operation.target.canonical,
                        operation_id: operationID,
                        session_id: input.context.sessionID,
                        receipt_id: input.context.fileKnowledgeCutoff ?? item.basis?.receiptID ?? 0,
                      })
                      .onConflictDoUpdate({
                        target: FileMutationPendingTable.target,
                        set: {
                          operation_id: operationID,
                          session_id: input.context.sessionID,
                          receipt_id: input.context.fileKnowledgeCutoff ?? item.basis?.receiptID ?? 0,
                        },
                      })
                      .run()
                }),
              )
              .pipe(Effect.mapError(() => new FileKnowledge.StorageError()))
          }),
          rolledBack: clear,
          committed: (results) =>
            Effect.gen(function* () {
              for (const [index, result] of results.entries()) {
                const operation = prepared[index]!.operation
                if (
                  operation.type !== "delete" &&
                  result.checkpoint.after.sha256 !== FileKnowledge.hash(operation.content ?? "")
                )
                  return yield* new ToolFailure({
                    message: `Unconfirmed resulting content at ${operation.path}; no knowledge receipt was granted. Inspect the current file.`,
                  })
              }
              if (input.journal)
                yield* input.journal.record({
                  sessionID: input.context.sessionID,
                  assistantMessageID: input.context.assistantMessageID,
                  callID: input.context.toolCallID,
                  mutations: results.map((result) => result.mutation),
                })
              for (const [index, result] of results.entries()) {
                if (!result.checkpoint.after.exists || !result.checkpoint.after.sha256) continue
                yield* store.recordWrite({
                  ...input.context,
                  target: result.target,
                  sha256: result.checkpoint.after.sha256,
                  coverage: prepared[index]!.coverage,
                })
              }
              yield* clear
            }),
        },
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof ToolFailure
            ? error
            : new ToolFailure({
                message:
                  error instanceof FileKnowledge.StorageError
                    ? error.message
                    : error instanceof FileMutation.StaleContentError
                      ? `File changed while waiting: ${error.path}; current SHA-256: ${error.sha256 ?? "absent"}. Read the file again. No files were changed.`
                      : error instanceof FileMutation.TargetExistsError
                        ? `Target already exists: ${input.operations.find((operation) => operation.target.canonical === error.path)?.path ?? error.path}`
                        : error instanceof FileMutation.TransactionRollbackError
                          ? `Rollback unconfirmed at ${error.path}; inspect all transaction targets before continuing: ${(error.paths ?? [error.path]).join(", ")}.`
                          : error._tag === "LockTimeoutError"
                            ? "File is busy (5 minute lock wait expired). No files were changed. Retry manually later; abandoned file locks require manual recovery."
                            : "File operation failed; check current file state before continuing.",
              }),
        ),
      )
    return results
  }).pipe(
    Effect.catchTag("FileKnowledge.StorageError", (error) => Effect.fail(new ToolFailure({ message: error.message }))),
  )
}
