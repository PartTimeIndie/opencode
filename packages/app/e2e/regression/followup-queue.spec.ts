import { mkdirSync, writeFileSync } from "node:fs"
import { expect, test, type Page } from "@playwright/test"
import { base64Encode, checksum } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"
import { pathKey } from "../../src/utils/path-key"

test.use({ video: "on", screenshot: "on" })

const directory = "C:/OpenCode/FollowupQueue"
const projectID = "proj_followup_queue"
const activeSessionID = "ses_followup_active"
const inactiveSessionID = "ses_followup_inactive"

function workspaceStorage(dir: string) {
  const key = pathKey(dir)
  const head = (key.slice(0, 12) || "workspace").replace(/[^a-zA-Z0-9._-]/g, "-")
  return `opencode.workspace.${head}.${checksum(key) ?? "0"}.dat`
}

function followupState(text: string, sessionID = inactiveSessionID, paused = false) {
  return {
    items: {
      [sessionID]: [
        {
          id: "message_queued_inactive",
          sessionID,
          sessionDirectory: directory,
          prompt: [{ type: "text", content: text, start: 0, end: text.length }],
          context: [],
          agent: "build",
          model: { providerID: "opencode", modelID: "claude-opus-4-6" },
        },
      ],
    },
    failed: {},
    paused: paused ? { [sessionID]: true } : {},
    edit: {},
  }
}

const provider = {
  all: [
    {
      id: "opencode",
      name: "OpenCode",
      models: {
        "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
      },
    },
  ],
  connected: ["opencode"],
  default: { providerID: "opencode", modelID: "claude-opus-4-6" },
}

