import { describe, expect, test } from "bun:test"
const { isCompletedScheduledJobRun, scheduledJobMessageID, scheduledJobModelSelection, scheduledJobPrompt, scheduledJobSessionID, scheduledJobTaskPrompt, shouldReuseScheduledJobSession } = await import(new URL("../../../../.opencode/plugin-sources/scheduled-jobs-app/app-runner-helpers.js", import.meta.url).href)

describe("scheduled job sessions", () => {
  test("replaces a reusable session when reset history is requested", () => {
    expect(
      shouldReuseScheduledJobSession({ strategy: "job", existing: "ses_old", resetHistory: true }),
    ).toBe(false)
    expect(
      shouldReuseScheduledJobSession({ strategy: "job", existing: "ses_old", resetHistory: false }),
    ).toBe(true)
  })

  test("does not resubmit a completed app run after a renderer reload", () => {
    expect(
      isCompletedScheduledJobRun({ runID: "run-42", lastRunID: "run-42", lastRunStatus: "success" }),
    ).toBe(true)
    expect(
      isCompletedScheduledJobRun({ runID: "run-42", lastRunID: "run-42", lastRunStatus: "running" }),
    ).toBe(false)
    expect(
      isCompletedScheduledJobRun({ runID: "run-42", lastRunID: "run-41", lastRunStatus: "success" }),
    ).toBe(false)
  })

  test("derives a stable prompt message ID from the scheduled run identity", async () => {
    const input = { scopeId: "scheduled-jobs-scope", slug: "cold-start-app-job", runId: "run-cold-start" }

    expect(await scheduledJobMessageID(input)).toBe("msg_300cafe59eda4d9c0b5d548dc6")
    expect(await scheduledJobMessageID(input)).toBe(await scheduledJobMessageID({ ...input }))
    expect(await scheduledJobMessageID({ ...input, runId: "run-cold-start-2" })).not.toBe(
      await scheduledJobMessageID(input),
    )
  })

  test("derives a stable session ID so crash recovery cannot create an orphan duplicate", async () => {
    const input = { scopeId: "scheduled-jobs-scope", slug: "cold-start-app-job", runId: "run-cold-start" }

    expect(await scheduledJobSessionID(input)).toBe("ses_300cafe59eda4d9c0b5d548dc6")
    expect(await scheduledJobSessionID(input)).toBe(await scheduledJobSessionID({ ...input }))
    expect(await scheduledJobSessionID({ ...input, runId: "run-cold-start-2" })).not.toBe(
      await scheduledJobSessionID(input),
    )
  })

  test("resolves chain references exclusively through the public model resolver", () => {
    const model = { providerID: "ox", id: "alpha", chain: { id: "daily", name: "Daily fallback", active: 0, steps: [{ providerID: "ox", id: "alpha" }, { providerID: "zai", id: "glm-5.3", variant: "high" }] } }
    const refs: string[] = []
    expect(scheduledJobModelSelection({ modelChain: "default", model: "legacy/ignored" }, (ref: string) => { refs.push(ref); return model })).toEqual(model)
    expect(refs).toEqual(["chain:default"])
  })

  test("preserves direct model variants and fails closed for unresolved references", () => {
    expect(scheduledJobModelSelection({ model: "openai/gpt-5.6-sol", variant: "high" }, () => ({ providerID: "openai", id: "gpt-5.6-sol" }))).toEqual({ providerID: "openai", id: "gpt-5.6-sol", variant: "high" })
    expect(() => scheduledJobModelSelection({ modelChain: "default" }, () => undefined)).toThrow('model chain "default" is not configured')
    expect(() => scheduledJobModelSelection({ model: "missing/model" }, () => undefined)).toThrow('model "missing/model" is unavailable')
  })

  test("adds the explicit scheduled result contract without changing the configured prompt", () => {
    const prompt = scheduledJobPrompt("Run the scheduled review.")

    expect(prompt).toStartWith("Run the scheduled review.\n\n")
    expect(prompt).toContain("opencode.scheduled-job-result/v1")
    expect(prompt).toContain("call scheduled_job_result exactly once")
    expect(prompt).toContain('status "success"')
    expect(prompt).toContain('status "failed"')
    expect(prompt).toContain("If scheduled_job_result is not offered in your tool list")
    expect(prompt).toContain("never substitute another tool for it")
  })

  test("uses the stored job task when an old run record contains only the result contract", () => {
    expect(
      scheduledJobTaskPrompt({
        prompt: "Run the Daily Agent Review.",
        run: { prompt: "opencode.scheduled-job-result/v1" },
      }),
    ).toBe("Run the Daily Agent Review.")
    expect(scheduledJobTaskPrompt({ run: { prompt: "opencode.scheduled-job-result/v1\nImmediately before your terminal response" } })).toBeUndefined()
  })
})
