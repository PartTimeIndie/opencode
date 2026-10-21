export * as SessionUsage from "./usage"

import { and, desc, eq, gt, inArray, lte } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { Database } from "../database/database"
import { EventTable, EventSequenceTable } from "../event/sql"
import { EventV2 } from "../event"
import { ModelV2 } from "../model"
import { ContentStore } from "../content-store"
import { SessionSchema } from "./schema"
import { PartTable, SessionActivityTable, SessionInputTable, SessionMessageTable, SessionTable } from "./sql"
import { SessionEvent } from "./event"

export class NotFound extends Schema.TaggedErrorClass<NotFound>()("SessionUsage.NotFound", {
  sessionID: Schema.String,
}) {}

export class ActivityMismatch extends Schema.TaggedErrorClass<ActivityMismatch>()("SessionUsage.ActivityMismatch", {
  sessionID: Schema.String,
  activityID: Schema.String,
}) {}

export type Totals = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  total: number
}

export type UsageBlock = {
  readonly own: Totals
  readonly descendants: Totals
  readonly total: Totals
  readonly descendantSessions: number
  readonly complete: boolean
  // Own-session provider streaming time in milliseconds (token deltas only;
  // excludes tool waits). Does not include descendant sessions.
  readonly generationMs: number
}

export type MeasuredValue = { readonly known?: number; readonly complete: boolean }

export type MeasurementBlock = {
  readonly complete: boolean
  readonly reportedSteps: number
  readonly unreportedSteps: number
  readonly categories: {
    readonly input: MeasuredValue
    readonly output: MeasuredValue
    readonly reasoning: MeasuredValue
    readonly cacheRead: MeasuredValue
    readonly cacheWrite: MeasuredValue
    readonly inputTotal: MeasuredValue
    readonly outputTotal: MeasuredValue
    readonly total: MeasuredValue
  }
}

export type ModelSelection = {
  readonly model: ModelV2.Ref
  readonly source: "prompt" | "model-switch"
  readonly sequence: number
}

export type ModelObservation = {
  readonly model: ModelV2.Ref
  readonly sequence: number
}

export type Attribution = {
  readonly status: "complete" | "partial" | "unknown"
  readonly reasons: readonly string[]
}

export type RunBlock = {
  readonly activityID: string
  readonly kind: string
  readonly status: string
  readonly running: boolean
  readonly timeStart: number
  readonly timeEnd?: number
  readonly timeUpdated: number
  readonly openedSeq?: number
  readonly closedSeq?: number
  readonly own: Totals
  readonly descendants: Totals
  readonly total: Totals
  readonly complete: boolean
  readonly reason?: string
  readonly attribution: Attribution
  // Own-run-window provider streaming time in milliseconds (token deltas only).
  readonly generationMs: number
  readonly measurement: {
    readonly own: MeasurementBlock
    readonly descendants: MeasurementBlock
    readonly total: MeasurementBlock
  }
  readonly models: {
    readonly selected: readonly ModelSelection[]
    readonly observed: readonly ModelObservation[]
    readonly complete: boolean
  }
}

export type Summary = {
  readonly sessionID: string
  readonly activityID?: string
  readonly asOf: number
  readonly sequence?: number
  readonly session: UsageBlock
  readonly run: RunBlock | null
}

type SessionRow = typeof SessionTable.$inferSelect
type ActivityRow = typeof SessionActivityTable.$inferSelect
type SessionUsageDatabase = Omit<Database.Interface["db"], "$client">

const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)
const emptyTotals = (): Totals => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, total: 0 })

const combine = (own: Totals, descendants: Totals): Totals => ({
  input: own.input + descendants.input,
  output: own.output + descendants.output,
  reasoning: own.reasoning + descendants.reasoning,
  cacheRead: own.cacheRead + descendants.cacheRead,
  cacheWrite: own.cacheWrite + descendants.cacheWrite,
  cost: own.cost + descendants.cost,
  total: own.total + descendants.total,
})

type TokenUsage = {
  input?: unknown
  output?: unknown
  reasoning?: unknown
  cache?: { read?: unknown; write?: unknown }
}

const addTokens = (totals: Totals, tokens: TokenUsage | undefined, cost: unknown) => {
  if (tokens === null || typeof tokens !== "object") return
  const input = finite(tokens.input)
  const output = finite(tokens.output)
  const reasoning = finite(tokens.reasoning)
  const cacheRead = finite(tokens.cache?.read)
  const cacheWrite = finite(tokens.cache?.write)
  totals.input += input
  totals.output += output
  totals.reasoning += reasoning
  totals.cacheRead += cacheRead
  totals.cacheWrite += cacheWrite
  totals.cost += finite(cost)
  totals.total += input + output + reasoning + cacheRead + cacheWrite
}