async function setup(
  page: Page,
  options?: {
    activeBusy?: boolean
    inactiveBusy?: boolean
    queuedSessionID?: string
    persistedPaused?: boolean
    sessionAgent?: string
  },
) {
  const requests: Array<{ sessionID: string; body: Record<string, unknown> }> = []
  const interrupts: string[] = []
  const sessionStatus = {
    [activeSessionID]: { type: options?.activeBusy ? "busy" : "idle" },
    [inactiveSessionID]: { type: options?.inactiveBusy ? "busy" : "idle" },
  }
  let settled = false
  const navigationEvidence: unknown[] = []
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigationEvidence.push({ phase: "navigation", url: frame.url(), at: Date.now() })
  })

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "followup-queue",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider,
    sessions: [
      {
        id: activeSessionID,
        slug: "followup-active",
        projectID,
        directory,
        title: "Active session",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
        ...(options?.sessionAgent ? { agent: options.sessionAgent } : {}),
      },
      {
        id: inactiveSessionID,
        slug: "followup-inactive",
        projectID,
        directory,
        title: "Inactive queued session",
        version: "dev",
        time: { created: 1700000001000, updated: 1700000001000 },
        ...(options?.sessionAgent ? { agent: options.sessionAgent } : {}),
      },
    ],
    pageMessages: () => ({ items: [] }),
    sessionStatus,
    onSessionActivity: ({ sessionID }) => ({ data: { type: !settled && (sessionID === activeSessionID ? options?.activeBusy : sessionID === inactiveSessionID && options?.inactiveBusy) ? "busy" : "idle" } }),
    eventRetry: 50,
    events: () => {
      const events = settled
        ? [
            {
              directory,
              payload: {
                id: "evt_inactive_completed",
                type: "session.next.activity.completed",
                properties: { sessionID: options?.queuedSessionID ?? inactiveSessionID, activityID: `act_${options?.queuedSessionID ?? inactiveSessionID}` },
              },
            },
          ]
        : Object.entries(sessionStatus).filter(([, status]) => status.type === "busy").map(([sessionID]) => ({
            directory,
            payload: {
              id: `evt_${sessionID}_started`,
              type: "session.next.activity.started",
              properties: { sessionID, activityID: `act_${sessionID}` },
            },
          }))
      if (navigationEvidence.length < 50)
        navigationEvidence.push({ phase: "seed-events", events, at: Date.now() })
      return events
    },
    onSessionPrompt: (input) => {
      requests.push({ sessionID: input.sessionID, body: input.body as Record<string, unknown> })
      return {}
    },
    onSessionInterrupt: (input) => {
      interrupts.push(input.sessionID)
      settled = true
      return { data: true }
    },
  })

  await page.addInitScript((input) => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({ general: { followup: "queue", followupQueueMigrated: true } }),
    )
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({ projects: { local: [{ worktree: input.directory, expanded: true }] }, lastProject: { local: input.directory } }),
    )
    if (!localStorage.getItem(`${input.storage}:workspace:followup`))
      localStorage.setItem(`${input.storage}:workspace:followup`, JSON.stringify(input.followup))
    localStorage.setItem(
      "opencode.global.dat:tabs",
      JSON.stringify([{ type: "session", server: "http://127.0.0.1:4096", dirBase64: input.dirBase64, sessionId: input.sessionID }]),
    )
    const pane = `tab:${input.paneKey}`
    localStorage.setItem("opencode.global.dat:layout", JSON.stringify({ dock: {
      schema: 2,
      top: { visible: false, size: 160, tabs: [] },
      left: { visible: false, size: 280, tabs: [] },
      middle: { visible: true, size: 720, tabs: [pane], active: pane },
      right: { visible: false, size: 280, tabs: [] },
      bottom: { visible: false, size: 280, tabs: [] },
      items: { [pane]: { area: "middle", visible: true } },
    } }))
  }, {
    storage: workspaceStorage(directory),
    followup: followupState("queued while inactive later", options?.queuedSessionID, options?.persistedPaused),
    directory,
    dirBase64: base64Encode(directory),
    sessionID: activeSessionID,
    paneKey: base64Encode(`http://127.0.0.1:4096\n${base64Encode(directory)}\n${activeSessionID}`),
  })

  const openSession = async (sessionID: string) => {
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    const composer = page.locator('[data-component="session-composer"]')
    const capture = async (phase: string) => {
      navigationEvidence.push({ phase, sessionID, ...await page.evaluate(() => ({
        url: location.href,
        tabs: localStorage.getItem("opencode.global.dat:tabs"),
        recent: localStorage.getItem("opencode.global.dat:tabs.recent"),
        layout: localStorage.getItem("opencode.global.dat:layout"),
        selected: [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].map((node) => node.textContent),
        composer: !!document.querySelector('[data-component="session-composer"]'),
      })) })
    }
    await capture("before-composer-gate")
    try {
      // The former substring button fallback selected "Close Active session"
      // during mounting, closed the intended tab and activated a new draft.
      await expectAppVisible(composer)
      const state = await page.evaluate(() => ({
        tabs: JSON.parse(localStorage.getItem("opencode.global.dat:tabs") ?? "[]"),
        recent: JSON.parse(localStorage.getItem("opencode.global.dat:tabs.recent") ?? "{}"),
      }))
      expect(state.tabs).toEqual([{ type: "session", server: "http://127.0.0.1:4096", dirBase64: base64Encode(directory), sessionId: sessionID }])
      expect(state.recent).toEqual({ key: `http://127.0.0.1:4096\n${base64Encode(directory)}\n${sessionID}` })
    } finally {
      await capture("after-composer-gate")
      writeFileSync(test.info().outputPath("session-navigation-evidence.json"), JSON.stringify(navigationEvidence, null, 2))
      await test.info().attach("session-navigation-evidence", { body: JSON.stringify(navigationEvidence, null, 2), contentType: "application/json" })
    }
  }

  return {
    requests,
    interrupts,
    openSession,
    settleInactiveSession: () => {
      settled = true
    },
  }
}

