import type { OpencodeClient, QuestionV2Answer, SurfaceBlockingRequest, SurfaceRequest } from "@opencode-ai/sdk/v2/client"
import { createSignal } from "solid-js"

export type PendingQuestionsSnapshot = {
  pending: SurfaceRequest[]
  complete: boolean
}

export type QuestionSettlement = {
  settled: "submitted" | "already-settled"
  snapshot?: PendingQuestionsSnapshot
  activity?: QuestionRejectSettlement
}

export type QuestionRejectSettlement = {
  status: "settled" | "interrupted" | "settling"
  activityID?: string
}

export type QuestionActivitySettlement =
  | { status: "settled" }
  | { status: "aborted" }
  | { status: "reconcile"; error: unknown }

export type QuestionSessionSettlement = {
  status: "settling" | "reconcile"
  count: number
  error?: unknown
}

export const QUESTION_SETTLEMENT_POLL_MS = 250
export const QUESTION_SETTLEMENT_MAX_POLL_MS = 2_000
export const QUESTION_SETTLEMENT_MAX_FAILURES = 3
export const QUESTION_SETTLEMENT_REQUEST_TIMEOUT_MS = 15_000

const settled = new Set<string>()
const [settlementCounts, setSettlementCounts] = createSignal<Record<string, number>>({})
type QuestionActivitySettlementRecord = {
  client: OpencodeClient
  requests: Map<string, Pick<SurfaceRequest, "id" | "sessionID">>
  finishers: Set<() => void>
  poll?: { pollMs?: number; maxPollMs?: number; maxFailures?: number; requestTimeoutMs?: number }
  status: "settling" | "reconcile"
  error?: unknown
  running: boolean
}
const activitySettlements = new Map<string, Map<string, QuestionActivitySettlementRecord>>()
type QuestionRejectSettlementRecord = {
  client: OpencodeClient
  request: Pick<SurfaceRequest, "id" | "sessionID">
  finishers: Set<() => void>
  submitted: Set<() => void>
  submit: () => Promise<QuestionSettlement>
  poll?: { pollMs?: number; maxPollMs?: number; maxFailures?: number; requestTimeoutMs?: number }
  status: "settling" | "reconcile"
  error?: unknown
  running: boolean
}
const rejectSettlements = new Map<string, Map<string, QuestionRejectSettlementRecord>>()
const [activitySettlementRevision, setActivitySettlementRevision] = createSignal(0)

export function questionSettlementPending(sessionID: string | undefined) {
  if (!sessionID) return false
  return (settlementCounts()[sessionID] ?? 0) > 0
}

export function beginQuestionSettlement(sessionID: string) {
  const settlement = { finished: false }
  setSettlementCounts((current) => ({ ...current, [sessionID]: (current[sessionID] ?? 0) + 1 }))
  return () => {
    if (settlement.finished) return
    settlement.finished = true
    setSettlementCounts((current) => {
      if ((current[sessionID] ?? 0) > 1) return { ...current, [sessionID]: current[sessionID]! - 1 }
      return Object.fromEntries(Object.entries(current).filter(([key]) => key !== sessionID))
    })
  }
}

export function questionSessionSettlement(sessionID: string | undefined): QuestionSessionSettlement | undefined {
  activitySettlementRevision()
  if (!sessionID) return
  const count = settlementCounts()[sessionID] ?? 0
  const records = [
    ...(rejectSettlements.get(sessionID)?.values() ?? []),
    ...(activitySettlements.get(sessionID)?.values() ?? []),
  ]
  if (!records.length) return count ? { status: "settling", count } : undefined
  const reconcile = records.find((record) => record.status === "reconcile")
  return {
    status: reconcile ? "reconcile" : "settling",
    count: Math.max(count, records.length),
    ...(reconcile?.error === undefined ? {} : { error: reconcile.error }),
  }
}

export function trackQuestionActivitySettlement(
  client: OpencodeClient,
  input: {
    request: Pick<SurfaceRequest, "id" | "sessionID">
    activity: QuestionRejectSettlement | undefined
    finish?: () => void
    poll?: { pollMs?: number; maxPollMs?: number; maxFailures?: number; requestTimeoutMs?: number }
  },
) {
  if (input.activity?.status !== "settling" || !input.activity.activityID) return false
  const records = activitySettlements.get(input.request.sessionID) ?? new Map()
  const existing = records.get(input.activity.activityID)
  if (existing) {
    existing.requests.set(questionKey(input.request), input.request)
    if (input.finish) existing.finishers.add(input.finish)
    return true
  }
  const record: QuestionActivitySettlementRecord = {
    client,
    requests: new Map([[questionKey(input.request), input.request]]),
    finishers: new Set(input.finish ? [input.finish] : []),
    poll: input.poll,
    status: "settling" as const,
    running: false,
  }
  records.set(input.activity.activityID, record)
  activitySettlements.set(input.request.sessionID, records)
  publishActivitySettlements()
  void runQuestionActivitySettlement(input.request.sessionID, input.activity.activityID, record)
  return true
}

