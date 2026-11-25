export * as StructuredOutputAttempt from "./structured-output-attempt"

import { and, asc, eq, gt, isNull, ne, or, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import type { Database } from "../database/database"
import { ModelV2 } from "../model"
import { SessionMessageID } from "./message-id"
import { SessionExecutionOwner } from "./execution/owner"
import type { SessionSchema } from "./schema"

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Selection = Schema.Struct({
  id: ModelV2.ID,
  providerID: ModelV2.Ref.fields.providerID,
  variant: Schema.optional(Schema.String),
})
export const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  inputID: SessionMessageID.ID,
  inputDigest: Digest,
  schemaDigest: Digest,
  model: Selection,
  mode: Schema.Literals(["tool", "json"]),
  phase: Schema.Literals(["initial", "correction"]),
}).annotate({ identifier: "Session.StructuredOutputAttempt" })
export type Receipt = typeof Receipt.Type
export type Binding = Omit<Receipt, "version" | "phase">
export type Previous = { readonly receipt: Receipt; readonly finish?: string; readonly completed?: boolean }

/** Text-only steers refine a native task without replacing its result contract.
 * Bind the original input only inside its privately owned activity; later work
 * and unattested User rows must never inherit a previous task's schema. */
export const taskInput = Effect.fn("StructuredOutputAttempt.taskInput")(function* (
  db: Pick<Database.Interface["db"], "select">,
  sessionID: SessionSchema.ID,
) {
  const { SessionTable, SessionInputTable, SessionActivityTable, SessionMessageTable } = yield* Effect.promise(() => import("./sql"))
  const { SessionMessage } = yield* Effect.promise(() => import("./message"))
  const { MessageDecodeError } = yield* Effect.promise(() => import("./error"))
  const session = yield* db.select({ policy: SessionTable.agent_policy, dispatch: SessionTable.fork_dispatch_digest })
    .from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
  if (!session?.dispatch || session.policy?.source.type !== "task") return
  const id = session.policy.readOnlyInputID ?? session.policy.mirrorWorkspace?.inputID ?? session.policy.mainWriteConsent?.inputID
  if (!id) return
  const owner = yield* SessionExecutionOwner.assertOwner(db, sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!owner) return
  const anchor = yield* db.select({ message: SessionMessageTable }).from(SessionMessageTable)
    .innerJoin(SessionInputTable, and(eq(SessionInputTable.session_id, sessionID), eq(SessionInputTable.id, SessionMessageTable.id),
      eq(SessionInputTable.promoted_seq, SessionMessageTable.seq)))
    .innerJoin(SessionActivityTable, and(eq(SessionActivityTable.id, owner.activityID), gt(SessionMessageTable.seq, SessionActivityTable.opened_seq)))
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.id, SessionMessage.ID.make(id)),
      eq(SessionMessageTable.type, "user"))).get().pipe(Effect.orDie)
  if (!anchor) return
  const fence = yield* db.select({ id: SessionMessageTable.id }).from(SessionMessageTable)
    .leftJoin(SessionInputTable, and(eq(SessionInputTable.session_id, sessionID), eq(SessionInputTable.id, SessionMessageTable.id),
      eq(SessionInputTable.promoted_seq, SessionMessageTable.seq)))
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user"), gt(SessionMessageTable.seq, anchor.message.seq),
      or(isNull(SessionInputTable.id), ne(SessionInputTable.delivery, "steer"))))
    .limit(1).get().pipe(Effect.orDie)
  if (fence) return
  return yield* Schema.decodeUnknownEffect(SessionMessage.User)({ ...anchor.message.data, id: anchor.message.id, type: "user" }).pipe(
    Effect.mapError(() => new MessageDecodeError({ sessionID, messageID: SessionMessage.ID.make(anchor.message.id) })),
  )
})