type MeasurementCategory = keyof MeasurementBlock["categories"]
type MeasurementMessage = { readonly data: unknown }

const measurementCategories: MeasurementCategory[] = [
  "input",
  "output",
  "reasoning",
  "cacheRead",
  "cacheWrite",
  "inputTotal",
  "outputTotal",
  "total",
]

const MAX_STRUCTURED_PROVENANCE_BYTES = 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const measuredNumber = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined

function measurementForMessages(messages: readonly MeasurementMessage[], attributionComplete: boolean): MeasurementBlock {
  const totals = Object.fromEntries(measurementCategories.map((category) => [category, 0])) as Record<
    MeasurementCategory,
    number
  >
  const known = Object.fromEntries(measurementCategories.map((category) => [category, 0])) as Record<
    MeasurementCategory,
    number
  >
  const complete = Object.fromEntries(measurementCategories.map((category) => [category, true])) as Record<
    MeasurementCategory,
    boolean
  >
  let reportedSteps = 0
  let unreportedSteps = 0

  for (const message of messages) {
    const data = isRecord(message.data) ? message.data : {}
    const measurement = isRecord(data.tokenMeasurement) && data.tokenMeasurement.version === 1 ? data.tokenMeasurement : undefined
    const tokens = isRecord(data.tokens) ? data.tokens : undefined
    const cache = tokens && isRecord(tokens.cache) ? tokens.cache : undefined
    if (measurement) reportedSteps++
    else unreportedSteps++

    const captured = (field: string) => {
      const captured = measuredNumber(measurement?.[field])
      if (captured !== undefined) return captured
    }
    const legacy = (value: unknown) => {
      const old = measuredNumber(value)
      return !measurement && old !== undefined && old > 0 ? old : undefined
    }
    const input = captured("nonCachedInputTokens") ?? legacy(tokens?.input)
    const outputTotal = captured("outputTokens")
    const reasoning = captured("reasoningTokens") ?? legacy(tokens?.reasoning)
    const cacheRead = captured("cacheReadInputTokens") ?? legacy(cache?.read)
    const cacheWrite = captured("cacheWriteInputTokens") ?? legacy(cache?.write)
    const inputTotal =
      captured("inputTokens") ??
      (input !== undefined && cacheRead !== undefined && cacheWrite !== undefined
        ? input + cacheRead + cacheWrite
        : undefined)
    const visibleOutput = outputTotal !== undefined && reasoning !== undefined
      ? Math.max(0, outputTotal - reasoning)
      : legacy(tokens?.output)
    const total = captured("totalTokens") ?? (inputTotal !== undefined && outputTotal !== undefined ? inputTotal + outputTotal : undefined)
    const row = {
      input,
      output: visibleOutput,
      reasoning,
      cacheRead,
      cacheWrite,
      inputTotal,
      outputTotal,
      total,
    }

    for (const category of measurementCategories) {
      const amount = row[category]
      if (amount === undefined) {
        complete[category] = false
        continue
      }
      totals[category] += amount
      known[category]++
    }
  }

  const categories = Object.fromEntries(
    measurementCategories.map((category) => [
      category,
      {
        ...(known[category] === 0 ? {} : { known: totals[category] }),
        complete: messages.length > 0 && complete[category] && attributionComplete,
      },
    ]),
  ) as MeasurementBlock["categories"]
  return {
    complete: messages.length > 0 && measurementCategories.every((category) => complete[category]) && attributionComplete,
    reportedSteps,
    unreportedSteps,
    categories,
  }
}

const emptyDescendantMeasurement = (): MeasurementBlock => ({
  complete: true,
  reportedSteps: 0,
  unreportedSteps: 0,
  categories: Object.fromEntries(measurementCategories.map((category) => [category, { complete: true }])) as MeasurementBlock["categories"],
})

const unknownMeasurement = (): MeasurementBlock => ({
  complete: false,
  reportedSteps: 0,
  unreportedSteps: 0,
  categories: Object.fromEntries(measurementCategories.map((category) => [category, { complete: false }])) as MeasurementBlock["categories"],
})

