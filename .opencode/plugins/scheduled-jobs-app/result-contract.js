export const resultToolName = "scheduled_job_result"
export const resultContractMarker = "opencode.scheduled-job-result/v1"
export const resultContract = [
  resultContractMarker,
  "Immediately before your terminal response, call scheduled_job_result exactly once.",
  '- Use status "success" only after every required action and verification completed.',
  '- Use status "failed" with a concise error for any blocker, timeout, failed check, partial result, or fail-closed path.',
  "Never rely on prose alone to report the scheduled job outcome.",
  "If scheduled_job_result is not offered in your tool list, stop making further tool calls and report the missing result tool as your final answer; never substitute another tool for it.",
].join("\n")
