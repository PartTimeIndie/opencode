import { mkdirSync } from "node:fs"
import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { trackNetworkFailures, trackPageErrors } from "../utils/errors"
import { mockOpenCodeServer } from "../utils/mock-server"
import { fixture } from "../smoke/session-timeline.fixture"

const directory = "C:/OpenCode/session-tab-close-scroll"
const server = "http://127.0.0.1:4096"
const sessions = Array.from({ length: 14 }, (_, index) => ({
  id: `ses_tab_close_scroll_${index.toString().padStart(2, "0")}`,
  slug: `tab-close-scroll-${index}`,
  projectID: "project-session-tab-close-scroll",
  directory,
  title: `Session tab ${index.toString().padStart(2, "0")} with a long title`,
  version: "dev",
  time: { created: 1_700_000_000_000 + index, updated: 1_700_000_000_000 + index },
}))

test("keeps the replacement tab visible when closing the active tab", async ({ page }) => {
  const consoleErrors = trackPageErrors(page)
  const networkFailures = trackNetworkFailures(page)
  const active = sessions[11]!
  const replacement = sessions[12]!

  await mockOpenCodeServer(page, {
    sessions,
    provider: fixture.provider,
    directory,
    project: { id: "project-session-tab-close-scroll", name: "Tab Close Scroll", worktree: directory, vcs: "git" },
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ dir, dirBase64, sessionIDs, serverKey, activeSessionID }) => {
      window.__OPENCODE_TEST_PLATFORM__ = {
        platform: "desktop",
        os: "windows",
        openLink() {},
        back() {},
        forward() {},
        async restart() {},
        async notify() {},
        async openDirectoryPickerDialog() {
          return null
        },
      }
      localStorage.setItem("settings.v3", JSON.stringify({ general: { sidebarSessionLimit: 14 } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { [serverKey]: [{ worktree: dir, expanded: true }] },
          lastProject: { [serverKey]: dir },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify(sessionIDs.map((sessionId) => ({ type: "session", server: serverKey, dirBase64, sessionId }))),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs.recent",
        JSON.stringify({ key: `${serverKey}\n${dirBase64}\n${activeSessionID}` }),
      )
    },
    {
      dir: directory,
      dirBase64: base64Encode(directory),
      sessionIDs: sessions.map((session) => session.id),
      serverKey: server,
      activeSessionID: active.id,
    },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${active.id}`)

  const strip = page.locator('section[data-dock-area="middle"] [role="tablist"]')
  const activeTab = strip.locator(`[data-dock-tab][data-session-id="${active.id}"]`)
  await expect(strip).toBeVisible()
  await expect(activeTab.getByRole("tab")).toHaveAttribute("aria-selected", "true")
  await activeTab.evaluate((element) => element.scrollIntoView({ inline: "nearest" }))
  await expect.poll(() => strip.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)

  await activeTab.getByRole("button", { name: `Close ${active.title}` }).click()

  const replacementTab = strip.locator(`[data-dock-tab][data-session-id="${replacement.id}"]`)
  await expect(replacementTab.getByRole("tab")).toHaveAttribute("aria-selected", "true")
  const geometry = (sessionID: string) =>
    strip.evaluate((element, id) => {
      const tab = element.querySelector<HTMLElement>(`[data-dock-tab][data-session-id="${id}"]`)
      const trigger = tab?.querySelector<HTMLElement>("[role='tab']")
      const target = tab?.querySelector<HTMLElement>("[data-action='session-tab-actions'] > :last-child") ?? tab
      if (!trigger || !target) return { visible: false, scrollLeft: element.scrollLeft }
      const containerRect = element.getBoundingClientRect()
      const triggerRect = trigger.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      return {
        visible:
          triggerRect.right > containerRect.left &&
          triggerRect.left < containerRect.right &&
          targetRect.left >= containerRect.left - 1 &&
          targetRect.right <= containerRect.right + 1,
        scrollLeft: element.scrollLeft,
      }
    }, sessionID)

  if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
    mkdirSync(process.env.VISUAL_QA_SCREENSHOT_DIR, { recursive: true })
    await page.screenshot({
      path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/session-tab-close-scroll.png`,
      fullPage: true,
    })
  }

  await expect.poll(async () => (await geometry(replacement.id)).visible).toBe(true)
  const rightScroll = (await geometry(replacement.id)).scrollLeft
  expect(rightScroll).toBeGreaterThan(0)

  const firstTab = strip.locator(`[data-dock-tab][data-session-id="${sessions[0]!.id}"]`)
  await firstTab.getByRole("tab").click()
  await expect(firstTab.getByRole("tab")).toHaveAttribute("aria-selected", "true")
  await expect.poll(async () => (await geometry(sessions[0]!.id)).visible).toBe(true)
  expect((await geometry(sessions[0]!.id)).scrollLeft).toBeLessThan(rightScroll)
  expect(consoleErrors).toEqual([])
  expect(networkFailures).toEqual([])
})