async function verifyInactiveFollowupDrainsFromActiveTab(page: Page, name: string) {
  const errors = trackPageErrors(page)
  const failedResponses: string[] = []
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })

  const qa = await setup(page)
  await qa.openSession(activeSessionID)

  await expect.poll(() => qa.requests.length).toBe(1)
  expect(qa.requests[0]?.sessionID).toBe(inactiveSessionID)
  expect(qa.requests[0]?.body).toMatchObject({
    delivery: "queue",
    prompt: { text: "queued while inactive later" },
  })
  await page.waitForTimeout(500)
  expect(qa.requests).toHaveLength(1)
  mkdirSync("test-results/followup-queue", { recursive: true })
  await page.screenshot({ path: `test-results/followup-queue/${name}-sent-from-active.png`, fullPage: true })
  expectNoSmokeErrors(errors, [], [])
  expect(failedResponses).toEqual([])
}

test("drains an inactive session followup from the active tab on desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await verifyInactiveFollowupDrainsFromActiveTab(page, "desktop")
})

test("drains an inactive session followup from the active tab on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await verifyInactiveFollowupDrainsFromActiveTab(page, "mobile")
})

test("starts an inactive session followup when its active run settles", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const errors = trackPageErrors(page)
  const qa = await setup(page, { inactiveBusy: true })
  await qa.openSession(activeSessionID)

  await page.waitForTimeout(250)
  expect(qa.requests).toHaveLength(0)
  qa.settleInactiveSession()

  await expect.poll(() => qa.requests.length).toBe(1)
  expect(qa.requests[0]).toMatchObject({
    sessionID: inactiveSessionID,
    body: {
      delivery: "queue",
      prompt: { text: "queued while inactive later" },
    },
  })
  await page.waitForTimeout(250)
  expect(qa.requests).toHaveLength(1)
  expectNoSmokeErrors(errors, [], [])
})

test("drains an agent-mismatched queued followup without auto-pausing", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const errors = trackPageErrors(page)
  const qa = await setup(page, { activeBusy: true, queuedSessionID: activeSessionID, sessionAgent: "plan" })

  // A draft agent that differs from the session's authoritative agent must
  // neither park behind an automatic pause nor block the release. Drafts send
  // with the agent they were queued under.
  await qa.openSession(activeSessionID)
  const dock = page.locator('[data-component="session-followup-dock"]')
  await expect(dock).toBeVisible()
  await expect(dock).not.toContainText("Paused")
  await expect(dock.locator('[data-action="followup-pause"]')).toBeVisible()

  qa.settleInactiveSession()
  await expect.poll(() => qa.requests.length).toBe(1)
  expect(qa.requests[0]).toMatchObject({
    sessionID: activeSessionID,
    body: {
      delivery: "queue",
      agent: "build",
      prompt: { text: "queued while inactive later" },
    },
  })
  await page.waitForTimeout(250)
  expect(qa.requests).toHaveLength(1)
  expectNoSmokeErrors(errors, [], [])
})

