import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ConfigAccessControl } from "@opencode-ai/core/config/access-control"
import { PermissionSafetyReview } from "@opencode-ai/core/permission/safety-review"

// Live regression (opencode.log 2026-09-02, run 22adf09e): a malformed
// glm-5.3 primary response ended the whole safety review chain in
// attemptPrimary because only transient transport errors advanced to the
// next stage. The configured chain glm-5.3 -> grok-4.6 -> gpt-5.6-sol must
// keep running through every technical failure and only stop on an explicit
// reviewer decision.
test("actionable unsafe verdict redirects the agent before asking the user, but outages do not", () => {
  const unsafe: PermissionSafetyReview.Result = {
    approved: false,
    cause: "unsafe_consensus",
    risk: "high",
    attempts: [{ role: "primary", model: "test/reviewer", status: "unsafe", reason: "Replace only the requested localization entry, not the whole file" }],
  }
  expect(PermissionSafetyReview.redirectFeedback(unsafe)).toContain("Replace only the requested localization entry")
  expect(PermissionSafetyReview.redirectFeedback({ ...unsafe, cause: "reviewers_unavailable" })).toBeUndefined()
  expect(PermissionSafetyReview.redirectFeedback({ ...unsafe, attempts: [] })).toBeUndefined()
})

const GLM = "zhipuai-coding-plan/glm-5.3"
const GROK = "cursor/grok-4.6"
const GPT = "openai/gpt-5.6-sol"

const reviewer = (model: string): ConfigAccessControl.SafetyReviewer => ({ model })

const malformed = (model: string): PermissionSafetyReview.Attempt => ({
  role: "primary",
  model,
  status: "malformed",
  reason: "Invalid reviewer output",
})
const transient = (model: string): PermissionSafetyReview.Attempt => ({
  role: "primary",
  model,
  status: "transport_error",
  reason: "Provider request failed",
  transient: true,
})
const unavailable = (model: string): PermissionSafetyReview.Attempt => ({
  role: "primary",
  model,
  status: "unavailable",
  reason: "Model unavailable",
})
const decision = (model: string, status: "safe" | "unsafe"): PermissionSafetyReview.Attempt => ({
  role: "primary",
  model,
  status,
  reason: `${status} by ${model}`,
})

// Scripts one attempt queue per reviewer model and records the call order.
function scripted(responses: Record<string, PermissionSafetyReview.Attempt[]>) {
  const used: string[] = []
  const run = (item: ConfigAccessControl.SafetyReviewer) =>
    Effect.sync(() => {
      const model = item.model ?? "unknown"
      used.push(model)
      const next = responses[model]?.shift()
      if (!next) throw new Error(`unexpected attempt for ${model}`)
      return next
    })
  return { run, used }
}

describe("PermissionSafetyReview.nextChainAction", () => {
  test("explicit decisions stop the chain", () => {
    expect(PermissionSafetyReview.nextChainAction(decision(GLM, "safe"), 1)).toBe("stop")
    expect(PermissionSafetyReview.nextChainAction(decision(GLM, "unsafe"), 1)).toBe("stop")
  })

  test("malformed output advances to the next chain stage instead of ending the review", () => {
    expect(PermissionSafetyReview.nextChainAction(malformed(GLM), 1)).toBe("advance")
  })

  test("unavailable models and non-transient transport errors advance", () => {
    expect(PermissionSafetyReview.nextChainAction(unavailable(GLM), 1)).toBe("advance")
    expect(
      PermissionSafetyReview.nextChainAction({ role: "primary", model: GLM, status: "transport_error", reason: "Bad request" }, 1),
    ).toBe("advance")
  })

  test("transient failures get exactly one bounded retry on the same stage", () => {
    expect(PermissionSafetyReview.nextChainAction(transient(GLM), 1)).toBe("retry")
    expect(PermissionSafetyReview.nextChainAction(transient(GLM), PermissionSafetyReview.MAX_STAGE_ATTEMPTS)).toBe("advance")
  })
})

describe("PermissionSafetyReview.runReviewerChain", () => {
  test("malformed primary output advances through the configured chain to a safe decision", () => {
    const script = scripted({ [GLM]: [malformed(GLM)], [GROK]: [decision(GROK, "safe")], [GPT]: [] })
    const attempts = Effect.runSync(PermissionSafetyReview.runReviewerChain([reviewer(GLM), reviewer(GROK), reviewer(GPT)], script.run))
    expect(attempts.map((attempt) => attempt.status)).toEqual(["malformed", "safe"])
    expect(script.used).toEqual([GLM, GROK])
  })

  test("transient stage failures retry once on the same model before advancing", () => {
    const script = scripted({
      [GLM]: [transient(GLM), transient(GLM)],
      [GROK]: [decision(GROK, "safe")],
    })
    const attempts = Effect.runSync(PermissionSafetyReview.runReviewerChain([reviewer(GLM), reviewer(GROK)], script.run))
    expect(attempts.map((attempt) => attempt.status)).toEqual(["transport_error", "transport_error", "safe"])
    expect(script.used).toEqual([GLM, GLM, GROK])
  })

  test("an unsafe verdict stops the chain immediately and later stages are never called", () => {
    const script = scripted({ [GLM]: [decision(GLM, "unsafe")], [GROK]: [], [GPT]: [] })
    const attempts = Effect.runSync(
      PermissionSafetyReview.runReviewerChain([reviewer(GLM), reviewer(GROK), reviewer(GPT)], script.run),
    )
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.status).toBe("unsafe")
    expect(script.used).toEqual([GLM])
  })

  test("unavailable first stage advances to the next configured model", () => {
    const script = scripted({ [GLM]: [unavailable(GLM)], [GROK]: [decision(GROK, "safe")] })
    const attempts = Effect.runSync(PermissionSafetyReview.runReviewerChain([reviewer(GLM), reviewer(GROK)], script.run))
    expect(attempts.map((attempt) => attempt.status)).toEqual(["unavailable", "safe"])
  })

  test("all stages failing technically ends with the last technical attempt, never a verdict", () => {
    const script = scripted({
      [GLM]: [malformed(GLM)],
      [GROK]: [transient(GROK), malformed(GROK)],
      [GPT]: [malformed(GPT)],
    })
    const attempts = Effect.runSync(
      PermissionSafetyReview.runReviewerChain([reviewer(GLM), reviewer(GROK), reviewer(GPT)], script.run),
    )
    // The attempts list is what permission.ts embeds as
    // $opencode.permission.safety_review metadata and the app permission dock
    // renders: every entry must stay presentable (model + human status) and
    // no technical failure may masquerade as safe/unsafe.
    expect(attempts.map((attempt) => `${attempt.model}:${attempt.status}`)).toEqual([
      `${GLM}:malformed`,
      `${GROK}:transport_error`,
      `${GROK}:malformed`,
      `${GPT}:malformed`,
    ])
    expect(attempts.every((attempt) => attempt.status !== "safe" && attempt.status !== "unsafe")).toBe(true)
    expect(script.used).toEqual([GLM, GROK, GROK, GPT])
  })
})