/** Read the durable messages, not the compacted provider window. Old rows create no claims. */
export const load = Effect.fn("StructuredOutputAttempt.load")(function* (
  db: Pick<Database.Interface["db"], "select">,
  sessionID: SessionSchema.ID,
  inputID: SessionMessageID.ID,
) {
  const { SessionMessageTable } = yield* Effect.promise(() => import("./sql"))
  const rows = yield* db.select({
    receipt: sql<string>`json_extract(${SessionMessageTable.data}, '$.structuredOutputAttempt')`,
    finish: sql<string | null>`json_extract(${SessionMessageTable.data}, '$.finish')`,
    completed: sql<number>`json_type(${SessionMessageTable.data}, '$.structured') IS NOT NULL`,
  }).from(SessionMessageTable).where(and(
    eq(SessionMessageTable.session_id, sessionID),
    eq(SessionMessageTable.type, "assistant"),
    sql`json_extract(${SessionMessageTable.data}, '$.structuredOutputAttempt.inputID') = ${inputID}`,
  )).orderBy(asc(SessionMessageTable.seq)).limit(1001).all().pipe(Effect.orDie)
  if (rows.length > 1000) return yield* Effect.die("Structured-output attempt history exceeds its supported bound")
  return yield* Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(Schema.fromJsonString(Receipt))(row.receipt).pipe(
    Effect.map((receipt): Previous => ({ receipt, finish: row.finish ?? undefined, ...(row.completed ? { completed: true } : {}) })),
  ))
})

/** Digests bind immutable admitted work, without copying private prompts into diagnostics. */
export function bind(input: {
  readonly inputID: SessionMessageID.ID
  readonly input: unknown
  readonly schema: unknown
  readonly model: typeof Selection.Type
  readonly mode: Receipt["mode"]
}): Binding {
  return {
    inputID: input.inputID,
    inputDigest: digest(input.input),
    schemaDigest: digest(input.schema),
    model: { id: input.model.id, providerID: input.model.providerID, variant: input.model.variant },
    mode: input.mode,
  }
}

/** Pure admission rule. The coordinator must publish the returned claim before HTTP. */
export function next(input: {
  readonly binding: Binding
  readonly previous: ReadonlyArray<Previous>
  readonly correction: boolean
  readonly retryCount: number
}): Receipt {
  if (!Number.isInteger(input.retryCount) || input.retryCount < 0)
    throw new Error("Invalid structured-output correction budget")
  const previous = input.previous.filter((item) => item.receipt.inputID === input.binding.inputID)
  if (previous.some((item) => item.completed))
    throw new Error("Structured-output assignment already completed; no closure or correction request is allowed")
  if (previous.some((item) => item.receipt.phase === "correction"))
    throw new Error("Structured-output correction was already consumed")
  if (previous.some((item) => item.receipt.inputDigest !== input.binding.inputDigest
    || item.receipt.schemaDigest !== input.binding.schemaDigest || item.receipt.mode !== input.binding.mode))
    throw new Error("Structured-output correction binding changed")
  if (!input.correction && previous.at(-1)?.finish === undefined && previous.length)
    throw new Error("Structured-output original attempt has an unknown outcome")
  if (input.correction) {
    if (input.retryCount === 0) throw new Error("Structured-output correction is disabled")
    const last = previous.at(-1)
    if (!last) throw new Error("Structured-output correction requires an original receipt")
    if (last.finish !== "stop" && last.finish !== "tool-calls")
      throw new Error("Structured-output correction requires a clean original finish")
    const original = last.receipt
    if (original.inputDigest !== input.binding.inputDigest || original.schemaDigest !== input.binding.schemaDigest
      || original.mode !== input.binding.mode || original.model.id !== input.binding.model.id
      || original.model.providerID !== input.binding.model.providerID
      || (original.model.variant ?? "default") !== (input.binding.model.variant ?? "default"))
      throw new Error("Structured-output correction binding changed")
  }
  return { ...input.binding, version: 1, phase: input.correction ? "correction" : "initial" }
}

function digest(value: unknown) {
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
  })
  if (encoded === undefined) throw new Error("Structured-output binding must be serializable")
  return createHash("sha256").update(encoded).digest("hex")
}