for (const viewport of [{ name: "desktop", width: 1280, height: 720 }, { name: "mobile", width: 390, height: 844 }]) {
test(`keeps a paused followup through reload and stop until explicit resume on ${viewport.name}`, async ({ page }) => {
  await page.setViewportSize(viewport)
  const errors = trackPageErrors(page)
  const failedResponses: string[] = []
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })
  const qa = await setup(page, { activeBusy: true, queuedSessionID: activeSessionID, persistedPaused: true })
  await qa.openSession(activeSessionID)

  const resume = page.locator('[data-action="followup-resume"]').filter({ visible: true })
  await expect(resume).toBeVisible()
  await page.reload()
  await expect(resume).toBeVisible()
  await page.waitForTimeout(250)
  expect(qa.requests).toHaveLength(0)
  const stop = page.locator('[data-component="session-composer"] [data-action="prompt-submit"]').last()
  await expect(stop).toHaveAttribute("aria-label", /Stop|Stopp/)
  await stop.click()
  await expect.poll(() => qa.interrupts.length).toBe(1)
  await expect(stop).not.toHaveAttribute("aria-label", /Stop|Stopp/)
  await page.waitForTimeout(250)
  expect(qa.requests).toHaveLength(0)
  await expect(resume).toBeVisible()
  const pendingDraft = "pending draft must survive explicit queue resume"
  const input = page.locator('[data-component="session-composer"] [data-component="prompt-input"]').filter({ visible: true })
  await input.fill(pendingDraft)
  await expect(input).toHaveText(pendingDraft)
  await page.reload()
  await expect(resume).toBeVisible()
  await expect(input).toHaveText(pendingDraft)
  expect(qa.requests).toHaveLength(0)
  await resume.click()
  await expect.poll(() => qa.requests.length).toBe(1)
  expect(qa.requests[0]).toMatchObject({
    sessionID: activeSessionID,
    body: {
      delivery: "queue",
      prompt: { text: "queued while inactive later" },
    },
  })
  await page.waitForTimeout(500)
  expect(qa.requests).toHaveLength(1)
  expect(qa.interrupts).toEqual([activeSessionID])
  await expect(input).toHaveText(pendingDraft)
  expectNoSmokeErrors(errors, [], [])
  expect(failedResponses).toEqual([])
})
}

const directoryTabA = "C:/OpenCode/FollowupQueueTabA"
const directoryTabB = "C:/OpenCode/FollowupQueueTabB"
const projectTabA = "proj_followup_tab_a"
const projectTabB = "proj_followup_tab_b"
const sessionTabA = "ses_followup_tab_a"
const sessionTabB = "ses_followup_tab_b"
const tabServer = "http://127.0.0.1:4096"
const queuedTextB = "queued while another project is visible"

const tabProject = (id: string, worktree: string, name: string) => ({
  id,
  worktree,
  vcs: "git",
  name,
  time: { created: 1700000000000, updated: 1700000000000 },
  sandboxes: [],
})

const tabSession = (id: string, slug: string, projectID: string, directory: string, title: string) => ({
  id,
  slug,
  projectID,
  directory,
  title,
  version: "dev",
  time: { created: 1700000000000, updated: 1700000000000 },
})

