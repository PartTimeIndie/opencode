import { describe, expect, test } from "bun:test"
import { PermissionSafetyReview } from "@opencode-ai/core/permission/safety-review"

// Contract for the session permission dock: it renders the review embedded by
// core at request.metadata["$opencode.permission.safety_review"] when a manual
// permission decision is required after the safety review chain could not
// produce an approving verdict. Every attempt the dock lists must carry a
// presentable model identifier and a human-readable status/reason, and the
// cause must tell the user that reviewers were unavailable - never that the
// action was approved or denied by a reviewer.
describe("session permission dock review metadata contract", () => {
  const attempts: PermissionSafetyReview.Attempt[] = [
    { role: "primary", model: "zhipuai-coding-plan/glm-5.3", status: "malformed", reason: "Invalid reviewer output" },
    { role: "primary", model: "cursor/grok-4.6", status: "transport_error", reason: "Provider request failed", transient: true },
    { role: "primary", model: "cursor/grok-4.6", status: "malformed", reason: "Invalid reviewer output" },
    { role: "primary", model: "openai/gpt-5.6-sol", status: "unavailable", reason: "Model unavailable" },
  ]

  test("a technically failed review denies approval and reports reviewers_unavailable", () => {
    const review: PermissionSafetyReview.Result = {
      approved: false,
      cause: "reviewers_unavailable",
      risk: "high",
      attempts,
    }
    expect(review.approved).toBe(false)
    expect(review.cause).toBe("reviewers_unavailable")
    expect(review.risk).toBe("high")
  })

  test("every attempt entry is presentable with model and human-readable status", () => {
    for (const attempt of attempts) {
      expect(typeof attempt.model).toBe("string")
      expect(attempt.model).toMatch(/^.+\/.+$/)
      expect(["safe", "unsafe", "unavailable", "transport_error", "malformed"]).toContain(attempt.status)
      expect(typeof attempt.reason).toBe("string")
      expect((attempt.reason ?? "").length).toBeGreaterThan(0)
    }
  })

  test("an unsafe verdict is a distinct cause and can never be reported as a technical failure", () => {
    const review: PermissionSafetyReview.Result = {
      approved: false,
      cause: "unsafe_consensus",
      risk: "high",
      attempts: [{ role: "primary", model: "zhipuai-coding-plan/glm-5.3", status: "unsafe", reason: "destructive write outside workspace" }],
    }
    expect(review.cause).not.toBe("reviewers_unavailable")
    expect(review.attempts[0]?.status).toBe("unsafe")
  })
})
