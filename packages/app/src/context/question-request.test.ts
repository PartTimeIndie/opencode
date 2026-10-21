import { describe, expect, test } from "bun:test"
import type { OpencodeClient, SurfaceRequest } from "@opencode-ai/sdk/v2/client"
import {
  beginQuestionSettlement,
  clearSurfaceRequestProtocol,
  isQuestionConflictError,
  isSurfaceRequestSettled,
  isV2SurfaceRequest,
  loadPendingQuestions,
  markSurfaceRequestProtocol,
  questionSessionSettlement,
  questionSettlementPollDelay,
  questionRequestErrorMessage,
  questionSettlementPending,
  reconcileSurfaceRequest,
  rejectQuestion,
  replyQuestion,
  retryQuestionSettlement,
  trackQuestionActivitySettlement,
  trackQuestionRejectSettlement,
  waitForQuestionActivitySettlement,
} from "./question-request"

const request = (id: string, sessionID = "ses_1") =>
  ({
    id,
    sessionID,
    mode: "blocking" as const,
    revision: 1,
    actions: [],
    questions: [{ question: "Continue?", header: "Continue", options: [{ label: "Yes", description: "Continue" }] }],
  }) satisfies SurfaceRequest

function client(input: {
  pending?: SurfaceRequest[]
  legacy?: SurfaceRequest[]
  replies?: Array<unknown | undefined>
  rejects?: Array<unknown | undefined>
  rejectSettlement?: { status: "settled" | "interrupted" | "settling"; activityID?: string }
  activity?: Array<{ type: "idle" | "busy"; activityID?: string }>
  onCall?: (call: string, value?: unknown) => void
}) {
  const replies = [...(input.replies ?? [])]
  const rejects = [...(input.rejects ?? [])]
  const activity = [...(input.activity ?? [{ type: "idle" as const }])]
  return {
    question: {
      list: async () => {
        input.onCall?.("legacy.list")
        return { data: input.legacy ?? [] }
      },
      reply: async (value: unknown) => input.onCall?.("legacy.reply", value),
      reject: async (value: unknown) => input.onCall?.("legacy.reject", value),
    },
    v2: {
      surface: {
        request: {
          list: async (value: unknown) => {
            input.onCall?.("v2.list", value)
            return { data: { data: input.pending ?? [] } }
          },
        },
      },
      session: {
        surface: {
          reply: async (value: unknown) => {
            input.onCall?.("v2.reply", value)
            const result = replies.shift()
            if (result) throw result
          },
          dismiss: async (value: unknown) => {
            input.onCall?.("v2.reject", value)
            const result = rejects.shift()
            if (result) throw result
            return { data: input.rejectSettlement ?? { status: "settled" as const } }
          },
        },
        activity: async () => ({ data: { data: activity.shift() ?? { type: "idle" as const } } }),
      },
    },
  } as unknown as OpencodeClient
}