describe("PermissionSafetyReview.decodeDecisionFromText", () => {
  test("parses strict raw JSON", () => {
    expect(PermissionSafetyReview.decodeDecisionFromText(`{"decision":"safe","reason":"read-only"}`)).toEqual({
      decision: "safe",
      reason: "read-only",
    })
  })

  test("parses fenced json blocks with surrounding prose", () => {
    const text = 'Here is my review:\n```json\n{"decision":"unsafe","reason":"rm -rf"}\n```\nDone.'
    expect(PermissionSafetyReview.decodeDecisionFromText(text)).toEqual({ decision: "unsafe", reason: "rm -rf" })
  })

  test("parses fences without a json tag", () => {
    const text = '```\n{"decision":"safe","reason":"ok"}\n```'
    expect(PermissionSafetyReview.decodeDecisionFromText(text)).toEqual({ decision: "safe", reason: "ok" })
  })

  test("parses an object wrapped in prose without fences", () => {
    const text = 'Analysis first. {"decision":"safe","reason":"git status is read-only"} That is all.'
    expect(PermissionSafetyReview.decodeDecisionFromText(text)).toEqual({
      decision: "safe",
      reason: "git status is read-only",
    })
  })

  test("finds the decision object when the model emits an analysis object first", () => {
    const text = '{"summary":"looks fine"} {"decision":"safe","reason":"no writes"}'
    expect(PermissionSafetyReview.decodeDecisionFromText(text)).toEqual({ decision: "safe", reason: "no writes" })
  })

  test("finds a valid object outside a fence whose fenced content is invalid", () => {
    const text = '```json\n{"decision": maybe}\n```\n{"decision":"safe","reason":"recovered"}'
    expect(PermissionSafetyReview.decodeDecisionFromText(text)).toEqual({ decision: "safe", reason: "recovered" })
  })

  test("normalizes trailing commas outside strings", () => {
    const text = '{"decision":"safe","reason":"trailing comma",}'
    expect(PermissionSafetyReview.decodeDecisionFromText(text)).toEqual({ decision: "safe", reason: "trailing comma" })
  })

  test("never rewrites string values while normalizing", () => {
    const text = '{"decision":"safe","reason":"keep comma, } exactly"}'
    expect(PermissionSafetyReview.decodeDecisionFromText(text)).toEqual({
      decision: "safe",
      reason: "keep comma, } exactly",
    })
  })

  test("keeps escaped quotes intact", () => {
    const text = '{"decision":"unsafe","reason":"runs \\"git push\\" --force"}'
    expect(PermissionSafetyReview.decodeDecisionFromText(text)).toEqual({
      decision: "unsafe",
      reason: 'runs "git push" --force',
    })
  })

  test("rejects empty and whitespace-only output", () => {
    expect(PermissionSafetyReview.decodeDecisionFromText("")).toBeUndefined()
    expect(PermissionSafetyReview.decodeDecisionFromText("   \n  ")).toBeUndefined()
  })

  test("rejects lenient decision spellings instead of guessing a verdict", () => {
    expect(PermissionSafetyReview.decodeDecisionFromText(`{"decision":"Safe","reason":"capitalized"}`)).toBeUndefined()
    expect(PermissionSafetyReview.decodeDecisionFromText(`{"decision":" SAFE ","reason":"padded"}`)).toBeUndefined()
    expect(PermissionSafetyReview.decodeDecisionFromText(`{"decision":"probably safe","reason":"hedged"}`)).toBeUndefined()
    expect(PermissionSafetyReview.decodeDecisionFromText(`{"decision":"safely","reason":"prefix"}`)).toBeUndefined()
  })

  test("rejects objects without a string reason or with a non-literal decision", () => {
    expect(PermissionSafetyReview.decodeDecisionFromText(`{"decision":"safe"}`)).toBeUndefined()
    expect(PermissionSafetyReview.decodeDecisionFromText(`{"decision":"safe","reason":123}`)).toBeUndefined()
    expect(PermissionSafetyReview.decodeDecisionFromText(`{"decision":["safe"],"reason":"array"}`)).toBeUndefined()
  })
})
