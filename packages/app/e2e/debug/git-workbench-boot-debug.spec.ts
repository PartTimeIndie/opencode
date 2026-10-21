import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/GitWorkbench"
const sessionID = "ses_git_workbench"

test("debug app boot state for git workbench", async ({ page }) => {
  const consoleMessages: string[] = []
  const pageErrors: string[] = []
  const failedRequests: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      consoleMessages.push(`${message.type()}: ${message.text().slice(0, 500)}`)
  })
  page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 800)))
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText}`))
  page.on("response", (response) => {
    if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`)
  })

  await page.addInitScript(
    ({ directory, dirBase64, sessionID }) => {
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true, name: "Git Workbench" }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem("opencode-color-scheme", "dark")
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server: "http://127.0.0.1:4096", dirBase64, sessionId: sessionID }]),
      )
    },
    { directory, dirBase64: btoa(directory), sessionID },
  )

  await mockOpenCodeServer(page, {
    directory,
    project: { id: "proj_git_workbench", worktree: directory, name: "Git Workbench" },
    provider: { id: "opencode" },
    sessions: [
      {
        id: sessionID,
        title: "QA",
        directory,
        projectID: "proj_git_workbench",
        time: { created: 1700000000000, updated: 1700000000000 },
        version: "dev",
      },
    ],
    pageMessages: () => ({ items: [] }),
  })

  await page.goto("/")
  await page.waitForTimeout(15_000)

  const probe = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")].map((button) => ({
      name: button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "",
      visible: !!button.getClientRects().length,
      disabled: button.disabled,
    }))
    return {
      bodyChildren: document.body.children.length,
      hasBanner: !!document.querySelector("header, [data-component='top-bar'], banner"),
      toggleButtons: buttons.filter((button) => /toggle/i.test(button.name)),
      dockAreas: [...document.querySelectorAll("[data-dock-area]")].map((area) => area.getAttribute("data-dock-area")),
      splash: !!document.querySelector('[data-component="session-route-loading"]'),
      errorDetails: [...document.querySelectorAll("textarea")].map((area) => area.value.slice(0, 900)),
      text: document.body.innerText.slice(0, 300),
    }
  })
  console.log("PROBE", JSON.stringify(probe, null, 2))
  console.log("PAGE_ERRORS", JSON.stringify(pageErrors, null, 2))
  console.log("CONSOLE", JSON.stringify(consoleMessages.slice(0, 20), null, 2))
  console.log("FAILED_REQUESTS", JSON.stringify(failedRequests.slice(0, 20), null, 2))
  await expect(probe.toggleButtons.length).toBeGreaterThan(0)
})
