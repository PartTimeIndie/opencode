import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { fixture, pageMessagesFor } from "../smoke/session-timeline.fixture"
import { trackPageErrors } from "../utils/errors"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

// Regression: the active session tab must reconcile its timeline from the server while
// the session is busy, even when the event pipeline delivers nothing new. A fully
// event-driven timeline froze the visible agent output until the user switched tabs
// away and back (documented SSE saturation incidents).
test.describe("regression: busy timeline catch-up", () => {
  test.setTimeout(120_000)

  test("shows new server-side messages on the active busy tab without live events", async ({ page }, testInfo) => {
    const errors = trackPageErrors(page)
    const messages = structuredClone(fixture.messages)
    const marker = "Busy catch-up marker output."
    await mockOpenCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages: (sessionID, limit, before) => pageMessagesFor(messages, sessionID, limit, before),
      sessionStatus: { [fixture.targetID]: { type: "busy" } },
      events: () => [],
    })
    await configureBusyCatchupPage(page, fixture.directory)
    await page.goto(`/${base64Encode(fixture.directory)}/session/${fixture.targetID}`)
    await expectSessionTitle(page, fixture.expected.targetTitle)
    await expect
      .poll(
        () =>
          page.evaluate(() => document.querySelectorAll<HTMLElement>(".scroll-view__viewport [data-timeline-row]").length),
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0)

    const targetHistory = messages[fixture.targetID]
    expect(targetHistory.length).toBeGreaterThan(0)
    const last = targetHistory.at(-1)!
    const messageID = `${last.info.id}_catchup`
    targetHistory.push({
      info: {
        ...last.info,
        id: messageID,
        role: "assistant",
        time: { created: 1_700_000_900_000, completed: 1_700_000_900_000 + 4_000 },
        parentID: last.info.id,
        finish: "stop",
      },
      parts: [
        {
          id: `${messageID}_text`,
          sessionID: fixture.targetID,
          messageID,
          type: "text",
          text: marker,
        },
      ],
    })

    // The event stream is intentionally silent: only the busy reconciliation path can
    // surface the new server-side message on the active tab.
    await expect(page.getByText(marker, { exact: true })).toBeVisible({ timeout: 20_000 })

    const currentErrors = errors.filter((error) => !error.includes("Set-Location"))
    expect(currentErrors).toEqual([])
    await page.screenshot({ path: testInfo.outputPath("busy-catchup-visible.png"), fullPage: true })
  })
})

async function configureBusyCatchupPage(page: Page, directory: string) {
  await page.addInitScript(({ directory, dirBase64, sourceID, targetID }) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: {
          local: [{ worktree: directory, expanded: true }],
        },
        lastProject: {
          local: directory,
        },
      }),
    )
    localStorage.setItem(
      "opencode.global.dat:tabs",
      JSON.stringify(
        [sourceID, targetID].map((sessionId) => ({
          type: "session",
          server: "http://127.0.0.1:4096",
          dirBase64,
          sessionId,
        })),
      ),
    )
    localStorage.setItem(
      "opencode.global.dat:tabs.recent",
      JSON.stringify({ key: `http://127.0.0.1:4096\n${dirBase64}\n${targetID}` }),
    )
  }, {
    directory,
    dirBase64: base64Encode(directory),
    sourceID: fixture.sourceID,
    targetID: fixture.targetID,
  })
}
