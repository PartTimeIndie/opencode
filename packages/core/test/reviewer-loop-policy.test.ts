import { expect, test } from "bun:test"
import { ReviewerLoopPolicy } from "@opencode-ai/core/tool/reviewer-loop-policy"

const full = {
  repeats: 4,
  fullOutputEqual: true,
  sourceStampEqual: true,
  correctionHintDelivered: true,
}

test("stops only the child after repeated identical actions with complete evidence", () => {
  const decision = ReviewerLoopPolicy.decide("verified-loop", full)
  expect(decision).toMatchObject({ action: "abort-child" })
})

test("incomplete evidence can only warn, never stop the reviewer", () => {
  for (const evidence of [
    { ...full, repeats: 2 },
    { ...full, repeats: 3 },
    { ...full, fullOutputEqual: false },
    { ...full, sourceStampEqual: false },
    { ...full, correctionHintDelivered: false },
  ]) {
    expect(ReviewerLoopPolicy.decide("verified-loop", evidence)).toMatchObject({ action: "warn" })
  }
  expect(ReviewerLoopPolicy.decide("verified-loop", { ...full, repeats: 1 })).toMatchObject({ action: "none" })
})

test("the suspicion stop stays locked without an attested host grant", () => {
  expect(ReviewerLoopPolicy.overrideFor({ sessionID: "ses_p", callID: "call_p", runID: "ses_c" })).toBeUndefined()
  // Prompt text never authorizes: an unattested grant call is rejected.
  expect(
    ReviewerLoopPolicy.grantOverride({
      sessionID: "ses_p",
      callID: "call_p",
      runID: "ses_c",
      attested: false as never,
      mode: "suspicion",
    }),
  ).toBe(false)
  expect(ReviewerLoopPolicy.overrideFor({ sessionID: "ses_p", callID: "call_p", runID: "ses_c" })).toBeUndefined()
  expect(ReviewerLoopPolicy.mode({ sessionID: "ses_p", callID: "call_p", runID: "ses_c" })).toBe("verified-loop")
})

test("an attested grant binds exactly one run and clears afterwards", () => {
  expect(
    ReviewerLoopPolicy.grantOverride({
      sessionID: "ses_p",
      callID: "call_p",
      runID: "ses_c",
      attested: true,
      mode: "suspicion",
    }),
  ).toBe(true)
  expect(ReviewerLoopPolicy.overrideFor({ sessionID: "ses_p", callID: "call_p", runID: "ses_c" })).toBe("suspicion")
  expect(ReviewerLoopPolicy.overrideFor({ sessionID: "ses_p", callID: "call_p", runID: "ses_other" })).toBeUndefined()
  expect(ReviewerLoopPolicy.decide("suspicion", { ...full, repeats: 2 })).toMatchObject({ action: "abort-child" })
  expect(ReviewerLoopPolicy.clearOverride({ sessionID: "ses_p", callID: "call_p", runID: "ses_c" })).toBe(true)
  expect(ReviewerLoopPolicy.overrideFor({ sessionID: "ses_p", callID: "call_p", runID: "ses_c" })).toBeUndefined()
})
