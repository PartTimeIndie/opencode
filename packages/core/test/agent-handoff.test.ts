import { expect, test } from "bun:test"
import { dailyReviewBuildPrompt, dailyReviewHandoffMarkdown } from "../src/tool/agent-handoff"

test("handoff presentation binds the entire exact snapshot and retains the authorization limits", () => {
  const plan = { revision: 7, updatedAt: 123, sha256: "snapshot-digest", markdown: "# Plan\n\nAccepted: item-1\nRejected: item-2" }
  const before = { ...plan }
  const markdown = dailyReviewHandoffMarkdown(plan)
  expect(markdown).toContain("revision 7; updatedAt 123; SHA-256 snapshot-digest.")
  expect(markdown).toContain("including items marked `autoApply=false`")
  expect(markdown).toContain("Rejected (Nein), deferred (Später), alternatives, and work not listed as accepted are excluded.")
  expect(markdown).toContain(`\`\`\`text\n\n${dailyReviewBuildPrompt}\n\n\`\`\``)
  expect(markdown.endsWith(`## Complete plan snapshot\n\n${plan.markdown}`)).toBe(true)
  expect(plan).toEqual(before)
})