export function trackQuestionRejectSettlement(
  client: OpencodeClient,
  input: {
    request: Pick<SurfaceRequest, "id" | "sessionID">
    submit: () => Promise<QuestionSettlement>
    finish?: () => void
    onSubmitted?: () => void
    poll?: { pollMs?: number; maxPollMs?: number; maxFailures?: number; requestTimeoutMs?: number }
  },
) {
  const records = rejectSettlements.get(input.request.sessionID) ?? new Map()
  const key = questionKey(input.request)
  const existing = records.get(key)
  if (existing) {
    if (input.finish) existing.finishers.add(input.finish)
    if (input.onSubmitted) existing.submitted.add(input.onSubmitted)
    return true
  }
  const record: QuestionRejectSettlementRecord = {
    client,
    request: input.request,
    finishers: new Set(input.finish ? [input.finish] : []),
    submitted: new Set(input.onSubmitted ? [input.onSubmitted] : []),
    submit: input.submit,
    poll: input.poll,
    status: "settling",
    running: false,
  }
  records.set(key, record)
  rejectSettlements.set(input.request.sessionID, records)
  publishActivitySettlements()
  void runQuestionRejectSettlement(input.request.sessionID, key, record)
  return true
}

export function retryQuestionSettlement(sessionID: string) {
  rejectSettlements.get(sessionID)?.forEach((record, key) => {
    if (record.status !== "reconcile" || record.running) return
    void runQuestionRejectSettlement(sessionID, key, record)
  })
  const records = activitySettlements.get(sessionID)
  if (!records) return
  records.forEach((record, activityID) => {
    if (record.status !== "reconcile" || record.running) return
    void runQuestionActivitySettlement(sessionID, activityID, record)
  })
}

async function runQuestionRejectSettlement(sessionID: string, key: string, record: QuestionRejectSettlementRecord) {
  if (record.running) return
  record.running = true
  record.status = "settling"
  delete record.error
  publishActivitySettlements()
  const result = await Promise.resolve()
    .then(record.submit)
    .then(
      (settlement) => ({ status: "success" as const, settlement }),
      (error: unknown) => ({ status: "error" as const, error }),
    )
  record.running = false
  if (rejectSettlements.get(sessionID)?.get(key) !== record) return
  if (result.status === "error") {
    record.status = "reconcile"
    record.error = result.error
    publishActivitySettlements()
    return
  }
  const activityOwned = trackQuestionActivitySettlement(record.client, {
    request: record.request,
    activity: result.settlement.activity,
    poll: record.poll,
  })
  if (activityOwned)
    record.finishers.forEach((finish) =>
      trackQuestionActivitySettlement(record.client, {
        request: record.request,
        activity: result.settlement.activity,
        finish,
      }),
    )
  const records = rejectSettlements.get(sessionID)
  records?.delete(key)
  if (!records?.size) rejectSettlements.delete(sessionID)
  publishActivitySettlements()
  if (activityOwned) {
    record.submitted.forEach((submitted) => submitted())
    return
  }
  try {
    record.submitted.forEach((submitted) => submitted())
  } finally {
    record.finishers.forEach((finish) => finish())
  }
}

async function runQuestionActivitySettlement(
  sessionID: string,
  activityID: string,
  record: QuestionActivitySettlementRecord,
) {
  if (record.running) return
  record.running = true
  record.status = "settling"
  delete record.error
  publishActivitySettlements()
  const result = await waitForQuestionActivitySettlement(record.client, { sessionID, activityID, ...(record.poll ?? {}) })
  record.running = false
  if (activitySettlements.get(sessionID)?.get(activityID) !== record) return
  if (result.status === "settled") {
    record.requests.forEach(markSurfaceRequestSettled)
    record.finishers.forEach((finish) => finish())
    const records = activitySettlements.get(sessionID)
    records?.delete(activityID)
    if (!records?.size) activitySettlements.delete(sessionID)
    publishActivitySettlements()
    return
  }
  if (result.status === "aborted") return
  record.status = "reconcile"
  record.error = result.error
  publishActivitySettlements()
}

function publishActivitySettlements() {
  setActivitySettlementRevision((revision) => revision + 1)
}

