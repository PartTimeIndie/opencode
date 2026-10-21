import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors } from "../utils/errors"
import { expectAppVisible, expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/ActiveScrollRegression"
const projectID = "proj_active_scroll_regression"
const sessionID = "ses_active_scroll_regression"
const userMessageID = "msg_zzzz_active_scroll_user"
const assistantMessageID = "msg_zzzz_active_scroll_assistant"
const partID = "prt_zzzz_active_scroll_text"
const title = "Active scroll regression"
const model = { providerID: "opencode", modelID: "claude-opus-4-6", variant: "max" }

type EventPayload = { directory: string; payload: Record<string, unknown> }

test("active assistant output only moves upward while following the bottom", async ({ page }) => {
  const errors = trackPageErrors(page)
  const failures: string[] = []
  page.on("response", (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`)
  })
  const events: EventPayload[] = []
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "active-scroll-regression",
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
    pageMessages: () => ({ items: messages("Starting active output.") }),
    sessionStatus: { [sessionID]: { type: "busy" } },
    eventRetry: 10,
    events: () => events.splice(0),
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
  await expectAppVisible(page.getByText("Starting active output.", { exact: true }))
  await page.locator(".scroll-view__viewport").last().evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })

  const samples = samplePosition(page)
  for (const index of Array.from({ length: 24 }, (_, index) => index + 1)) {
    const text = `${"Streaming assistant output grows steadily. ".repeat(index * 4)}\n\n${"More detail follows. ".repeat(index * 2)}`
    events.push({
      directory,
      payload: { type: "message.part.updated", properties: { part: textPart(text) } },
    })
    await page.waitForTimeout(35)
  }
  await expect(page.locator('[data-timeline-row="AssistantPart"]').last()).toContainText("More detail follows.")
  await page.waitForTimeout(250)

  const positions = await samples
  const downward = positions.flatMap((sample, index) => {
    const previous = positions[index - 1]
    if (!previous || sample.top - previous.top <= 1) return []
    return [{ previous, sample }]
  })
  expect(downward).toEqual([])
  expect(positions.at(-1)?.distance).toBeLessThanOrEqual(2)
  await page.screenshot({ path: "test-results/session-active-scroll-desktop.png" })

  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => bottomDistance(page)).toBeLessThanOrEqual(2)
  await page.screenshot({ path: "test-results/session-active-scroll-mobile.png" })
  expect(errors).toEqual([])
  expect(failures).toEqual([])
})

function bottomDistance(page: Page) {
  return page
    .locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
    .evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)
}

function samplePosition(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ top: number; height: number; scrollTop: number; scrollHeight: number; distance: number }[]>((resolve) => {
        const values: { top: number; height: number; scrollTop: number; scrollHeight: number; distance: number }[] = []
        const end = performance.now() + 1_400
        const sample = () => {
          const rows = document.querySelectorAll<HTMLElement>('[data-timeline-row="AssistantPart"]')
          const part = rows[rows.length - 1]
          const root = part?.closest<HTMLElement>(".scroll-view__viewport")
          if (part && root) {
            values.push({
              top: part.getBoundingClientRect().top,
              height: part.getBoundingClientRect().height,
              scrollTop: root.scrollTop,
              scrollHeight: root.scrollHeight,
              distance: root.scrollHeight - root.clientHeight - root.scrollTop,
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

function messages(text: string) {
  return [
    ...Array.from({ length: 10 }, (_, index) => fillerTurn(index)).flat(),
    {
      info: {
        id: userMessageID,
        sessionID,
        role: "user",
        time: { created: 1_700_000_100_000 },
        summary: { diffs: [] },
        agent: "build",
        model,
      },
      parts: [{ id: "prt_active_scroll_user", sessionID, messageID: userMessageID, type: "text", text: "Stream output." }],
    },
    {
      info: {
        id: assistantMessageID,
        sessionID,
        role: "assistant",
        time: { created: 1_700_000_101_000 },
        parentID: userMessageID,
        modelID: model.modelID,
        providerID: model.providerID,
        mode: "build",
        agent: "build",
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        variant: model.variant,
      },
      parts: [textPart(text)],
    },
  ]
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
        time: { created: 1_700_000_001_000 + index * 2_000, completed: 1_700_000_001_500 + index * 2_000 },
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
          text: `Earlier assistant output ${index}. ${"filler ".repeat(30)}`,
        },
      ],
    },
  ]
}

function textPart(text: string) {
  return { id: partID, sessionID, messageID: assistantMessageID, type: "text", text }
}

function base64Encode(value: string) {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}
