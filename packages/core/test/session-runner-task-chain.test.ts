import { describe, expect, test } from "bun:test"
import { HttpContext, HttpRequestDetails, HttpResponseDetails, LLMError, QuotaExceededReason, RateLimitReason } from "@opencode-ai/llm"
import { AgentV2 } from "@opencode-ai/core/agent"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionResume } from "@opencode-ai/core/session/resume"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { implementationTaskLane, taskChainExhaustedFailure } from "@opencode-ai/core/session/runner/llm"

describe("implementation-task chain lane", () => {
  const parent = SessionSchema.ID.make("ses_parent")
  const child = SessionSchema.ID.make("ses_child")
  const build = AgentV2.ID.make("build")
  const policy = (type: "spawn_agent" | "task" | "orchestrator") => ({
    tools: { mode: "explicit" as const, entries: {} },
    permissionLayers: [],
    source: { type, sessionID: parent, agent: build },
  })
  const chained = ModelV2.Ref.make({
    id: ModelV2.ID.make("fake-model"),
    providerID: ProviderV2.ID.make("fake"),
    chain: {
      id: "standard",
      name: "Standard",
      active: 1,
      steps: [
        { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
        { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      ],
    },
  })

  test("only native task children that are not reviewer or workflow workers use the lane", () => {
    expect(implementationTaskLane({ id: child, parentID: parent, agent: build, model: chained, agentPolicy: policy("task") })).toBe(true)
    expect(implementationTaskLane({ id: child, parentID: parent, agent: build, agentPolicy: policy("task") })).toBe(true)
    expect(implementationTaskLane({ id: child, parentID: parent, agent: build, model: chained, agentPolicy: policy("spawn_agent") })).toBe(false)
    expect(implementationTaskLane({ id: child, parentID: parent, agent: build, model: chained, agentPolicy: policy("orchestrator") })).toBe(false)
    expect(implementationTaskLane({ id: child, agent: build, model: chained })).toBe(false)
    // Registered reviewer/fanout workflow workers run the review agent and store a direct model.
    expect(
      implementationTaskLane({ id: child, parentID: parent, agent: AgentV2.ID.make("review"), model: chained, agentPolicy: policy("task") }),
    ).toBe(false)
    expect(
      implementationTaskLane({ id: child, parentID: parent, agent: build, model: { ...chained, chain: null }, agentPolicy: policy("task") }),
    ).toBe(false)
  })

  test("a chain pass records attempts, keeps the latest required wait and is bounded to two passes", () => {
    const budget = SessionResume.recoveryBudget()
    expect(budget.chainPass()).toBeUndefined()
    expect(budget.next()).toBe(1)

    const first = budget.observeChainFailure("standard", {
      retryable: true,
      delayMs: 1_500,
      attempt: "fake/fake-model:provider.rate-limit",
    })
    expect(first).toEqual({
      chain: "standard",
      pass: 1,
      retryable: true,
      delayMs: 1_500,
      attempts: ["fake/fake-model:provider.rate-limit"],
    })
    // A shorter Retry-After on a later step never pulls the wait forward.
    expect(
      budget.observeChainFailure("standard", { retryable: true, delayMs: 500, attempt: "fake/replacement:provider.rate-limit" }),
    ).toMatchObject({ pass: 1, retryable: true, delayMs: 1_500, attempts: ["fake/fake-model:provider.rate-limit", "fake/replacement:provider.rate-limit"] })
    expect(budget.restartChainPass("standard")).toEqual({
      chain: "standard",
      pass: 2,
      retryable: false,
      delayMs: 0,
      attempts: [
        "fake/fake-model:provider.rate-limit",
        "fake/replacement:provider.rate-limit",
      ],
    })
    expect(budget.observeChainFailure("standard", { retryable: false, delayMs: 0, attempt: "fake/replacement:provider.rate-limit" }))
      .toMatchObject({ pass: 2, retryable: false, quotaBlocked: true, delayMs: 0 })
    // A second restart is still counted by the caller through MAX_CHAIN_PASSES.
    expect(SessionResume.MAX_CHAIN_PASSES).toBe(2)

    // A changed binding (another chain id or steps) starts over from its first pass.
    expect(budget.observeChainFailure("other", { retryable: true, delayMs: 100, attempt: "fake/other:provider.transport" }))
      .toEqual({ chain: "other", pass: 1, retryable: true, delayMs: 100, attempts: ["fake/other:provider.transport"] })
    expect(budget.restartChainPass("other").attempts).toEqual(["fake/other:provider.transport"])

    // The visible record is capped; the lane itself is bounded by passes × steps.
    const capped = SessionResume.recoveryBudget()
    for (let index = 0; index < SessionResume.MAX_RECORDED_CHAIN_ATTEMPTS + 3; index++)
      capped.observeChainFailure("standard", { retryable: true, delayMs: 0, attempt: `fake/step-${index}:provider.transport` })
    expect(capped.chainPass()?.attempts).toHaveLength(SessionResume.MAX_RECORDED_CHAIN_ATTEMPTS)
    expect(capped.chainPass()?.attempts.at(-1)).toBe(`fake/step-${SessionResume.MAX_RECORDED_CHAIN_ATTEMPTS + 2}:provider.transport`)
  })

  test("the visible failure carries the code, every attempted model and the earliest retry time", () => {
    const failure = new LLMError({
      module: "test",
      method: "stream",
      reason: new RateLimitReason({ message: "Too many requests", retryAfterMs: 600_001 }),
    })
    const pass = SessionResume.recoveryBudget().observeChainFailure("standard", {
      retryable: true,
      delayMs: 600_001,
      attempt: "fake/fake-model:provider.rate-limit",
    })

    const deferred = taskChainExhaustedFailure({
      sessionID: child,
      failure,
      providerRef: "fake/fake-model",
      pass,
      deferredDelayMs: 600_001,
      now: 1_000_000,
    })
    expect(deferred.message).toBe(
      "Task model chain exhausted after 1 pass: The provider rate limit was reached (fake/fake-model). Tried fake/fake-model:provider.rate-limit." +
        " Earliest retry time: 1970-01-01T00:26:40.001Z." +
        " Retry-After 600001 ms exceeds the 300000 ms automatic wait limit; no early retry was sent." +
        ` Automatic recovery stopped. Resume this task later with a task follow-up for task_id ${child}.`,
    )
    expect(deferred.failure).toEqual({
      code: "provider.rate-limit",
      message: deferred.message,
      retryability: "none",
      remediation: "retry",
      providerRef: "fake/fake-model",
      retryAfterMs: 600_001,
      resetAt: 1_600_001,
      cause: {
        raw: "test.stream: Too many requests",
        detail: "task-chain-exhausted;passes=1;attempts=fake/fake-model:provider.rate-limit",
      },
    })
    expect(deferred.error.retryable).toBe(false)
    expect(deferred.error.reason).toMatchObject({ _tag: "Transport", kind: "task-chain-exhausted", retryAfterMs: 600_001 })
  })

  test("an exhausted pass without a known wait reports no earliest retry time", () => {
    const failure = new LLMError({
      module: "test",
      method: "stream",
      reason: new RateLimitReason({ message: "Too many requests" }),
    })
    const budget = SessionResume.recoveryBudget()
    budget.observeChainFailure("standard", { retryable: true, delayMs: 2_000, attempt: "fake/fake-model:provider.rate-limit" })
    const pass = budget.restartChainPass("standard")
    budget.observeChainFailure("standard", { retryable: true, delayMs: 2_000, attempt: "fake/fake-model:provider.rate-limit" })

    const exhausted = taskChainExhaustedFailure({ sessionID: child, failure, providerRef: "fake/fake-model", pass: budget.chainPass()! })
    expect(exhausted.message).toContain("Task model chain exhausted after 2 passes")
    expect(exhausted.message).toContain(
      "Tried fake/fake-model:provider.rate-limit, fake/fake-model:provider.rate-limit.",
    )
    expect(exhausted.message).not.toContain("Earliest retry time")
    expect(exhausted.failure.resetAt).toBeUndefined()
    expect(exhausted.failure.cause?.detail).toBe(
      "task-chain-exhausted;passes=2;attempts=fake/fake-model:provider.rate-limit,fake/fake-model:provider.rate-limit",
    )
    expect(pass.pass).toBe(2)
  })

  test("the terminal task receipt keeps provider quota reset and HTTP evidence", () => {
    const resetAt = Date.UTC(2026, 10, 24, 0)
    const failure = new LLMError({ module: "test", method: "stream", reason: new QuotaExceededReason({
      message: "Provider quota exhausted", http: new HttpContext({
        request: new HttpRequestDetails({ method: "POST", url: "http://127.0.0.1/fixture", headers: {} }),
        response: new HttpResponseDetails({ status: 429, headers: {} }),
        body: JSON.stringify({ error: { code: "1310", resets_at: new Date(resetAt).toISOString() } }),
      }),
    }) })
    const pass = SessionResume.recoveryBudget().observeChainFailure("standard", {
      retryable: false, delayMs: 0, attempt: "fake/fake-model:provider.rate-limit",
    })
    const exhausted = taskChainExhaustedFailure({ sessionID: child, failure, providerRef: "fake/fake-model", pass })
    expect(exhausted.failure).toMatchObject({ resetAt, httpStatus: 429, retryability: "none" })
    expect(exhausted.message).toContain(new Date(resetAt).toISOString())
  })
})
