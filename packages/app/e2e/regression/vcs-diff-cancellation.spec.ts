import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { fixture } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"

test("cancels stale VCS diffs when file watcher updates invalidate the review", async ({ page }) => {
  let event = 0
  let requests = 0
  let aborted = 0
  const releases: (() => void)[] = []

  page.on("requestfailed", (request) => {
    if (new URL(request.url()).pathname === "/vcs/diff" && request.failure()?.errorText === "net::ERR_ABORTED") {
      aborted += 1
    }
  })

  await mockOpenCodeServer(page, {
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages: (sessionID) => ({ items: fixture.messages[sessionID] ?? [] }),
    eventRetry: 50,
    events: () => {
      event += 1
      return [
        {
          directory: fixture.directory,
          payload: {
            id: `evt_vcs_${event}`,
            type: "file.watcher.updated",
            properties: { file: `src/watcher-${event}.ts` },
          },
        },
      ]
    },
  })

  await page.route("**/vcs/diff**", async (route) => {
    requests += 1
    if (requests === 1) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
      return
    }
    await new Promise<void>((resolve) => releases.push(resolve))
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" }).catch(() => undefined)
  })

  await page.addInitScript(
    ({ dir, dirBase64, server, sessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { [server]: [{ worktree: dir, expanded: true }] }, lastProject: { [server]: dir } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server, dirBase64, sessionId: sessionID }]),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs.recent",
        JSON.stringify({ key: `${server}\n${dirBase64}\n${sessionID}` }),
      )
    },
    {
      dir: fixture.directory,
      dirBase64: base64Encode(fixture.directory),
      server: "http://127.0.0.1:4096",
      sessionID: fixture.sourceID,
    },
  )

  try {
    await page.goto(`/${base64Encode(fixture.directory)}/session/${fixture.sourceID}`)
    await expect(page.getByRole("heading", { name: fixture.expected.sourceTitle })).toBeVisible()
    await page.getByRole("button", { name: "Toggle right dock" }).click()

    await expect.poll(() => requests).toBeGreaterThanOrEqual(2)
    await expect.poll(() => aborted).toBeGreaterThanOrEqual(1)
  } finally {
    releases.forEach((release) => release())
  }
})
