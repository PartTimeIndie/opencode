import { expect, test } from "bun:test"
import { collectReviewResult, originalReviewResponse, recoverReviewResult, repairableReview } from "../src/tool/review-result-recovery"
import { SessionMessage } from "../src/session/message"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { SessionFailure } from "../src/session/failure"
import { fanoutFailureText } from "../src/session/runner/to-llm-message"
import { reviewRecoveryEnabled } from "../src/tool/task"
import { DateTime } from "effect"

const schema = {
  type: "object",
  properties: {
    findings: { type: "array", items: { type: "object", properties: {
      title: { type: "string" }, evidence: { type: "string" }, risk: { enum: ["low", "medium", "high"] },
      suggestedFix: { type: "string" }, testRequirement: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    }, required: ["title", "evidence", "risk", "suggestedFix", "testRequirement", "confidence"], additionalProperties: false } },
    notes: { type: "array", items: { type: "string" } },
  }, required: ["findings", "notes"], additionalProperties: false,
}

const finding = { title: "Real bug", evidence: "File x", risk: "medium", suggestedFix: "Fix x", testRequirement: "Test x", confidence: 0.9 }

test("only the review-specific false setting disables result recovery", () => {
  expect(reviewRecoveryEnabled(undefined)).toBe(true)
  expect(reviewRecoveryEnabled({ review: { result_recovery: false } })).toBe(false)
  expect(reviewRecoveryEnabled({ review: { result_recovery: true } })).toBe(true)
  expect(reviewRecoveryEnabled({ neutral: { result_recovery: false } })).toBe(true)
})

test("a malformed neighbor does not discard a valid review finding", () => {
  const original = JSON.stringify({ findings: [finding, { ...finding, confidence: "unknown" }], notes: [] })
  const result = recoverReviewResult(schema, original)
  expect(result.status).toBe("partial")
  expect(result.findings).toEqual([finding])
  expect(result.original).toBe(original)
  expect(result.issues).toContain("findings[1]: invalid against registered item schema")
  expect(result.issues).toContain("The complete review does not match the registered result schema")
})

test("referenced item schemas validate each neighbor without assuming every schema is separable", () => {
  const referenced = { ...schema, $defs: { issue: schema.properties.findings.items },
    properties: { ...schema.properties, findings: { type: "array", items: { $ref: "#/$defs/issue" } } } }
  const result = recoverReviewResult(referenced, JSON.stringify({ findings: [finding, { ...finding, confidence: "invalid" }], notes: [] }))
  expect(result.status).toBe("partial")
  expect(result.findings).toEqual([finding])
})

test("extra fields rejected by the runner cannot masquerade as a clean result or validated item", () => {
  expect(recoverReviewResult(schema, JSON.stringify({ findings: [finding], notes: [], extra: true })).status).toBe("partial")
  const result = recoverReviewResult(schema, JSON.stringify({ findings: [finding, { ...finding, extra: true }], notes: [] }))
  expect(result.status).toBe("partial")
  expect(result.findings).toEqual([finding])
  expect(result.issues).toContain("findings[1]: invalid against registered item schema")
})

test("announcements do not trigger a repair", () => {
  expect(repairableReview("I will review the files now")).toBe(false)
  for (const empty of ["{}", "[]", "null", '{"notes":["I will review"],"findings":[]}', "I'll look for bugs in this patch"]) expect(repairableReview(empty)).toBe(false)
  expect(repairableReview("Finding: this fails in file x")).toBe(true)
  for (const placeholder of [{}, null, { title: "I will review the files now" }])
    expect(repairableReview(JSON.stringify({ findings: [placeholder], notes: [] }))).toBe(false)
  expect(repairableReview(JSON.stringify({ findings: [{ title: "Actual missing guard in src/x.ts" }], notes: [] }))).toBe(true)
})

test("only a typed structured failure after this admitted prompt exposes its original answer", () => {
  const prompt = SessionMessage.ID.make("msg_review_prompt")
  const user = new SessionMessage.User({ id: prompt, type: "user", text: "Review", files: [], agents: [], time: { created: DateTime.makeUnsafe(0) } })
  const original = '{"findings":[{"title":"Real bug"}],"notes":[]}'
  const assistant = (failure: ReturnType<typeof SessionFailure.make>) => new SessionMessage.Assistant({
    id: SessionMessage.ID.make("msg_review_answer"), type: "assistant", agent: "review",
    model: { id: "model" as never, providerID: "test" as never },
    content: [new SessionMessage.AssistantText({ id: "text", type: "text", text: original })],
    error: { type: "unknown", message: "failure" }, failure,
    time: { created: DateTime.makeUnsafe(0) },
  })
  const invalid = assistant(SessionFailure.make("provider.invalid-response", { retryability: "none", cause: { detail: "structured output" } }))
  const quota = assistant(SessionFailure.make("provider.rate-limit", { retryability: "none" }))
  expect(originalReviewResponse([user, invalid], prompt)).toBe(original)
  expect(originalReviewResponse([user, quota], prompt)).toBeUndefined()
  expect(originalReviewResponse([user, invalid], SessionMessage.ID.make("msg_foreign"))).toBeUndefined()
})

