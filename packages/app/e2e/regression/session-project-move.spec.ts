import { expect, test, type Locator } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const dirA = "C:/OpenCode/ProjectA"
const dirB = "C:/OpenCode/ProjectB"
const sessionID = "ses_project_move"
const server = "http://127.0.0.1:4096"

test("moves an idle empty session to another project from the composer picker without questions", async ({ page }) => {
  const sessions = [session(sessionID, "Project move session", dirA, "proj-a")]
  const draft = "Keep this composer draft after the project changes"
  const consoleErrors: string[] = []
  const failedResponses: string[] = []
  let moveBody: unknown

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => consoleErrors.push(error.stack ?? error.message))
  page.on("requestfailed", (request) => {
    if (request.failure()?.errorText === "net::ERR_ABORTED" && new URL(request.url()).pathname === "/vcs/diff") return
    failedResponses.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`)
  })
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })

  await mockOpenCodeServer(page, {
    directory: dirA,
    project: [project("proj-a", dirA, "Project A", "purple"), project("proj-b", dirB, "Project B", "green")],
    provider: provider(),
    sessions,
    sessionStatus: {},
    pageMessages: () => ({ items: [] }),
    onMoveSession: (body) => {
      moveBody = body
      sessions[0] = session(sessionID, "Project move session", dirB, "proj-b")
      return {
        sessionIDs: [sessionID],
        directory: dirB,
        projectID: "proj-b",
        subdirectory: "",
      }
    },
  })
  await configurePage(page)

  await page.setViewportSize({ width: 1280, height: 840 })
  await page.goto("/")

  await expectAppVisible(page.locator('[data-action="prompt-project"]'))
  const input = page.locator('[data-component="session-composer"] [data-component="prompt-input"]')
  await expectAppVisible(input)
  await input.fill(draft)
  await expect.poll(() => editorText(input)).toBe(draft)
  await page.locator('[data-action="prompt-project"]').click()
  await expectAppVisible(page.getByPlaceholder("Search projects"))
  await page.getByRole("button", { name: /Project B/ }).click()

  await expect.poll(() => moveBody).toEqual({
    sessionID,
    destination: { directory: dirB },
    moveChanges: false,
  })
  await expect(page.getByText("Change session project")).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/($|\\?)`))
  await expect(page.locator('[data-action="prompt-project"]')).toContainText("Project B")
  await expect.poll(() => editorText(input)).toBe(draft)
  await expect
    .poll(() =>
      page.evaluate(
        ({ dirBBase64, sessionID }) => {
          const tabs = JSON.parse(localStorage.getItem("opencode.global.dat:tabs") ?? "[]") as Array<{
            dirBase64?: string
            sessionId?: string
          }>
          return tabs.some((tab) => tab.sessionId === sessionID && tab.dirBase64 === dirBBase64)
        },
        { dirBBase64: base64Encode(dirB), sessionID },
      ),
    )
    .toBe(true)
  expect(consoleErrors).toEqual([])
  expect(failedResponses).toEqual([])

  const evidence = path.resolve(
    process.cwd(),
    "../../docs/workitems/screenshots/session-project-move/composer-project-moved.png",
  )
  await fs.mkdir(path.dirname(evidence), { recursive: true })
  await page.screenshot({ path: evidence, fullPage: true })
  if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
    await fs.mkdir(process.env.VISUAL_QA_SCREENSHOT_DIR, { recursive: true })
    await page.screenshot({ path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/project-move-empty-desktop.png`, fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await expectAppVisible(page.locator('[data-action="prompt-project"]'))
    await page.screenshot({ path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/project-move-empty-mobile.png`, fullPage: true })
  }
})

test("keeps project move questions for sessions with user messages", async ({ page }) => {
  const sessions = [session(sessionID, "Project move session", dirA, "proj-a")]
  let moveBody: unknown

  await mockOpenCodeServer(page, {
    directory: dirA,
    project: [project("proj-a", dirA, "Project A", "purple"), project("proj-b", dirB, "Project B", "green")],
    provider: provider(),
    sessions,
    sessionStatus: {},
    pageMessages: () => ({ items: [userMessage()] }),
    onMoveSession: (body) => {
      moveBody = body
      return {
        sessionIDs: [sessionID],
        directory: dirB,
        projectID: "proj-b",
        subdirectory: "",
      }
    },
  })
  await configurePage(page, { createdEmpty: false })

  await page.setViewportSize({ width: 1280, height: 840 })
  await page.goto("/")

  await expectAppVisible(page.locator('[data-action="prompt-project"]'))
  await page.locator('[data-action="prompt-project"]').click()
  await expectAppVisible(page.getByPlaceholder("Search projects"))
  await page.getByRole("button", { name: /Project B/ }).click()

  await expectAppVisible(page.getByText("Change session project"))
  expect(moveBody).toBeUndefined()
})

async function editorText(locator: Locator) {
  return locator.evaluate((element) => (element.textContent ?? "").replace(/\u200B/g, "").replace(/\u00A0/g, " "))
}

async function configurePage(page: Parameters<typeof mockOpenCodeServer>[0], settings?: { createdEmpty?: boolean }) {
  await page.addInitScript(
    ({ dirA, dirB, dirABase64, sessionID, server, settings }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: {
            local: [
              { worktree: dirA, expanded: true, name: "Project A", icon: { color: "purple" } },
              { worktree: dirB, expanded: true, name: "Project B", icon: { color: "green" } },
            ],
          },
          lastProject: { local: dirA },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([
          {
            type: "session",
            server,
            dirBase64: dirABase64,
            sessionId: sessionID,
            ...(settings?.createdEmpty === false ? {} : { createdEmpty: true }),
          },
        ]),
      )
    },
    { dirA, dirB, dirABase64: base64Encode(dirA), sessionID, server, settings },
  )
}

function userMessage() {
  const messageID = "msg_project_move_user"
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: 1_700_000_000_050 },
      summary: { diffs: [] },
      agent: "build",
      model: { providerID: "opencode", modelID: "claude-opus-4-6", variant: "max" },
    },
    parts: [{ id: "prt_project_move_user", sessionID, messageID, type: "text", text: "First message" }],
  }
}

function session(id: string, title: string, directory: string, projectID: string) {
  return {
    id,
    slug: title.toLowerCase().replaceAll(" ", "-"),
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_100 },
  }
}

function project(id: string, worktree: string, name: string, color: string) {
  return {
    id,
    worktree,
    vcs: "git",
    name,
    icon: { color },
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
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
          "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude", limit: { context: 200_000 } },
        },
      },
    ],
    connected: ["opencode"],
    default: { providerID: "opencode", modelID: "claude-opus-4-6" },
  }
}

function base64Encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}
