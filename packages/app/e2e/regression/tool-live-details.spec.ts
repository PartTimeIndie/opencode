import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/ToolLiveDetails"
const sessionID = "ses_tool_live_details"
const childID = "ses_reviewer_details"
const messageID = "msg_tool_live_assistant"
const shellID = "call_live_shell"
const fanoutID = "call_live_fanout"
const title = "Live tool details"
const start = 1_700_000_000_000
const model = { providerID: "opencode", modelID: "test-model" }

for (const viewport of [
  { name: "desktop", width: 1280, height: 720 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`inspects running shell and fanout without executing actions on ${viewport.name}`, async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    const events: unknown[] = []
    const cancelled: string[] = []
    const submitted: unknown[] = []
    const errors: string[] = []
    const networkFailures: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("response", (response) => { if (response.status() >= 500) networkFailures.push(`${response.status()} ${response.url()}`) })
    page.on("requestfailed", (request) => { if (!request.failure()?.errorText.includes("ERR_ABORTED")) networkFailures.push(`${request.failure()?.errorText} ${request.url()}`) })
    let sequence = 0
    const shellState = {
      status: "running",
      input: { command: "bun test", description: "Verify live output" },
      structured: { command: "bun test", cwd: directory, output: "first live line", truncated: false },
      content: [],
      time: { start },
    }
    const fanoutState = {
      status: "running",
      input: { workflow: "review", prompt: "Inspect this change without editing files." },
      structured: {
        workflow: "review",
        reviewers: [
          { reviewer: { model: "configured/fast", variant: "high" }, state: "running", sessionID: childID },
          { reviewer: { model: "configured/fast" }, state: "queued" },
        ],
      },
      content: [],
      time: { start },
    }
    const sessions = [session(sessionID, title), session(childID, "Reviewer detail child")]
    await page.setViewportSize(viewport)
    await mockOpenCodeServer(page, {
      directory,
      project: {
        id: "proj_live_details",
        worktree: directory,
        name: "tool-live-details",
        vcs: "git",
        time: { created: start, updated: start },
        sandboxes: [],
      },
      provider: {
        all: [
          {
            id: model.providerID,
            name: "Test",
            models: { [model.modelID]: { id: model.modelID, name: "Test model", limit: { context: 200000 } } },
          },
        ],
        connected: [model.providerID],
        default: model,
      },
      sessions,
      eventDelay: 100,
      eventRetry: 100,
      events: () => events.splice(0),
      pageMessages: (id) => ({ items: id === childID ? [] : messages(shellState, fanoutState) }),
      onSessionToolCancel: ({ callID }) => {
        cancelled.push(callID)
        return { data: { cancelled: true } }
      },
      onSessionPrompt: (input) => {
        submitted.push(input)
        return { data: {} }
      },
    })
    const emit = (
      callID: string,
      structured: unknown,
      type = "session.next.tool.progress",
      extra: Record<string, unknown> = {},
    ) => {
      const timestamp = start + 10 + ++sequence
      const state = callID === shellID ? shellState : fanoutState
      Object.assign(state, {
        structured,
        status: type.endsWith("success") ? "completed" : type.endsWith("failed") ? "error" : "running",
      })
      events.push({
        directory,
        payload: {
          id: `evt_live_${String(sequence).padStart(5, "0")}`,
          type,
          properties: {
            sessionID,
            assistantMessageID: messageID,
            callID,
            timestamp,
            structured,
            content: [],
            ...extra,
          },
        },
      })
    }
    await page.goto(`/${Buffer.from(directory).toString("base64url")}/session/${sessionID}`)
    await expectSessionTitle(page, title)
    const shell = page.locator(`[data-timeline-part-id="${shellID}"]`).first()
    const fanout = page.locator(`[data-timeline-part-id="${fanoutID}"]`).first()
    const shellTrigger = shell.locator('[data-slot="collapsible-trigger"]').first()
    const fanoutTrigger = fanout.locator('[data-slot="collapsible-trigger"]').first()
    // Works whether the user's existing shell-default-open preference is on or off.
    if ((await shellTrigger.getAttribute("aria-expanded")) === "true") await shellTrigger.click()
    await expect(shell.locator('[data-slot="bash-pre"]')).not.toBeVisible()
    await shellTrigger.focus()
    await shellTrigger.press("Enter")
    await expect(shellTrigger).toHaveAttribute("aria-expanded", "true")
    await expect(shell.locator('[data-slot="bash-pre"]')).toContainText("first live line")
    emit(shellID, { ...shellState.structured, output: "first live line\nsecond live line" })
    await expect(shell.locator('[data-slot="bash-pre"]')).toContainText("second live line")
    await shellTrigger.click()
    emit(shellID, { ...shellState.structured, output: "third line while closed" })
    await expect(shellTrigger).toHaveAttribute("aria-expanded", "false")
    await shellTrigger.press("Space")
    await expect(shell.locator('[data-slot="bash-pre"]')).toContainText("third line while closed")
    await shell.getByRole("button", { name: "Copy", exact: true }).click()
    await expect(shellTrigger).toHaveAttribute("aria-expanded", "true")
    await shell.screenshot({ path: `test-results/tool-live-shell-${viewport.name}.png` })

    await fanoutTrigger.click()
    await expect(fanout.getByText("configured/fast · high", { exact: true })).toBeVisible()
    const firstLink = fanout.getByRole("link", { name: "Open agent session" })
    await firstLink.focus()
    const focusedLink = await firstLink.elementHandle()
    const reviewers = [
      {
        reviewer: { model: "configured/fast", variant: "high" },
        state: "completed",
        sessionID: childID,
        text: "Fast reviewer found no issues.",
      },
      { reviewer: { model: "configured/fast" }, state: "running" },
    ]
    emit(fanoutID, { workflow: "review", reviewers })
    await expect(fanout.getByText("Fast reviewer found no issues.", { exact: true })).toBeVisible()
    await expect(fanout.getByText("Running", { exact: true })).toBeVisible()
    await expect(firstLink).toBeFocused()
    expect(await focusedLink?.evaluate((node) => node.isConnected && node === document.activeElement)).toBe(true)
    await fanoutTrigger.click()
    emit(
      fanoutID,
      {
        workflow: "review",
        results: [
          {
            reviewer: reviewers[0].reviewer,
            sessionID: childID,
            status: "success",
            task: { sessionID: childID, state: "completed", text: "Fast reviewer found no issues." },
            result: { findings: [], notes: ["Fast reviewer found no issues."] },
          },
          { reviewer: reviewers[1].reviewer, status: "error", task: { state: "error", text: "Provider unavailable" } },
           { reviewer: { model: "configured/partial" }, status: "partial", task: { state: "error", text: "Original schema failure" },
             recovery: { source: "original", original: '{"findings":[{"title":"Recovered finding"},{"title":5}]}',
               repaired: '{"findings":[]}', findings: [{ title: "Recovered finding" }], issues: ["findings[1]: invalid against registered item schema"], repairStatus: "failed" } },
          { reviewer: { model: "configured/repaired" }, status: "success", task: { state: "error", text: "Original schema failure" },
            result: { findings: [{ title: "Repaired finding" }], notes: [] },
            recovery: { source: "repaired", original: '{"findings":[{"title":5}]}',
              repaired: '{"findings":[{"title":"Repaired finding"}],"notes":[]}',
              findings: [], issues: ["findings[0]: invalid against registered item schema"], repairStatus: "success" } },
        ],
      },
      "session.next.tool.success",
      { provider: { executed: false } },
    )
    await expect(fanoutTrigger).toHaveAttribute("aria-expanded", "false")
    await fanoutTrigger.click()
    await expect(fanout.getByText("Provider unavailable", { exact: true })).toBeVisible()
    await expect(fanout.getByText("Recovered finding", { exact: false }).first()).toBeVisible()
    await expect(fanout.getByText("Partially usable — not a clean review")).toBeVisible()
    await expect(fanout.getByText("Failed format repair (not a reviewed result)")).toBeVisible()
    await expect(fanout.getByText("Repaired separately — original review failed")).toBeVisible()
    await fanout.getByText("Original reviewer answer (format error)").first().click()
    await expect(fanout.locator('[data-slot="fanout-original"]').first()).toContainText("Recovered finding")
    await fanout.evaluate((element) => element.scrollIntoView({ block: "center" }))
    await fanout.screenshot({ path: `test-results/tool-live-fanout-${viewport.name}.png` })
    await page.reload()
    await expectSessionTitle(page, title)
    if ((await shellTrigger.getAttribute("aria-expanded")) !== "true") await shellTrigger.click()
    if ((await fanoutTrigger.getAttribute("aria-expanded")) !== "true") await fanoutTrigger.click()
    await expect(shell.locator('[data-slot="bash-pre"]')).toContainText("third line while closed")
    await expect(fanout.getByText("Provider unavailable", { exact: true })).toBeVisible()
    await expect(fanout.getByText("Partially usable — not a clean review")).toBeVisible()
    await expect(fanout.getByText("Failed format repair (not a reviewed result)")).toBeVisible()
    await expect(fanout.getByText("Repaired separately — original review failed")).toBeVisible()
    await expect(fanout.getByRole("link", { name: "Open agent session" })).toHaveCount(1)

    const warningShell = page.locator('[data-timeline-part-id="call_shell_warnings"]').first()
    const warningTrigger = warningShell.locator('[data-slot="collapsible-trigger"]').first()
    if ((await warningTrigger.getAttribute("aria-expanded")) !== "true") await warningTrigger.click()
    await expect(warningShell.locator('[data-slot="bash-pre"]')).toContainText(
      "Command argument references external directory",
    )
    await warningShell.getByRole("button", { name: "Copy", exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain("Command argument references external directory")
    await shell.getByRole("button", { name: "Cancel tool call", exact: true }).click()
    expect(cancelled).toEqual([shellID])
    await expect(shellTrigger).toHaveAttribute("aria-expanded", "true")
    emit(shellID, undefined, "session.next.tool.failed", {
      error: { message: "Tool execution interrupted" },
      provider: { executed: false },
    })
    await expect(shell.locator('[data-slot="bash-pre"]')).toContainText("Tool execution interrupted")
    await expect(shell.locator('[data-slot="bash-pre"]')).toContainText("third line while closed")
    emit(shellID, { output: "STALE OUTPUT" })
    await expect(shell.locator('[data-slot="bash-pre"]')).not.toContainText("STALE OUTPUT")
    await fanout.getByRole("link", { name: "Open agent session" }).click()
    await expectSessionTitle(page, "Reviewer detail child")
    expect(submitted).toEqual([])
    expect(cancelled).toEqual([shellID])
    expect(errors).toEqual([])
    expect(networkFailures).toEqual([])
  })
}

function session(id: string, name: string) {
  return {
    id,
    slug: id,
    projectID: "proj_live_details",
    directory,
    title: name,
    version: "dev",
    time: { created: start, updated: start },
  }
}

function messages(shell: Record<string, unknown>, fanout: Record<string, unknown>) {
  return [
    {
      info: {
        id: "msg_tool_live_user",
        sessionID,
        role: "user",
        time: { created: start },
        agent: "build",
        model,
        summary: { diffs: [] },
      },
      parts: [
        {
          id: "prt_user",
          sessionID,
          messageID: "msg_tool_live_user",
          type: "text",
          text: "Inspect shell and fanout progress.",
        },
      ],
    },
    {
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: "msg_tool_live_user",
        time: { created: start + 1 },
        agent: "build",
        mode: "build",
        providerID: model.providerID,
        modelID: model.modelID,
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        { id: shellID, sessionID, messageID, type: "tool", callID: shellID, tool: "bash", state: shell },
        {
          id: fanoutID,
          sessionID,
          messageID,
          type: "tool",
          callID: fanoutID,
          tool: "multi_agent_fanout",
          state: fanout,
        },
        {
          id: "call_shell_warnings",
          sessionID,
          messageID,
          type: "tool",
          callID: "call_shell_warnings",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "Get-Item C:/external/file.txt" },
            structured: {
              output: "completed output",
              warnings: ["Command argument references external directory C:/external/*"],
              exitCode: 0,
            },
            output: "completed output",
            time: { start, end: start + 1 },
          },
        },
      ],
    },
  ]
}