test("runner findings survive disabled collector recovery and bind all original evidence", () => {
  const prompt = SessionMessage.ID.make("msg_bound_review")
  const user = new SessionMessage.User({ id: prompt, type: "user", text: "Review", files: [], agents: [], time: { created: DateTime.makeUnsafe(0) } })
  const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("test") }
  const receipt = { version: 1 as const, inputID: prompt, inputDigest: "a".repeat(64), schemaDigest: "b".repeat(64), model, mode: "tool" as const }
  const reports = [finding, { ...finding, title: "Another real bug" }].map((item, index) =>
    new SessionMessage.Assistant({
      id: SessionMessage.ID.make(`msg_original_${index}`), type: "assistant", agent: "review", model,
      structuredOutputAttempt: { ...receipt, phase: "initial" },
      content: [new SessionMessage.AssistantText({ id: `part_${index}`, type: "text", text: JSON.stringify({ findings: [item], notes: [], invalid: true }) })],
      finish: "stop", time: { created: DateTime.makeUnsafe(index) },
    }))
  const corrected = JSON.stringify({ findings: [], notes: [] })
  const messages = [user, ...reports]
  const result = collectReviewResult({ schema, messages, promptID: prompt, completed: true, text: corrected, recoveryEnabled: false })
  expect(result.partial).toBe(true)
  expect(result.result).toBeUndefined()
  expect(result.recovery?.findings).toEqual([finding, { ...finding, title: "Another real bug" }])
  expect(result.recovery?.evidence).toMatchObject([
    { messageID: "msg_original_0", partIDs: ["part_0"], phase: "initial", findingIndexes: [0] },
    { messageID: "msg_original_1", partIDs: ["part_1"], phase: "initial", findingIndexes: [1] },
  ])
  expect(result.recovery?.evidence.every((source) => /^[a-f0-9]{64}$/.test(source.digest))).toBe(true)
  expect(JSON.stringify(result.recovery?.evidence)).not.toContain("Real bug")
  const failed = collectReviewResult({ schema, messages, promptID: prompt, completed: false, text: "Provider failed", recoveryEnabled: false })
  expect(failed.result).toBeUndefined()
  expect(failed.recovery?.findings).toEqual(result.recovery?.findings)
  const legacy = messages.map((message) => message.type === "assistant"
    ? new SessionMessage.Assistant({ ...message, structuredOutputAttempt: undefined,
      failure: SessionFailure.make("provider.invalid-response", { retryability: "none", cause: { detail: "structured output" } }) }) : message)
  expect(collectReviewResult({ schema, messages: legacy, promptID: prompt, completed: false, text: "Failed", recoveryEnabled: false }).recovery).toBeUndefined()
})

test("a locally valid original never turns a failed assignment into success", () => {
  const prompt = SessionMessage.ID.make("msg_failed_review")
  const user = new SessionMessage.User({ id: prompt, type: "user", text: "Review", files: [], agents: [], time: { created: DateTime.makeUnsafe(0) } })
  const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("test") }
  const report = new SessionMessage.Assistant({
    id: SessionMessage.ID.make("msg_failed_report"), type: "assistant", agent: "review", model,
    structuredOutputAttempt: { version: 1, inputID: prompt, inputDigest: "a".repeat(64), schemaDigest: "b".repeat(64), model, mode: "tool", phase: "initial" },
    content: [new SessionMessage.AssistantText({ id: "text", type: "text", text: JSON.stringify({ findings: [finding], notes: [] }) })],
    time: { created: DateTime.makeUnsafe(0) },
  })
  const result = collectReviewResult({ schema, messages: [user, report], promptID: prompt, completed: false, text: "Provider failed", recoveryEnabled: true })
  expect(result.result).toBeUndefined()
  expect(result.recovery?.findings).toEqual([finding])
})

test("a fully valid original remains complete", () => {
  const result = recoverReviewResult(schema, JSON.stringify({ findings: [finding], notes: [] }))
  expect(result.status).toBe("complete")
  expect(result.findings).toEqual([finding])
})

test("failed fanout replay preserves original findings but bounds oversized receipts", () => {
  const state = new SessionMessage.ToolStateError({ status: "error", input: {}, content: [],
    structured: { partial_results: [{ reviewer: { model: "fake/model" }, status: "success",
      result: { findings: [{ title: "Reworded" }] },
      recovery: { source: "repaired", findings: [{ title: "Original" }] } }] },
    error: { type: "unknown", message: "Fanout failed" },
  })
  const text = fanoutFailureText(state)
  expect(text).toContain('"original_findings":[{"title":"Original"}]')
  expect(text).toContain('"repair_is_not_independent":true')
  const huge = new SessionMessage.ToolStateError({ ...state,
    structured: { partial_results: [{ reviewer: { model: "fake/model" }, status: "success",
      result: { findings: [{ title: "x".repeat(40_000) }] } }] },
  })
  expect(fanoutFailureText(huge)).toContain("too large for replay")
  expect(fanoutFailureText(huge).length).toBeLessThan(500)
  const omitted = new SessionMessage.ToolStateError({ ...state,
    structured: { partial_results: [{ reviewer: { model: "fake/model" }, sessionID: "ses_reviewer_real",
      status: "partial", recovery: { source: "original", findings: [], omittedFindings: 1, issues: ["Schema mismatch"] } }] },
  })
  expect(fanoutFailureText(omitted)).toContain('"omitted_findings":1')
  expect(fanoutFailureText(omitted)).toContain('"sessionID":"ses_reviewer_real"')
})