/** Legacy events are accepted as transport adapters, but V2 remains the authority for listing and settlement. */
export function markSurfaceRequestProtocol<T extends SurfaceRequest>(input: T, _protocol: "legacy" | "v2"): T {
  if ((input as { mode?: unknown }).mode !== undefined) return input
  if (!("questions" in input)) return input
  return {
    ...input,
    mode: "blocking",
    revision: 1,
    actions: [],
  } as T
}

export function clearSurfaceRequestProtocol(input: Pick<SurfaceRequest, "id" | "sessionID">) {
  markSurfaceRequestSettled(input)
}

export function isV2SurfaceRequest(_input: Pick<SurfaceRequest, "id" | "sessionID">) {
  return true
}

export function isSurfaceRequestSettled(input: Pick<SurfaceRequest, "id" | "sessionID">) {
  return settled.has(questionKey(input))
}

export async function loadPendingQuestions(
  client: OpencodeClient,
  directory: string,
  signal?: AbortSignal,
): Promise<PendingQuestionsSnapshot> {
  const result = await client.v2.surface.request.list({ location: { directory } }, { signal })
  return {
    pending: (result.data?.data ?? [])
      .filter((question) => !!question.id && !!question.sessionID)
      .map((question) => markSurfaceRequestProtocol(question, "v2"))
      .filter((question) => !isSurfaceRequestSettled(question)),
    complete: true,
  }
}

export async function reconcileSurfaceRequest(
  client: OpencodeClient,
  input: {
    request: Pick<SurfaceRequest, "id" | "sessionID">
    directory?: string
    onReconcile?: (snapshot: PendingQuestionsSnapshot) => void
  },
): Promise<QuestionSettlement | undefined> {
  const snapshot = await loadPendingQuestions(client, input.directory ?? "")
  input.onReconcile?.(snapshot)
  const pending = snapshot.pending.some(
    (question) => question.id === input.request.id && question.sessionID === input.request.sessionID,
  )
  if (pending) return
  markSurfaceRequestSettled(input.request)
  return { settled: "already-settled", snapshot }
}

export function replyQuestion(
  client: OpencodeClient,
  input: {
    request: SurfaceBlockingRequest
    answers: QuestionV2Answer[]
    directory?: string
    onReconcile?: (snapshot: PendingQuestionsSnapshot) => void
  },
  signal?: AbortSignal,
) {
  return settleQuestion(
    client,
    input,
    () =>
      client.v2.session.surface
        .reply(
          {
            sessionID: input.request.sessionID,
            requestID: input.request.id,
            questionV2Reply: { answers: input.answers },
          },
          { signal },
        )
        .then(() => undefined),
  )
}

export function rejectQuestion(
  client: OpencodeClient,
  input: {
    request: SurfaceRequest
    directory?: string
    onReconcile?: (snapshot: PendingQuestionsSnapshot) => void
  },
  signal?: AbortSignal,
) {
  return settleQuestion(
    client,
    input,
    () =>
      client.v2.session.surface
        .dismiss(
          {
            sessionID: input.request.sessionID,
            requestID: input.request.id,
          },
          { signal },
        )
        .then((result) => result.data),
  )
}

export async function waitForQuestionActivitySettlement(
  client: OpencodeClient,
  input: {
    sessionID: string
    activityID: string
    signal?: AbortSignal
    pollMs?: number
    maxPollMs?: number
    maxFailures?: number
    requestTimeoutMs?: number
  },
): Promise<QuestionActivitySettlement> {
  const maxPollMs = input.maxPollMs ?? QUESTION_SETTLEMENT_MAX_POLL_MS
  const maxFailures = input.maxFailures ?? QUESTION_SETTLEMENT_MAX_FAILURES
  let pollMs = Math.min(input.pollMs ?? QUESTION_SETTLEMENT_POLL_MS, maxPollMs)
  let failures = 0
  for (;;) {
    const result = await readQuestionActivity(client, input)
    if (result.status === "aborted") return result
    if (result.status === "error") {
      failures++
      if (failures >= maxFailures) return { status: "reconcile", error: result.error }
    }
    if (result.status === "success") {
      const activity = result.value.data?.data
      if (!activity || (activity.type !== "idle" && (activity.type !== "busy" || typeof activity.activityID !== "string"))) {
        failures++
        if (failures >= maxFailures) return { status: "reconcile", error: new Error("Invalid activity response") }
      } else {
        failures = 0
        if (activity.type === "idle" || activity.activityID !== input.activityID) return { status: "settled" }
      }
    }
    if (!(await waitForSettlementPoll(pollMs, input.signal))) return { status: "aborted" }
    pollMs = questionSettlementPollDelay(pollMs, maxPollMs)
  }
}

