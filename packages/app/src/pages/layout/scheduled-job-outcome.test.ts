import { describe, expect, test } from "bun:test"
const { scheduledJobPollingState } = await import(new URL("../../../../../.opencode/plugin-sources/scheduled-jobs-app/app-runner-helpers.js", import.meta.url).href)

describe("scheduled job outcome tracking", () => {
  test("awaiting input keeps the run active and continues polling without entering failure handling", () => {
    expect(scheduledJobPollingState("awaiting_input", "activity_resume", "activity_original")).toEqual({
      status: "running",
      activityID: "activity_resume",
      continuePolling: true,
    })
  })

  test("awaiting input retains the tracked activity when the outcome omits it", () => {
    expect(scheduledJobPollingState("awaiting_input", undefined, "activity_original")).toEqual({
      status: "running",
      activityID: "activity_original",
      continuePolling: true,
    })
    expect(scheduledJobPollingState("failed", "activity_resume", "activity_original")).toBeUndefined()
  })
})
