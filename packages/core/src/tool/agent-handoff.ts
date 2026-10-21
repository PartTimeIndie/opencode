// Pure presentation shared by the host and browser tests, without loading the
// Effect service graph or a machine-local coordinator adapter.
export const dailyReviewBuildPrompt = [
  "Implement every accepted item in this exact Daily Review plan snapshot in the listed stable order.",
  "Before each item, call daily_review_implementation operation=start with its exact planId, itemId, morningRunId, and approvalId. Run only one admission at a time and continue only after its terminal result.",
  "Do not implement Nein, Später, alternatives, or anything outside the accepted set. Preserve all dependency, report-only, Git, safety, direction-clarification, and process-stop restrictions.",
  "Stop on an unknown admission status. Once every accepted item is successful, durably blocked, terminally failed, or durably deferred, call operation=complete for the exact runId and runDate.",
].join("\n")

export function dailyReviewHandoffMarkdown(plan: { revision: number; updatedAt: number; sha256: string; markdown: string }) {
  return [
    "**Expected:** Confirm this handoff to authorize implementation of every accepted item below, or dismiss it to stop.",
    "## Authorization scope",
    "This one confirmation covers all accepted Daily Review items in this exact plan snapshot, including items marked `autoApply=false`. The build agent must process them sequentially through the per-item admission tool.",
    "Rejected (Nein), deferred (Später), alternatives, and work not listed as accepted are excluded. Existing dependency checks and report-only, Git, safety, and direction-clarification rules remain in force.",
    `Plan snapshot: revision ${plan.revision}; updatedAt ${plan.updatedAt}; SHA-256 ${plan.sha256}.`,
    "## Exact build prompt",
    "```text",
    dailyReviewBuildPrompt,
    "```",
    "## Complete plan snapshot",
    plan.markdown,
  ].join("\n\n")
}