function combineMeasurement(own: MeasurementBlock, descendants: MeasurementBlock): MeasurementBlock {
  return {
    complete: own.complete && descendants.complete,
    reportedSteps: own.reportedSteps + descendants.reportedSteps,
    unreportedSteps: own.unreportedSteps + descendants.unreportedSteps,
    categories: Object.fromEntries(
      measurementCategories.map((category) => {
        const left = own.categories[category]
        const right = descendants.categories[category]
        return [category, {
          ...(left.known === undefined && right.known === undefined
            ? {}
            : { known: (left.known ?? 0) + (right.known ?? 0) }),
          complete: left.complete && right.complete,
        }]
      }),
    ) as MeasurementBlock["categories"],
  }
}

// Session table totals are maintained transactionally by the projector with
// V1/V2 dedup, so they are exact per session and never double count message
// representations.
const totalsFromSessionRow = (row: Pick<SessionRow, "cost" | "tokens_input" | "tokens_output" | "tokens_reasoning" | "tokens_cache_read" | "tokens_cache_write">): Totals => {
  const input = row.tokens_input ?? 0
  const output = row.tokens_output ?? 0
  const reasoning = row.tokens_reasoning ?? 0
  const cacheRead = row.tokens_cache_read ?? 0
  const cacheWrite = row.tokens_cache_write ?? 0
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    cost: row.cost ?? 0,
    total: input + output + reasoning + cacheRead + cacheWrite,
  }
}

// Breadth-first walk of the parent_id tree. Bounded defensively; real task
// depth limits are far below this.
const descendantSessions = Effect.fn("SessionUsage.descendantSessions")(function* (db: SessionUsageDatabase, root: string) {
  const ids: string[] = []
  const seen = new Set([root])
  let frontier = [root]
  while (frontier.length > 0 && ids.length < 1000) {
    const rows = yield* db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(inArray(SessionTable.parent_id, frontier as [SessionSchema.ID, ...SessionSchema.ID[]]))
      .all()
      .pipe(Effect.orDie)
    frontier = rows.map((row) => row.id).filter((id) => !seen.has(id))
    for (const id of frontier) seen.add(id)
    ids.push(...frontier)
  }
  return ids
})

// Only structured results from task/fanout tools create child links. Intersecting
// them with the parent_id tree prevents IDs in ordinary message content from
// creating attribution.
const runChildren = Effect.fn("SessionUsage.runChildren")(function* (
  db: SessionUsageDatabase,
  sessionID: string,
  messages: readonly { readonly id: string; readonly data: unknown }[],
  descendantIDs: readonly string[],
  contentStore: ContentStore.Interface | undefined,
) {
  if (messages.length === 0) return []
  const descendants = new Set(descendantIDs)
  const partMessageIDs = messages.map((message) => message.id) as [
    typeof PartTable.$inferSelect.message_id,
    ...(typeof PartTable.$inferSelect.message_id)[],
  ]
  const parts = yield* db
    .select({ data: PartTable.data })
    .from(PartTable)
    .where(and(eq(PartTable.session_id, SessionSchema.ID.make(sessionID)), inArray(PartTable.message_id, partMessageIDs)))
    .all()
    .pipe(Effect.orDie)
  const linked = new Set<string>()
  const recordTaskID = (value: unknown) => {
    if (!isRecord(value)) return
    const id =
      typeof value.task_id === "string"
        ? value.task_id
        : typeof value.sessionID === "string"
          ? value.sessionID
          : typeof value.sessionId === "string"
            ? value.sessionId
            : undefined
    if (id && id !== sessionID && descendants.has(id)) linked.add(id)
  }
  const recordToolOutput = Effect.fn("SessionUsage.recordToolOutput")(function* (tool: unknown, output: unknown) {
    const externalized = isRecord(output) && isRecord(output.$opencode) ? output.$opencode : undefined
    if (
      externalized?.type === "content-reference" &&
      externalized.mime === "application/json" &&
      typeof externalized.uri === "string" &&
      externalized.uri.startsWith(ContentStore.URI_PREFIX) &&
      contentStore
    ) {
      const resolved = yield* contentStore
        .resolve({ uri: externalized.uri, sessionID, maxBytes: MAX_STRUCTURED_PROVENANCE_BYTES })
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (resolved?.mime === "application/json") {
        output = Option.getOrUndefined(
          Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(Buffer.from(resolved.bytes).toString("utf8")),
        )
      }
    }
    if (tool === "task") recordTaskID(output)
    if (tool !== "multi_agent_fanout" || !isRecord(output) || !Array.isArray(output.results)) return
    for (const result of output.results) {
      if (isRecord(result)) recordTaskID(result.task)
    }
  })

  for (const message of messages) {
    const data = isRecord(message.data) ? message.data : {}
    if (!Array.isArray(data.content)) continue
    for (const content of data.content) {
      if (!isRecord(content) || content.type !== "tool" || !isRecord(content.state)) continue
      yield* recordToolOutput(content.name, content.state.structured)
    }
  }

  for (const part of parts) {
    const data: Record<string, unknown> = isRecord(part.data) ? part.data : {}
    if (data.type !== "tool" || !isRecord(data.state)) continue
    yield* recordToolOutput(data.tool, data.state.structured)
    yield* recordToolOutput(data.tool, data.state.metadata)
  }
  return [...linked]
})

