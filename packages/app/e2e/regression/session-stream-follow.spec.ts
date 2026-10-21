import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors } from "../utils/errors"
import { expectAppVisible, expectSessionTitle } from "../utils/waits"

type EventPayload = { directory: string; payload: Record<string, unknown> }

type Sample = { top: number; height: number; scrollTop: number; scrollHeight: number; distance: number }

const directory = "C:/OpenCode/StreamFollowRegression"
const projectID = "proj_stream_follow_regression"
const title = "Stream follow regression"
const model = { providerID: "opencode", modelID: "claude-opus-4-6", variant: "max" }

function base64Encode(value: string) {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

// Each test rebinds this so fixtures target the session under test.
let sharedSessionID = "ses_shared"

function userInfo(id: string, created: number, text: string) {
  return {
    info: {
      id,
      sessionID: sharedSessionID,
      role: "user",
      time: { created },
      summary: { diffs: [] },
      agent: "build",
      model,
    },
    parts: [{ id: `${id}_part`, sessionID: sharedSessionID, messageID: id, type: "text", text }],
  }
}

function assistantInfo(id: string, parentID: string, created: number, text: string, completed?: number) {
  return {
    info: {
      id,
      sessionID: sharedSessionID,
      role: "assistant",
      time: { created, ...(completed === undefined ? {} : { completed }) },
      parentID,
      modelID: model.modelID,
      providerID: model.providerID,
      mode: "build",
      agent: "build",
      path: { cwd: directory, root: directory },
      cost: 0,
      tokens: { input: 100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
      variant: model.variant,
      ...(completed === undefined ? {} : { finish: "stop" }),
    },
    parts: [{ id: `${id}_part`, sessionID: sharedSessionID, messageID: id, type: "text", text }],
  }
}

function streamPart(id: string, messageID: string, text: string) {
  return { id, sessionID: sharedSessionID, messageID, type: "text", text }
}

async function openSession(page: Page, input: { sessionID: string; directory: string; title: string; projectID: string }) {
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
    { directory: input.directory, dirBase64: base64Encode(input.directory), sessionID: input.sessionID },
  )
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(input.directory)}/session/${input.sessionID}`)
  const tab = page.locator(`[data-dock-tab][data-session-id="${input.sessionID}"]`).getByRole("tab")
  await expectAppVisible(tab)
  await tab.click()
  await expectSessionTitle(page, input.title)
}

function samplePosition(page: Page) {
  return page.evaluate(
    () =>
      new Promise<Sample[]>((resolve) => {
        const values: Sample[] = []
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

function bottomDistance(page: Page) {
  return page
    .locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
    .evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)
}

test.describe("regression: session stream follow", () => {
  test("follows streamed output while the active turn gains many assistant steps", async ({ page }) => {
    const errors = trackPageErrors(page)
    const failures: string[] = []
    page.on("response", (response) => {
      if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`)
    })
    const sessionID = "ses_follow_steps"
    sharedSessionID = sessionID
    const events: EventPayload[] = []

    // Shape mirrors the reported session: few user turns, the active turn already
    // carrying dozens of completed assistant steps, and streaming still ongoing.
    const pad = (value: number) => String(value).padStart(3, "0")
    const turnUser = (index: number) => `msg_steps_user_${pad(index)}`
    const turnStep = (turn: number, step: number) => `msg_steps_asst_${pad(turn)}_${pad(step)}`
    const activeUser = turnUser(3)

    const history: unknown[] = []
    for (let turn = 1; turn <= 2; turn++) {
      history.push(userInfo(turnUser(turn), 1_700_000_000_000 + turn * 10_000, `Prompt ${turn}`))
      for (let step = 1; step <= 8; step++) {
        history.push(assistantInfo(turnStep(turn, step), turnUser(turn), 1_700_000_000_000 + turn * 10_000 + step, `Done ${turn}/${step}.`, 1))
      }
    }
    history.push(userInfo(activeUser, 1_700_000_030_000, "Orchestrate the work."))
    for (let step = 1; step <= 40; step++) {
      history.push(assistantInfo(turnStep(3, step), activeUser, 1_700_000_030_000 + step, `Step ${step} finished with findings.`))
    }

    await mockOpenCodeServer(page, {
      directory,
      project: {
        id: projectID,
        worktree: directory,
        vcs: "git",
        name: "stream-follow-regression",
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
      pageMessages: () => ({ items: history }),
      sessionStatus: { [sessionID]: { type: "busy" } },
      eventRetry: 10,
      events: () => events.splice(0),
    })

    await openSession(page, { sessionID, directory, title, projectID })
    await expectAppVisible(page.getByText("Step 40 finished with findings.", { exact: true }))
    await page.locator(".scroll-view__viewport").last().evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })

    const samples = samplePosition(page)

    // Interleave growth of the newest step with brand-new steps appearing,
    // matching an orchestrator turn that keeps spawning assistant rounds.
    // Every new step arrives as message.updated + part pair so no part is
    // ever orphaned without its assistant message row.
    let latestStep = 41
    const pushStepMessage = (index: number) => {
      events.push({
        directory,
        payload: { type: "message.updated", properties: { info: assistantInfo(turnStep(3, index), activeUser, 1_700_000_040_000 + index, "").info } },
      })
    }
    const pushGrowth = (text: string) => {
      events.push({
        directory,
        payload: {
          type: "message.part.updated",
          properties: { part: streamPart(`${turnStep(3, latestStep)}_part`, turnStep(3, latestStep), text) },
        },
      })
    }
    pushStepMessage(latestStep)
    pushGrowth("Streaming assistant output grows steadily. ".repeat(8))
    for (let round = 0; round < 10; round++) {
      await page.waitForTimeout(70)
      if (round % 3 === 2) {
        latestStep += 1
        pushStepMessage(latestStep)
        events.push({
          directory,
          payload: {
            type: "message.part.updated",
            properties: { part: streamPart(`${turnStep(3, latestStep)}_part`, turnStep(3, latestStep), `Step ${latestStep} streaming. `.repeat(4)) },
          },
        })
        continue
      }
      pushGrowth(`Streaming assistant output grows steadily. `.repeat(8 + round * 6))
    }
    await page.waitForTimeout(250)

    await expect(page.locator('[data-timeline-row="AssistantPart"]').last()).toContainText("grows steadily")
    const positions = await samples
    // The pinned contract: while output streams, the newest row must stay glued
    // to the viewport bottom at every sample. Raw row tops are intentionally not
    // asserted: switching to a freshly appended step and the cosmetic slide-in
    // of the follow animation move the tracked element while distance stays 0,
    // so the visible invariant is bottom distance alone.
    const unpinned = positions.filter((sample) => sample.distance > 2)
    expect(unpinned).toEqual([])
    expect(positions.at(-1)?.distance).toBeLessThanOrEqual(2)
    expect(errors).toEqual([])
    expect(failures).toEqual([])
  })

  test("keeps following after the visible window slides past 160 turns", async ({ page }) => {
    const errors = trackPageErrors(page)
    const failures: string[] = []
    page.on("response", (response) => {
      if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`)
    })
    const sessionID = "ses_follow_window"
    sharedSessionID = sessionID
    const events: EventPayload[] = []

    const pad = (value: number) => String(value).padStart(4, "0")
    const turnUser = (index: number) => `msg_win_user_${pad(index)}`
    const turnAsst = (index: number) => `msg_win_asst_${pad(index)}`
    const activeIndex = 171
    const activeUser = turnUser(activeIndex)

    const history: unknown[] = []
    for (let index = 1; index <= activeIndex - 1; index++) {
      history.push(userInfo(turnUser(index), 1_700_000_000_000 + index * 2_000, `Prompt ${index}`))
      history.push(assistantInfo(turnAsst(index), turnUser(index), 1_700_000_000_000 + index * 2_000 + 500, `Earlier answer ${index}.`, 1))
    }

    await mockOpenCodeServer(page, {
      directory,
      project: {
        id: projectID,
        worktree: directory,
        vcs: "git",
        name: "stream-follow-regression",
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
      pageMessages: () => ({ items: history }),
      sessionStatus: { [sessionID]: { type: "busy" } },
      eventRetry: 10,
      events: () => events.splice(0),
    })

    await openSession(page, { sessionID, directory, title, projectID })
    await expectAppVisible(page.getByText(`Prompt ${activeIndex - 1}`, { exact: true }))
    await page.locator(".scroll-view__viewport").last().evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })

    const samples = samplePosition(page)

    // The 171st turn arrives live: the 160-item window must slide (count stays
    // constant) and the view must stay pinned to the bottom regardless.
    events.push({
      directory,
      payload: { type: "message.updated", properties: { info: userInfo(activeUser, 1_700_000_350_000, "Prompt 171").info } },
    })
    events.push({
      directory,
      payload: {
        type: "message.part.updated",
        properties: { part: streamPart(`${activeUser}_part`, activeUser, "Prompt 171") },
      },
    })
    const activeAsst = turnAsst(activeIndex)
    events.push({
      directory,
      payload: { type: "message.updated", properties: { info: assistantInfo(activeAsst, activeUser, 1_700_000_350_500, "").info } },
    })
    for (let round = 0; round < 12; round++) {
      await page.waitForTimeout(70)
      events.push({
        directory,
        payload: {
          type: "message.part.updated",
          properties: { part: streamPart(`${activeAsst}_part`, activeAsst, `Streaming assistant output grows steadily. `.repeat(6 + round * 5)) },
        },
      })
    }
    await page.waitForTimeout(250)

    await expect(page.locator('[data-timeline-row="AssistantPart"]').last()).toContainText("grows steadily")
    await expect.poll(() => bottomDistance(page), { timeout: 5_000 }).toBeLessThanOrEqual(2)
    const positions = await samples
    // Same pinned contract as the many-steps case. The window slide swaps the
    // tracked row and the follow animation slides it in; both move the raw top
    // while the viewport stays glued to the bottom (distance 0), so distance
    // remains the asserted invariant.
    const unpinned = positions.filter((sample) => sample.distance > 2)
    expect(unpinned).toEqual([])
    expect(errors).toEqual([])
    expect(failures).toEqual([])
  })
})