describe("question requests", () => {
  test("forwards cancellation to the pending Surface request endpoint", async () => {
    const controller = new AbortController()
    let signal: AbortSignal | undefined
    const sdk = {
      v2: {
        surface: {
          request: {
            list: async (_parameters: unknown, options?: { signal?: AbortSignal }) => {
              signal = options?.signal
              return { data: { data: [] } }
            },
          },
        },
      },
    } as unknown as OpencodeClient

    await loadPendingQuestions(sdk, "C:/repo", controller.signal)

    expect(signal).toBe(controller.signal)
  })

  test("keeps a per-session settlement gate until every reject request finishes", () => {
    const finishFirst = beginQuestionSettlement("ses_settlement")
    const finishSecond = beginQuestionSettlement("ses_settlement")
    expect(questionSettlementPending("ses_settlement")).toBeTrue()
    expect(questionSettlementPending("ses_other")).toBeFalse()

    finishFirst()
    finishFirst()
    expect(questionSettlementPending("ses_settlement")).toBeTrue()
    finishSecond()
    expect(questionSettlementPending("ses_settlement")).toBeFalse()
  })

  test("uses the V2 pending list as the sole authority", async () => {
    const calls: string[] = []
    const snapshot = await loadPendingQuestions(
      client({
        pending: [request("que_v2")],
        legacy: [request("que_legacy")],
        onCall: (call) => calls.push(call),
      }),
      "C:/repo",
    )

    expect(snapshot).toEqual({ pending: [request("que_v2")], complete: true })
    expect(calls).toEqual(["v2.list"])
  })

  test("allows a retry only when pending-list reconciliation still contains the request", async () => {
    const current = request("que_timeout_pending")
    const snapshots: unknown[] = []
    const result = await reconcileSurfaceRequest(client({ pending: [current] }), {
      request: current,
      directory: "C:/repo",
      onReconcile: (snapshot) => snapshots.push(snapshot),
    })

    expect(result).toBeUndefined()
    expect(snapshots).toEqual([{ pending: [current], complete: true }])
    expect(isSurfaceRequestSettled(current)).toBeFalse()
  })

  test("treats an ambiguous submit as settled when pending-list reconciliation no longer contains it", async () => {
    const current = request("que_timeout_committed")
    const result = await reconcileSurfaceRequest(client({ pending: [] }), {
      request: current,
      directory: "C:/repo",
    })

    expect(result).toEqual({ settled: "already-settled", snapshot: { pending: [], complete: true } })
    expect(isSurfaceRequestSettled(current)).toBeTrue()
  })

  test("keeps legacy requests as adapters while settling through V2", async () => {
    const calls: Array<{ call: string; value?: unknown }> = []
    const legacyRequest = markSurfaceRequestProtocol(request("que_legacy"), "legacy")
    const currentRequest = markSurfaceRequestProtocol(request("que_v2") as SurfaceRequest, "v2")
    const sdk = client({ onCall: (call, value) => calls.push({ call, value }) })

    await replyQuestion(sdk, { request: legacyRequest, answers: [["Yes"]], directory: "C:/repo" })
    await rejectQuestion(sdk, { request: currentRequest, directory: "C:/repo" })

    expect(calls).toEqual([
      {
        call: "v2.reply",
        value: {
          sessionID: "ses_1",
          requestID: "que_legacy",
          questionV2Reply: { answers: [["Yes"]] },
        },
      },
      { call: "v2.reject", value: { sessionID: "ses_1", requestID: "que_v2" } },
    ])
    expect(isV2SurfaceRequest(legacyRequest)).toBeTrue()
    clearSurfaceRequestProtocol(legacyRequest)
    expect(isV2SurfaceRequest(legacyRequest)).toBeTrue()
  })

  test("marks a terminal protocol request settled synchronously", () => {
    const current = request("que_terminal_event")

    expect(isSurfaceRequestSettled(current)).toBeFalse()
    clearSurfaceRequestProtocol(current)
    expect(isSurfaceRequestSettled(current)).toBeTrue()
  })

  test("treats every successful V2 response as settled", async () => {
    const calls: string[] = []
    const result = await replyQuestion(
      client({ onCall: (call) => calls.push(call) }),
      { request: request("que_success"), answers: [["Yes"]], directory: "C:/repo" },
    )

    expect(result).toEqual({ settled: "submitted" })
    expect(calls).toEqual(["v2.reply"])
  })

  test("does not reopen a settled request from a delayed pending snapshot", async () => {
    const current = request("que_delayed_snapshot")
    const sdk = client({ pending: [current] })

    await replyQuestion(sdk, { request: current, answers: [["Yes"]], directory: "C:/repo" })

    expect(await loadPendingQuestions(sdk, "C:/repo")).toEqual({ pending: [], complete: true })
  })

  test("reconciles one 404 and retries once when the same request remains pending", async () => {
    const calls: string[] = []
    const current = request("que_retry")
    const snapshots: unknown[] = []
    const result = await replyQuestion(
      client({
        pending: [current],
        replies: [{ status: 404, body: { error: "Question request not found" } }],
        onCall: (call) => calls.push(call),
      }),
      {
        request: current,
        answers: [["Yes"]],
        directory: "C:/repo",
        onReconcile: (snapshot) => snapshots.push(snapshot),
      },
    )

    expect(result.settled).toBe("submitted")
    expect(calls).toEqual(["v2.reply", "v2.list", "v2.reply"])
    expect(snapshots).toEqual([{ pending: [current], complete: true }])
  })

  test("treats a reconciled 410 as already settled when the request disappeared", async () => {
    const calls: string[] = []
    const result = await rejectQuestion(
      client({
        pending: [],
        rejects: [{ status: 410, body: { error: "Question request is gone" } }],
        onCall: (call) => calls.push(call),
      }),
      { request: request("que_gone"), directory: "C:/repo" },
    )

    expect(result).toEqual({ settled: "already-settled", snapshot: { pending: [], complete: true } })
    expect(calls).toEqual(["v2.reject", "v2.list"])
  })

  test("dedupes a rejected question immediately while keeping its activity identity", async () => {
    const current = request("que_settling")
    const sdk = client({ pending: [current], rejectSettlement: { status: "settling", activityID: "act_question" } })
    const result = await rejectQuestion(
      sdk,
      { request: current, directory: "C:/repo" },
    )

    expect(result).toEqual({
      settled: "submitted",
      activity: { status: "settling", activityID: "act_question" },
    })
    expect(isSurfaceRequestSettled(current)).toBeTrue()
    expect(await loadPendingQuestions(sdk, "C:/repo")).toEqual({ pending: [], complete: true })
  })

  test("waits for the rejected activity rather than releasing the composer while it is busy", async () => {
    const sdk = client({ activity: [{ type: "busy", activityID: "act_question" }, { type: "idle" }] })

    await expect(
      waitForQuestionActivitySettlement(sdk, { sessionID: "ses_1", activityID: "act_question", pollMs: 1 }),
    ).resolves.toEqual({ status: "settled" })
  })

  test("ends the settlement poll when its component lifecycle aborts", async () => {
    const controller = new AbortController()
    const sdk = {
      v2: {
        session: {
          activity: () => new Promise(() => {}),
        },
      },
    } as unknown as OpencodeClient
    const waiting = waitForQuestionActivitySettlement(sdk, {
      sessionID: "ses_1",
      activityID: "act_question",
      signal: controller.signal,
    })

    controller.abort()

    await expect(waiting).resolves.toEqual({ status: "aborted" })
  })

  test("returns a retryable reconcile state after consecutive activity failures", async () => {
    let calls = 0
    const error = { status: 503, body: { error: "Server restarting" } }
    const sdk = {
      v2: {
        session: {
          activity: () => {
            calls++
            return Promise.reject(error)
          },
        },
      },
    } as unknown as OpencodeClient

    await expect(
      waitForQuestionActivitySettlement(sdk, {
        sessionID: "ses_1",
        activityID: "act_question",
        pollMs: 1,
        maxFailures: 3,
      }),
    ).resolves.toEqual({ status: "reconcile", error })
    expect(calls).toBe(3)
  })

  test("turns hung activity reads into a retryable reconcile state", async () => {
    const sdk = {
      v2: {
        session: {
          activity: () => new Promise(() => {}),
        },
      },
    } as unknown as OpencodeClient

    const result = await waitForQuestionActivitySettlement(sdk, {
      sessionID: "ses_hung_activity",
      activityID: "act_hung_activity",
      pollMs: 1,
      maxFailures: 2,
      requestTimeoutMs: 1,
    })

    expect(result.status).toBe("reconcile")
  })

  test("keeps settlement session-owned when rejection unmounts the question before a settling response", async () => {
    const sessionID = "ses_unmounted_settlement"
    const current = request("que_unmounted_settlement", sessionID)
    const error = { status: 503, body: { error: "Server restarting" } }
    let available = false
    let finishes = 0
    const finishGate = beginQuestionSettlement(sessionID)
    const sdk = {
      v2: {
        session: {
          activity: () =>
            available
              ? Promise.resolve({ data: { data: { type: "idle" as const } } })
              : Promise.reject(error),
        },
      },
    } as unknown as OpencodeClient

    expect(
      trackQuestionActivitySettlement(sdk, {
        request: current,
        activity: { status: "settling", activityID: "act_unmounted_settlement" },
        finish: () => {
          finishes++
          finishGate()
        },
        poll: { pollMs: 1, maxPollMs: 1, maxFailures: 2 },
      }),
    ).toBeTrue()

    for (const _ of Array.from({ length: 20 })) {
      if (questionSessionSettlement(sessionID)?.status === "reconcile") break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(questionSessionSettlement(sessionID)).toMatchObject({ status: "reconcile", error })
    expect(questionSettlementPending(sessionID)).toBeTrue()
    expect(finishes).toBe(0)

    available = true
    retryQuestionSettlement(sessionID)
    for (const _ of Array.from({ length: 20 })) {
      if (!questionSessionSettlement(sessionID)) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(questionSessionSettlement(sessionID)).toBeUndefined()
    expect(questionSettlementPending(sessionID)).toBeFalse()
    expect(isSurfaceRequestSettled(current)).toBeTrue()
    expect(finishes).toBe(1)
  })

  test("keeps a failed reject session-owned and retries without releasing its gate early", async () => {
    const sessionID = "ses_reject_reconcile"
    const current = request("que_reject_reconcile", sessionID)
    const error = { status: 503, body: { error: "Response lost after commit" } }
    let attempts = 0
    let finishes = 0
    const finishGate = beginQuestionSettlement(sessionID)
    const sdk = client({ activity: [{ type: "busy", activityID: "act_reject_reconcile" }, { type: "idle" }] })

    trackQuestionRejectSettlement(sdk, {
      request: current,
      finish: () => {
        finishes++
        finishGate()
      },
      poll: { pollMs: 1, maxPollMs: 1 },
      submit: () => {
        attempts++
        if (attempts === 1) return Promise.reject(error)
        return Promise.resolve({
          settled: "submitted",
          activity: { status: "settling", activityID: "act_reject_reconcile" },
        })
      },
    })

    for (const _ of Array.from({ length: 20 })) {
      if (questionSessionSettlement(sessionID)?.status === "reconcile") break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(questionSessionSettlement(sessionID)).toMatchObject({ status: "reconcile", error })
    expect(questionSettlementPending(sessionID)).toBeTrue()
    expect(finishes).toBe(0)

    retryQuestionSettlement(sessionID)
    for (const _ of Array.from({ length: 20 })) {
      if (!questionSessionSettlement(sessionID)) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(attempts).toBe(2)
    expect(questionSessionSettlement(sessionID)).toBeUndefined()
    expect(questionSettlementPending(sessionID)).toBeFalse()
    expect(finishes).toBe(1)
  })

  test("caps settlement polling backoff", () => {
    expect(questionSettlementPollDelay(250, 1_000)).toBe(500)
    expect(questionSettlementPollDelay(500, 1_000)).toBe(1_000)
    expect(questionSettlementPollDelay(1_000, 1_000)).toBe(1_000)
  })

  test("surfaces a conflicting duplicate answer without reconciliation or retry", async () => {
    const conflict = { status: 409, body: { error: "Question already answered differently" } }
    const calls: string[] = []
    const sdk = client({ replies: [conflict], onCall: (call) => calls.push(call) })

    await expect(
      replyQuestion(sdk, { request: request("que_conflict"), answers: [["No"]], directory: "C:/repo" }),
    ).rejects.toBe(conflict)
    expect(calls).toEqual(["v2.reply"])
    expect(isQuestionConflictError(conflict)).toBeTrue()
    expect(questionRequestErrorMessage(conflict)).toBe("Question already answered differently")
  })
})
