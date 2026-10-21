import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors, expectNoSmokeErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/SessionMessageFork"
const projectID = "proj_session_message_fork"
const sessionID = "ses_session_message_fork"
const forkSessionID = "ses_session_message_fork_branch"
const previousMessageID = "msg_session_message_fork_previous"
const messageID = "msg_session_message_fork_user"
const previousText = "context that should stay in the fork timeline"
const promptText = "try a separate branch for this request"
const originalDraft = "keep the original composer draft"
const server = "http://127.0.0.1:4096"

test("user message fork opens a docked branch tab with the clicked prompt restored", async ({ page }) => {
  const errors = trackPageErrors(page)
  const sessions: ({ id: string } & Record<string, unknown>)[] = [session()]
  const forkRequests: Array<{ sessionID: string; body: Record<string, unknown> }> = []
  const config = {
    directory,
    project: project(),
    provider: provider(),
    sessions,
    pageMessages: (id: string) => ({ items: id === forkSessionID ? forkMessages() : id === sessionID ? sourceMessages() : [] }),
    onSessionFork: async (input: { sessionID: string; body: unknown }) => {
      await new Promise((resolve) => setTimeout(resolve, 150))
      forkRequests.push({ sessionID: input.sessionID, body: input.body as Record<string, unknown> })
      const next = forkSession()
      sessions.push(next)
      return next
    },
  }
  await mockOpenCodeServer(page, config)
  await configurePage(page)

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto("/")
  await expectAppVisible(page.getByText(promptText))
  const originalInput = page.getByRole("textbox", { name: /Ask anything/ })
  await originalInput.click()
  await page.keyboard.type(originalDraft)

  let popup: Page | undefined
  page.once("popup", (value) => {
    popup = value
  })
  const clickedMessage = page.locator(`#message-${messageID}`)
  await clickedMessage.getByText(promptText).hover()
  await clickedMessage.getByRole("button", { name: "Fork from message" }).click()

  await expect.poll(() => forkRequests).toEqual([{ sessionID, body: { messageID } }])
  await page.waitForTimeout(100)
  expect(popup).toBeUndefined()
  const middleDock = page.locator('[data-dock-area="middle"]')
  await expectAppVisible(middleDock.locator(`[data-dock-tab][data-session-id="${forkSessionID}"]`))
  await expectAppVisible(page.getByText(previousText))
  const input = middleDock.getByRole("textbox", { name: /Ask anything/ })
  await expectAppVisible(input)
  await expect(input).toContainText(promptText)
  await expect(input).toBeFocused()

  await expect(
    middleDock.locator(`[data-dock-tab][data-session-id="${forkSessionID}"]`).getByRole("tab"),
  ).toHaveAttribute("aria-selected", "true")
  await middleDock.locator(`[data-dock-tab][data-session-id="${sessionID}"]`).getByRole("tab").click()
  await expect(middleDock.locator(`[data-dock-tab][data-session-id="${sessionID}"]`).getByRole("tab")).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await expect(middleDock.getByRole("textbox", { name: /Ask anything/ })).toContainText(originalDraft)
  expectNoSmokeErrors(errors, [], [])
})

async function configurePage(page: Page) {
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

function sourceMessages() {
  return [message(previousMessageID, sessionID, previousText, 1700000000000), message(messageID, sessionID, promptText, 1700000000001)]
}

function forkMessages() {
  return [message("msg_session_message_fork_branch_previous", forkSessionID, previousText, 1700000000000)]
}

function message(id: string, targetSessionID: string, text: string, created: number) {
  return {
    info: { id, sessionID: targetSessionID, role: "user", time: { created } },
    parts: [{ id: `${id}:text`, sessionID: targetSessionID, messageID: id, type: "text", text }],
  }
}

function project() {
  return {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "session-message-fork",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  }
}

function provider() {
  return {
    all: [
      {
        id: "opencode",
        name: "OpenCode",
        models: {
          branch: { id: "branch", name: "Branch", limit: { context: 200_000 } },
        },
      },
    ],
    connected: ["opencode"],
    default: { providerID: "opencode", modelID: "branch" },
  }
}

function session() {
  return {
    id: sessionID,
    slug: sessionID,
    projectID,
    directory,
    title: "Message fork source",
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

function forkSession() {
  return {
    id: forkSessionID,
    slug: forkSessionID,
    projectID,
    directory,
    title: "Message fork branch",
    version: "dev",
    time: { created: 1700000000002, updated: 1700000000002 },
  }
}
