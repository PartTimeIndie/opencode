import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors } from "../utils/errors"
import { expectAppVisible, expectSessionTitle } from "../utils/waits"

// Regression: scrolling away from the bottom with the custom overlay scrollbar
// thumb must disengage bottom-follow. The thumb bypasses wheel/touch/keydown
// gesture detection, so follow used to stay armed and later idle resizes
// (status flicker rows, measurement corrections) yanked the viewport to the
// bottom and the virtualizer anchor snapped it back up.
const directory = "C:/OpenCode/ThumbScrollRegression"
const projectID = "proj_thumb_scroll_regression"
const sessionID = "ses_thumb_scroll_regression"
const title = "Thumb scroll regression"
const model = { providerID: "opencode", modelID: "claude-opus-4-6", variant: "max" }

test("thumb drag disengages bottom follow while the session is idle", async ({ page }) => {
  const errors = trackPageErrors(page)
  const failures: string[] = []
  page.on("response", (response) => {
    if (response.status() >= 400) failures.push(`${response.status} ${response.url()}`)
  })
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "thumb-scroll-regression",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: model.providerID,
          name: "OpenCode",
          models: { [model.modelID]: { id: model.modelID, name: "Claude Opus 4.6", limit: { context: 200_000 } } },
        },
      ],
      default: { providerID: model.providerID, modelID: model.modelID },
      connected: [model.providerID],
    },
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID,
        directory,
        title,
        version: "dev",
        time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      },
    ],
    pageMessages: () => ({ items: messages() }),
    sessionStatus: { [sessionID]: { type: "idle" } },
  })

  await page.addInitScript(
    ({ directory, dirBase64, sessionID }) => {
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server: "http://127.0.0.1:4096", dirBase64, sessionId: sessionID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sessionID },
  )
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const tab = page.locator(`[data-dock-tab][data-session-id="${sessionID}"]`).getByRole("tab")
  await expectAppVisible(tab)
  await tab.click()
  await expectSessionTitle(page, title)
  await expectAppVisible(page.getByText("Prompt 11", { exact: true }))

  await dragThumbUp(page, 320)
  await expect.poll(() => bottomDistance(page)).toBeGreaterThan(600)
  const reading = await page
    .locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
    .evaluate((element) => element.scrollTop)
  expect(reading).toBeGreaterThan(0)

  const samples = sampleScroll(page)
  const row = page.locator("[data-timeline-row]").first()
  await row.evaluate((element) => {
    element.setAttribute("data-scroll-resize-probe", "true")
    element.style.minHeight = "420px"
  })
  await page.waitForTimeout(350)
  await row.evaluate((element) => {
    element.style.minHeight = ""
  })
  await page.waitForTimeout(350)

  const positions = await samples
  expect(positions.length).toBeGreaterThan(5)
  const drift = positions.map((sample) => Math.abs(sample.scrollTop - reading))
  const yanked = positions.filter((sample) => sample.distance <= 300)
  expect(yanked).toEqual([])
  expect(Math.max(...drift)).toBeLessThanOrEqual(500)

  await page.screenshot({ path: "test-results/session-thumb-scroll-follow-desktop.png" })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator("[data-timeline-row]").first()).toBeVisible()
  await page.screenshot({ path: "test-results/session-thumb-scroll-follow-mobile.png" })
  expect(errors).toEqual([])
  expect(failures).toEqual([])
})

async function dragThumbUp(page: Page, pixels: number) {
  const thumb = page.locator(".scroll-view__thumb").first()
  const box = await thumb.boundingBox()
  if (!box) throw new Error("scroll thumb is not rendered")
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX, startY - pixels, { steps: 12 })
  await page.mouse.up()
}

function bottomDistance(page: Page) {
  return page
    .locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
    .evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)
}

function sampleScroll(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ scrollTop: number; distance: number }[]>((resolve) => {
        const values: { scrollTop: number; distance: number }[] = []
        const end = performance.now() + 2_600
        const root = () =>
          Array.from(document.querySelectorAll<HTMLElement>(".scroll-view__viewport")).find((element) =>
            element.querySelector("[data-timeline-row]"),
          )
        const sample = () => {
          const element = root()
          if (element) {
            values.push({
              scrollTop: element.scrollTop,
              distance: element.scrollHeight - element.clientHeight - element.scrollTop,
            })
          }
          if (performance.now() >= end) return resolve(values)
          frame()
        }
        const frame = () => requestAnimationFrame(() => setTimeout(sample, 0))
        frame()
      }),
  )
}

function messages() {
  return Array.from({ length: 12 }, (_, index) => fillerTurn(index)).flat()
}

function fillerTurn(index: number) {
  const userID = `msg_filler_user_${index}`
  const assistantID = `msg_filler_assistant_${index}`
  return [
    {
      info: {
        id: userID,
        sessionID,
        role: "user",
        time: { created: 1_700_000_000_000 + index * 2_000 },
        summary: { diffs: [] },
        agent: "build",
        model,
      },
      parts: [{ id: `prt_filler_user_${index}`, sessionID, messageID: userID, type: "text", text: `Prompt ${index}` }],
    },
    {
      info: {
        id: assistantID,
        sessionID,
        role: "assistant",
        time: {
          created: 1_700_000_001_000 + index * 2_000,
          completed: 1_700_000_001_500 + index * 2_000,
        },
        parentID: userID,
        modelID: model.modelID,
        providerID: model.providerID,
        mode: "build",
        agent: "build",
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        variant: model.variant,
        finish: "stop",
      },
      parts: [
        {
          id: `prt_filler_assistant_${index}`,
          sessionID,
          messageID: assistantID,
          type: "text",
          text: `Earlier assistant output ${index}. ${"filler ".repeat(40)}`,
        },
      ],
    },
  ]
}

function base64Encode(value: string) {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}