// Regression for the followup queue activating only while the session tab is
// selected: project B's queued followup must release once its run settles even
// though project B's page unmounted when project A took over the visible tab.
test("releases a background project's queued followup while another project owns the active tab", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const errors = trackPageErrors(page)
  const failedResponses: string[] = []
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })

  const requests: Array<{ sessionID: string; body: Record<string, unknown> }> = []
  let settled = false

  await mockOpenCodeServer(page, {
    directory: directoryTabB,
    project: [
      tabProject(projectTabB, directoryTabB, "followup-queue-b"),
      tabProject(projectTabA, directoryTabA, "followup-queue-a"),
    ],
    provider,
    sessions: [
      tabSession(sessionTabB, "followup-tab-b", projectTabB, directoryTabB, "Background queued session"),
      tabSession(sessionTabA, "followup-tab-a", projectTabA, directoryTabA, "Foreground session"),
    ],
    pageMessages: () => ({ items: [] }),
    sessionStatus: { [sessionTabA]: { type: "idle" }, [sessionTabB]: { type: "busy" } },
    onSessionActivity: ({ sessionID }) => ({ data: { type: !settled && sessionID === sessionTabB ? "busy" : "idle" } }),
    eventRetry: 50,
    events: () => [
      {
        directory: directoryTabB,
        payload: settled
          ? {
              id: "evt_tab_b_completed",
              type: "session.next.activity.completed",
              properties: { sessionID: sessionTabB, activityID: "act_tab_b" },
            }
          : {
              id: "evt_tab_b_started",
              type: "session.next.activity.started",
              properties: { sessionID: sessionTabB, activityID: "act_tab_b" },
            },
      },
    ],
    onSessionPrompt: (input) => {
      requests.push({ sessionID: input.sessionID, body: input.body as Record<string, unknown> })
      return {}
    },
  })

  const dirBase64A = base64Encode(directoryTabA)
  const dirBase64B = base64Encode(directoryTabB)
  await page.addInitScript(
    (input) => {
      localStorage.clear()
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({ general: { followup: "queue", followupQueueMigrated: true } }),
      )
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: {
            local: [
              { worktree: input.directoryB, expanded: true },
              { worktree: input.directoryA, expanded: true },
            ],
          },
          lastProject: { local: input.directoryB },
        }),
      )
      localStorage.setItem(
        `${input.storageB}:workspace:followup`,
        JSON.stringify({
          items: {
            [input.sessionB]: [
              {
                id: "message_queued_tab_b",
                sessionID: input.sessionB,
                sessionDirectory: input.directoryB,
                prompt: [{ type: "text", content: input.queuedText, start: 0, end: input.queuedText.length }],
                context: [],
                agent: "build",
                model: { providerID: "opencode", modelID: "claude-opus-4-6" },
              },
            ],
          },
          failed: {},
          paused: {},
          edit: {},
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([
          { type: "session", server: input.server, dirBase64: input.dirBase64B, sessionId: input.sessionB },
          { type: "session", server: input.server, dirBase64: input.dirBase64A, sessionId: input.sessionA },
        ]),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs.recent",
        JSON.stringify({ key: `${input.server}\n${input.dirBase64B}\n${input.sessionB}` }),
      )
      const paneB = `tab:${input.paneKeyB}`
      const paneA = `tab:${input.paneKeyA}`
      localStorage.setItem(
        "opencode.global.dat:layout",
        JSON.stringify({ dock: {
          schema: 2,
          top: { visible: false, size: 160, tabs: [] },
          left: { visible: false, size: 280, tabs: [] },
          middle: { visible: true, size: 720, tabs: [paneB, paneA], active: paneB },
          right: { visible: false, size: 280, tabs: [] },
          bottom: { visible: false, size: 280, tabs: [] },
          items: {
            [paneB]: { area: "middle", visible: true },
            [paneA]: { area: "middle", visible: true },
          },
        } }),
      )
    },
    {
      server: tabServer,
      directoryA: directoryTabA,
      directoryB: directoryTabB,
      storageB: workspaceStorage(directoryTabB),
      dirBase64A,
      dirBase64B,
      sessionA: sessionTabA,
      sessionB: sessionTabB,
      paneKeyA: base64Encode(`${tabServer}\n${dirBase64A}\n${sessionTabA}`),
      paneKeyB: base64Encode(`${tabServer}\n${dirBase64B}\n${sessionTabB}`),
      queuedText: queuedTextB,
    },
  )

  // Boot on the background session so its followup store hydrates, then hand
  // the visible tab to the other project without ever re-selecting it.
  await page.goto("/")
  await expectAppVisible(page.locator('[data-component="session-composer"]'))
  await expect(page.getByText(queuedTextB)).toBeVisible()

  await page
    .locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${sessionTabA}"]`)
    .getByRole("tab")
    .click()
  await expect(page.locator('[data-component="session-composer"]')).toBeVisible()

  // The queued session is still running: nothing may send yet.
  await page.waitForTimeout(400)
  expect(requests).toHaveLength(0)

  // The background run settles while its tab stays unselected.
  settled = true
  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]).toMatchObject({
    sessionID: sessionTabB,
    body: { delivery: "queue", prompt: { text: queuedTextB } },
  })
  await page.waitForTimeout(400)
  expect(requests).toHaveLength(1)

  mkdirSync("test-results/followup-queue", { recursive: true })
  await page.screenshot({ path: "test-results/followup-queue/background-project-released.png", fullPage: true })
  expectNoSmokeErrors(errors, [], [])
  expect(failedResponses).toEqual([])
})