// Child work is attributed per message timestamp inside the run window. Each
// message lands in exactly one window, so reused child sessions are never
// counted twice across runs; background work that continues after the window
// belongs to the session total but not to this run.
const subtreeTotalsInWindow = Effect.fn("SessionUsage.subtreeTotalsInWindow")(function* (
  db: SessionUsageDatabase,
  root: string,
  windowStart: number,
  windowEnd: number,
  totals: Totals,
) {
  const seen = new Set<string>()
  let frontier = [root]
  const ids: string[] = []
  while (frontier.length > 0 && ids.length < 1000) {
    ids.push(...frontier)
    for (const id of frontier) seen.add(id)
    const rows = yield* db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(inArray(SessionTable.parent_id, frontier as [SessionSchema.ID, ...SessionSchema.ID[]]))
      .all()
      .pipe(Effect.orDie)
    frontier = rows.map((row) => row.id).filter((id) => !seen.has(id))
  }
  if (ids.length === 0) return []
  const messages = yield* db
    .select({ id: SessionMessageTable.id, data: SessionMessageTable.data })
    .from(SessionMessageTable)
    .where(
      and(
        inArray(SessionMessageTable.session_id, ids as [SessionSchema.ID, ...SessionSchema.ID[]]),
        eq(SessionMessageTable.type, "assistant"),
        gt(SessionMessageTable.time_created, windowStart),
        lte(SessionMessageTable.time_created, windowEnd),
      ),
    )
    .all()
    .pipe(Effect.orDie)
  for (const message of messages) {
    const data = message.data as { tokens?: TokenUsage; cost?: unknown }
    addTokens(totals, data.tokens, data.cost)
  }
  return messages
})

