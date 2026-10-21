import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

test.use({ video: "on", screenshot: "on" })

const directory = "C:/OpenCode/ComposerResume"
const projectID = "proj_composer_resume"
const sessionID = "ses_composer_resume"
const server = "http://127.0.0.1:4096"

function session(id: string, title: string) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  }
}

let eventSequence = 0

function event(type: string, properties: Record<string, unknown>) {
  return {
    directory,
    payload: {
      id: `evt_${type.replaceAll(".", "_")}_${eventSequence++}`,
      type,
      properties: { sessionID, timestamp: Date.now(), ...properties },
    },
  }
}

function syncEvent(type: string, seq: number, data: Record<string, unknown>) {
  return {
    directory,
    payload: {
      type: "sync",
      syncEvent: {
        id: `evt_${type.replaceAll(".", "_")}_${seq}`,
        type: `${type}.1`,
        seq,
        aggregateID: sessionID,
        data: { sessionID, timestamp: Date.now(), ...data },
      },
    },
  }
}

async function setup(page: Page, events: () => unknown[]) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "Composer resume",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      sandboxes: [],
    },
    provider: {
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
    },
    agents: [{ name: "build", mode: "primary" }],
    sessions: [session(sessionID, "Composer resume regression")],
    pageMessages: () => ({ items: [] }),
    eventRetry: 25,
    events,
  })
  await page.addInitScript(
    ({ directory, dirBase64, server, sessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server, dirBase64, sessionId: sessionID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), server, sessionID },
  )
}

async function openSession(page: Page) {
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-component="session-composer"]')
  await expectAppVisible(composer)
  return composer
}

test("an empty idle composer submit button restarts the last agent run", async ({ page }) => {
  const errors = trackPageErrors(page)
  const prompts: Array<{ sessionID: string; body: Record<string, unknown> }> = []
  // Events emitted only after a prompt admission settles the optimistic busy state.
  const events: unknown[] = []
  let activitySeq = 0

  await setup(page, () => events.splice(0, 1))
  await page.route(/\/api\/session\/[^/]+\/prompt(?:\?|$)/, async (route) => {
    const matched = route.request().url().split("/api/session/")[1].split("/")[0]
    prompts.push({ sessionID: matched, body: JSON.parse(route.request().postData() ?? "{}") })
    events.push(
      event("session.next.activity.started", { activityID: `activity_resume_${activitySeq}`, kind: "prompt" }),
      syncEvent("session.next.activity.started", activitySeq * 2 + 1, {
        activityID: `activity_resume_${activitySeq}`,
        kind: "prompt",
      }),
      event("session.next.activity.completed", { activityID: `activity_resume_${activitySeq}` }),
      syncEvent("session.next.activity.completed", activitySeq * 2 + 2, {
        activityID: `activity_resume_${activitySeq}`,
      }),
    )
    activitySeq += 1
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        data: { sessionID: matched, messageID: `msg_prompt_${prompts.length}`, admittedSeq: prompts.length },
      }),
    })
  })

  const composer = await openSession(page)
  const input = composer.locator('[data-component="prompt-input"]')
  const submit = composer.locator('[data-action="prompt-submit"]')

  // A brand-new empty session has no previous run to restart.
  await expect(submit).toBeDisabled()

  await input.fill("Run the agent once")
  await input.press("Enter")
  await expect.poll(() => prompts.length).toBe(1)
  expect(prompts[0]?.body?.prompt).toMatchObject({ text: "Run the agent once" })

  // Wait for the authoritative idle event so the composer is truly idle and empty.
  await expect(submit).toHaveAttribute("aria-label", /^Send|Senden$/)

  // The send button must now be enabled and clicking it sends a short continuation.
  await expect(submit).toBeEnabled()
  await submit.click()
  await expect.poll(() => prompts.length).toBe(2)
  expect(prompts[1]?.body?.prompt).toMatchObject({ text: "Continue" })
  expectNoSmokeErrors(errors, [], [])
})

test("rapid double-click on resume admits the last run exactly once", async ({ page }) => {
  const errors = trackPageErrors(page)
  const prompts: Array<{ sessionID: string; body: Record<string, unknown> }> = []
  const events: unknown[] = []
  let activitySeq = 0

  await setup(page, () => events.splice(0, 1))
  await page.route(/\/api\/session\/[^/]+\/prompt(?:\?|$)/, async (route) => {
    const matched = route.request().url().split("/api/session/")[1].split("/")[0]
    prompts.push({ sessionID: matched, body: JSON.parse(route.request().postData() ?? "{}") })
    events.push(
      event("session.next.activity.started", { activityID: `activity_resume_${activitySeq}`, kind: "prompt" }),
      syncEvent("session.next.activity.started", activitySeq * 2 + 1, {
        activityID: `activity_resume_${activitySeq}`,
        kind: "prompt",
      }),
      event("session.next.activity.completed", { activityID: `activity_resume_${activitySeq}` }),
      syncEvent("session.next.activity.completed", activitySeq * 2 + 2, {
        activityID: `activity_resume_${activitySeq}`,
      }),
    )
    activitySeq += 1
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        data: { sessionID: matched, messageID: `msg_prompt_${prompts.length}`, admittedSeq: prompts.length },
      }),
    })
  })

  const composer = await openSession(page)
  const input = composer.locator('[data-component="prompt-input"]')
  const submit = composer.locator('[data-action="prompt-submit"]')

  await input.fill("Run the agent once")
  await input.press("Enter")
  await expect.poll(() => prompts.length).toBe(1)
  await expect(submit).toHaveAttribute("aria-label", /^Send|Senden$/)
  await expect(submit).toBeEnabled()

  // Two rapid clicks before any authoritative busy state arrives must admit exactly
  // one resumed prompt; submitPending guards the second dispatch.
  await submit.dblclick()
  await page.waitForTimeout(500)
  await expect.poll(() => prompts.length).toBe(2)
  expect(prompts[1]?.body?.prompt).toMatchObject({ text: "Continue" })
  expectNoSmokeErrors(errors, [], [])
})