export function questionSettlementPollDelay(pollMs: number, maxPollMs: number = QUESTION_SETTLEMENT_MAX_POLL_MS) {
  return Math.min(Math.max(1, pollMs) * 2, maxPollMs)
}

type QuestionActivityRead =
  | { status: "success"; value: Awaited<ReturnType<OpencodeClient["v2"]["session"]["activity"]>> }
  | { status: "error"; error: unknown }
  | { status: "aborted" }

async function readQuestionActivity(
  client: OpencodeClient,
  input: { sessionID: string; signal?: AbortSignal; requestTimeoutMs?: number },
): Promise<QuestionActivityRead> {
  if (input.signal?.aborted) return { status: "aborted" }
  return new Promise((resolve) => {
    const controller = new AbortController()
    let finished = false
    let timeout: number | undefined
    const finish = (result: QuestionActivityRead) => {
      if (finished) return
      finished = true
      if (timeout !== undefined) window.clearTimeout(timeout)
      input.signal?.removeEventListener("abort", abort)
      resolve(result)
    }
    const abort = () => {
      controller.abort()
      finish({ status: "aborted" })
    }
    input.signal?.addEventListener("abort", abort, { once: true })
    timeout = window.setTimeout(() => {
      controller.abort()
      finish({ status: "error", error: new Error("Activity settlement request timed out") })
    }, input.requestTimeoutMs ?? QUESTION_SETTLEMENT_REQUEST_TIMEOUT_MS)
    void client.v2.session
      .activity({ sessionID: input.sessionID }, { signal: controller.signal })
      .then((value) => finish({ status: "success", value }))
      .catch((error: unknown) => finish(input.signal?.aborted ? { status: "aborted" } : { status: "error", error }))
  })
}

function waitForSettlementPoll(pollMs: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener("abort", abort)
      resolve(true)
    }, pollMs)
    const abort = () => {
      window.clearTimeout(timeout)
      resolve(false)
    }
    signal?.addEventListener("abort", abort, { once: true })
  })
}

async function settleQuestion(
  client: OpencodeClient,
  input: {
    request: SurfaceRequest
    directory?: string
    onReconcile?: (snapshot: PendingQuestionsSnapshot) => void
  },
  submit: () => Promise<QuestionRejectSettlement | undefined>,
): Promise<QuestionSettlement> {
  try {
    const activity = await submit()
    markSurfaceRequestSettled(input.request)
    return { settled: "submitted", ...(activity ? { activity } : {}) }
  } catch (error) {
    if (!isQuestionNotFoundError(error)) throw error
    const snapshot = await loadPendingQuestions(client, input.directory ?? "")
    input.onReconcile?.(snapshot)
    const pending = snapshot.pending.some(
      (question) => question.id === input.request.id && question.sessionID === input.request.sessionID,
    )
    if (!pending) {
      markSurfaceRequestSettled(input.request)
      return { settled: "already-settled", snapshot }
    }
    const activity = await submit()
    markSurfaceRequestSettled(input.request)
    return { settled: "submitted", snapshot, ...(activity ? { activity } : {}) }
  }
}

export function markSurfaceRequestSettled(input: Pick<SurfaceRequest, "id" | "sessionID">) {
  settled.add(questionKey(input))
  if (settled.size <= 2_048) return
  settled.delete(settled.values().next().value!)
}

function questionKey(input: Pick<SurfaceRequest, "id" | "sessionID">) {
  return `${input.sessionID}:${input.id}`
}

export function isQuestionNotFoundError(error: unknown): boolean {
  if (error instanceof Error) {
    if (/question request (?:not found|is gone|is no longer pending)/i.test(error.message)) return true
    if (isQuestionNotFoundError(error.cause)) return true
  }
  if (!error || typeof error !== "object") return false
  const value = error as Record<string, unknown>
  if (value.status === 404 || value.status === 410) return true
  return isQuestionNotFoundError(value.body) || isQuestionNotFoundError(value.data)
}

export function isQuestionConflictError(error: unknown): boolean {
  if (error instanceof Error && isQuestionConflictError(error.cause)) return true
  if (!error || typeof error !== "object") return false
  const value = error as Record<string, unknown>
  if (value.status === 409) return true
  return isQuestionConflictError(value.body) || isQuestionConflictError(value.data)
}

export function questionRequestErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error
  if (!error || typeof error !== "object") return String(error)
  const value = error as Record<string, unknown>
  const nested = [value.error, value.body, value.data, error instanceof Error ? error.cause : undefined]
    .map(questionRequestErrorMessage)
    .find((message) => message && message !== "undefined" && message !== "[object Object]")
  if (nested) return nested
  if (error instanceof Error && error.message) return error.message
  if (typeof value.message === "string" && value.message) return value.message
  return String(error)
}