const runTotals = Effect.fn("SessionUsage.runTotals")(function* (
  db: SessionUsageDatabase,
  sessionID: string,
  activity: ActivityRow,
  descendantIDs: readonly string[],
  asOf: number,
  snapshotSequence: number | undefined,
) {
  const running =
    (activity.status === "running" || activity.status === "recovering") && activity.closed_seq === null
  let opened = activity.opened_seq ?? undefined
  let originalActivityStartFound = false
  if (activity.recovery_attempts > 0) {
    const starts = yield* db
      .select({ seq: EventTable.seq, data: EventTable.data })
      .from(EventTable)
      .where(
        and(
          eq(EventTable.aggregate_id, sessionID),
          eq(EventTable.type, EventV2.versionedType(SessionEvent.Activity.Started.type, 1)),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    const start = starts.find((item) => isRecord(item.data) && item.data.activityID === activity.id)
    if (start) {
      opened = start.seq - 1
      originalActivityStartFound = true
    }
  }

  const reasons: string[] = []
  if (opened === undefined) reasons.push("missing-window")
  if (activity.recovery_attempts > 0 && !originalActivityStartFound) reasons.push("recovered-window-unverified")
  if (running && snapshotSequence === undefined) reasons.push("missing-window")
  if (!running && activity.closed_seq === null) reasons.push("missing-window")
  if ((activity.status === "running" || activity.status === "recovering") !== (activity.closed_seq === null))
    reasons.push("inconsistent-status")

  const windowEndSeq = running ? snapshotSequence : activity.closed_seq ?? undefined
  const hasWindow = opened !== undefined && windowEndSeq !== undefined && (running || activity.closed_seq !== null)
  const messages = hasWindow
    ? yield* db
        .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq, data: SessionMessageTable.data })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, SessionSchema.ID.make(sessionID)),
            eq(SessionMessageTable.type, "assistant"),
            gt(SessionMessageTable.seq, opened!),
            lte(SessionMessageTable.seq, windowEndSeq!),
          ),
        )
        .all()
        .pipe(Effect.orDie)
    : []
  const own = emptyTotals()
  for (const message of messages) {
    const data = message.data as { tokens?: TokenUsage; cost?: unknown }
    addTokens(own, data.tokens, data.cost)
  }
  const generationMs = messages.reduce((total, message) => {
    const data = message.data as { tokenMeasurement?: unknown }
    const measurement = isRecord(data.tokenMeasurement) ? data.tokenMeasurement : undefined
    const milliseconds = measuredNumber(measurement?.generationMilliseconds)
    return total + (milliseconds ?? 0)
  }, 0)

  const windowStart = activity.time_created
  const windowEnd = running ? asOf : activity.time_updated
  const contentStore = Option.getOrUndefined(yield* Effect.serviceOption(ContentStore.Service))
  const children = hasWindow ? yield* runChildren(db, sessionID, messages, descendantIDs, contentStore) : []
  const descendants = emptyTotals()
  const descendantMessages: { id: string; data: unknown }[] = []
  for (const child of children) {
    descendantMessages.push(...(yield* subtreeTotalsInWindow(db, child, windowStart, windowEnd, descendants)))
  }
  // Without at least one provenance link we cannot distinguish "no subagents
  // ran" from "provenance missing", so flag runs of sessions that have
  // descendant sessions but no linked child as incomplete instead of exact.
  const complete = descendantIDs.length === 0 || children.length > 0
  if (!complete) reasons.push("missing-subagent-provenance")
  if (descendantIDs.length >= 1000) reasons.push("descendant-limit")
  const attribution: Attribution = {
    status: reasons.length === 0 ? "complete" : opened === undefined ? "unknown" : "partial",
    reasons: [...new Set(reasons)],
  }
  const ownWindowComplete =
    hasWindow &&
    !reasons.some((reason) => ["missing-window", "recovered-window-unverified", "inconsistent-status"].includes(reason))
  const ownMeasurement = hasWindow ? measurementForMessages(messages, ownWindowComplete) : unknownMeasurement()
  const descendantMeasurement =
    descendantIDs.length === 0
      ? emptyDescendantMeasurement()
      : children.length > 0
        ? measurementForMessages(descendantMessages, complete && attribution.status === "complete")
        : unknownMeasurement()
  const measurement = {
    own: ownMeasurement,
    descendants: descendantMeasurement,
    total: combineMeasurement(ownMeasurement, descendantMeasurement),
  }
  const inputRows = hasWindow
    ? yield* db
        .select({ promoted_seq: SessionInputTable.promoted_seq, prompt: SessionInputTable.prompt, execution_prompt: SessionInputTable.execution_prompt })
        .from(SessionInputTable)
        .where(
          and(
            eq(SessionInputTable.session_id, SessionSchema.ID.make(sessionID)),
            gt(SessionInputTable.promoted_seq, opened!),
            lte(SessionInputTable.promoted_seq, windowEndSeq!),
          ),
        )
        .all()
        .pipe(Effect.orDie)
    : []
  const selections: ModelSelection[] = inputRows.flatMap((row) => {
    const prompt = isRecord(row.execution_prompt ?? row.prompt) ? row.execution_prompt ?? row.prompt : undefined
    const decoded = prompt && isRecord(prompt) ? Schema.decodeUnknownOption(ModelV2.Ref)(prompt.model) : Option.none()
    return row.promoted_seq !== null && Option.isSome(decoded)
      ? [{ model: decoded.value, source: "prompt" as const, sequence: row.promoted_seq }]
      : []
  })
  const switched = hasWindow
    ? yield* db
        .select({ seq: SessionMessageTable.seq, data: SessionMessageTable.data })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, SessionSchema.ID.make(sessionID)),
            eq(SessionMessageTable.type, "model-switched"),
            gt(SessionMessageTable.seq, opened!),
            lte(SessionMessageTable.seq, windowEndSeq!),
          ),
        )
        .all()
        .pipe(Effect.orDie)
    : []
  const modelsSelected = [
    ...selections,
    ...switched.flatMap((item) => {
      const data: Record<string, unknown> = isRecord(item.data) ? item.data : {}
      const decoded = Schema.decodeUnknownOption(ModelV2.Ref)(data.model)
      return Option.isSome(decoded) ? [{ model: decoded.value, source: "model-switch" as const, sequence: item.seq }] : []
    }),
  ].sort((left, right) => left.sequence - right.sequence)
  const observed: ModelObservation[] = messages.flatMap((item) => {
    const data: Record<string, unknown> = isRecord(item.data) ? item.data : {}
    const decoded = Schema.decodeUnknownOption(ModelV2.Ref)(data.model)
    return Option.isSome(decoded) ? [{ model: decoded.value, sequence: item.seq }] : []
  })
  return {
    activityID: activity.id,
    kind: activity.kind,
    status: activity.status,
    running,
    timeStart: windowStart,
    ...(running ? {} : { timeEnd: activity.time_updated }),
    timeUpdated: activity.time_updated,
    ...(opened === undefined ? {} : { openedSeq: opened }),
    ...(activity.closed_seq === null ? {} : { closedSeq: activity.closed_seq }),
    own,
    descendants,
    total: combine(own, descendants),
    complete,
    generationMs,
    ...(complete ? {} : { reason: "no subagent provenance found for this run window" }),
    attribution,
    measurement,
    models: {
      selected: modelsSelected,
      observed,
      complete: modelsSelected.length > 0 || observed.length > 0,
    },
  }
})

