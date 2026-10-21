import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { fixture } from "../smoke/session-timeline.fixture"

test("opening Agents settings from home keeps SDK context", async ({ page }) => {
  const errors: string[] = []
  const networkFailures: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("requestfailed", (request) =>
    networkFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`),
  )
  page.on("response", (response) => {
    if (response.status() >= 400) networkFailures.push(`${response.status()} ${response.url()}`)
  })

  await mockOpenCodeServer(page, {
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages: () => ({ items: [] }),
    globalConfig: () => ({}),
  })
  await page.route("**/experimental/tool?*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  )

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto("/")
  await page.getByText("Settings").last().click()
  await page.getByRole("tab", { name: "Agents", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible()
  await page.screenshot({ path: "e2e/test-results/settings-agents-context-desktop.png", fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible()
  await page.screenshot({ path: "e2e/test-results/settings-agents-context-mobile.png", fullPage: true })

  expect(errors).toEqual([])
  expect(networkFailures).toEqual([])
})