/** Read-only usage summary: exact session tree totals plus the latest (or requested) run window. */
export const readSnapshot = <A, E, R>(
  db: Database.Interface["db"],
  read: (tx: SessionUsageDatabase) => Effect.Effect<A, E, R>,
) => db.transaction((tx) => read(tx))

export const summarize = Effect.fn("SessionUsage.summarize")(function* (db: Database.Interface["db"], input: { sessionID: string; activityID?: string }) {
  return yield* readSnapshot(db, (tx) => summarizeSnapshot(tx, input))
})

const summarizeSnapshot = Effect.fn("SessionUsage.summarizeSnapshot")(function* (
  db: SessionUsageDatabase,
  input: { sessionID: string; activityID?: string },
) {
  const asOf = Date.now()
  const sessionID = SessionSchema.ID.make(input.sessionID)
  const session = yield* db
    .select()
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!session) return yield* new NotFound({ sessionID: input.sessionID })

  const own = totalsFromSessionRow(session)
  // Own-session streaming time only: descendant subagent streams overlap the
  // parent's wall clock, so summing them would deflate a shared tok/s average.
  // Clamped so a tampered or legacy-degraded row cannot produce a negative rate.
  const generationMs = Math.max(0, session.generation_ms ?? 0)
  const sequence = yield* db
    .select({ seq: EventSequenceTable.seq })
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, input.sessionID))
    .get()
    .pipe(Effect.orDie)
  const lastMessage = sequence
    ? undefined
    : yield* db
        .select({ seq: SessionMessageTable.seq })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(desc(SessionMessageTable.seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
  const snapshotSequence = sequence?.seq ?? lastMessage?.seq
  const descendantIDs = yield* descendantSessions(db, input.sessionID)
  const descendants = emptyTotals()
  for (const id of descendantIDs) {
    const row = yield* db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, SessionSchema.ID.make(id)))
      .get()
      .pipe(Effect.orDie)
    if (row) {
      const totals = totalsFromSessionRow(row)
      descendants.input += totals.input
      descendants.output += totals.output
      descendants.reasoning += totals.reasoning
      descendants.cacheRead += totals.cacheRead
      descendants.cacheWrite += totals.cacheWrite
      descendants.cost += totals.cost
      descendants.total += totals.total
    }
  }

  const activities = yield* db
    .select()
    .from(SessionActivityTable)
    .where(eq(SessionActivityTable.session_id, sessionID))
    .all()
    .pipe(Effect.orDie)
  const requested = input.activityID ? activities.find((activity) => activity.id === input.activityID) : undefined
  if (input.activityID && !requested) {
    return yield* new ActivityMismatch({ sessionID: input.sessionID, activityID: input.activityID })
  }
  const runActivity = requested ?? activities.toSorted((left, right) => left.time_created - right.time_created || left.id.localeCompare(right.id)).at(-1)
  const run = runActivity ? yield* runTotals(db, input.sessionID, runActivity, descendantIDs, asOf, snapshotSequence) : null

  return {
    sessionID: input.sessionID,
    ...(run ? { activityID: run.activityID } : {}),
    asOf,
    ...(sequence ? { sequence: sequence.seq } : {}),
    session: { own, descendants, total: combine(own, descendants), descendantSessions: descendantIDs.length, complete: true, generationMs },
    run,
  }
})
