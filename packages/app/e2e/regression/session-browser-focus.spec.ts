import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/SessionBrowserFocus"
const projectID = "proj_session_browser_focus"
const sessionID = "ses_session_browser_focus"
const server = "http://127.0.0.1:4096"

test("a temporarily unavailable plugin pane does not activate the browser", async ({ page }) => {
  const errors = trackPageErrors(page)
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "session-browser-focus",
      time: { created: 1, updated: 1 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": {
              id: "claude-opus-4-6",
              name: "Claude Opus 4.6",
              limit: { context: 200_000 },
            },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID,
        directory,
        title: "Browser focus regression",
        version: "dev",
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await mockFocusPlugin(page)
  await page.addInitScript(
    ({ directory, dirBase64, sessionID, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server, dirBase64, sessionId: sessionID }]),
      )
      localStorage.setItem(
        "opencode.global.dat:layout",
        JSON.stringify({
          dock: {
            schema: 2,
            middle: {
              visible: true,
              size: 700,
              tabs: ["session", "focusProbe/workbench", "browser"],
              active: "focusProbe/workbench",
            },
            items: {
              session: { area: "middle", visible: true },
              "focusProbe/workbench": { area: "middle", visible: true },
              browser: { area: "middle", visible: true },
            },
          },
        }),
      )
    },
    { directory, dirBase64: base64Encode(directory), sessionID, server },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  const browser = page.locator('[data-dock-area="middle"] [data-dock-tab="browser"] [role="tab"]')
  const workbench = page.getByRole("tab", { name: "Git Workbench Probe" })
  await expectAppVisible(workbench)
  await workbench.click()
  await expect(workbench).toHaveAttribute("aria-selected", "true")
  await expect(browser).toHaveAttribute("aria-selected", "false")

  await page.evaluate(() => window.dispatchEvent(new Event("focus-probe-unregister")))

  await expect(workbench).toHaveCount(0)
  await expect(browser).toHaveAttribute("aria-selected", "false")
  await expect(page.locator('[data-component="session-browser-dock"]')).toBeHidden()
  expect(errors).toEqual([])
  await page.screenshot({ path: "e2e/test-results/session-browser-focus.png", fullPage: true })

  await browser.click()
  await expect(browser).toHaveAttribute("aria-selected", "true")
  await expect(page.locator('[data-component="session-browser-dock"]')).toBeVisible()
})

async function mockFocusPlugin(page: Page) {
  await page.route("**/app/plugins**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        plugins: [
          {
            id: "focusProbe",
            spec: "focus-probe",
            version: "1",
            module: "/app/plugin/focusProbe/1/app.js",
            hash: "focus",
          },
        ],
      }),
    }),
  )
  await page.route("**/app/plugin/focusProbe/1/app.js**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: `
        export default {
          id: "focusProbe",
          app(api) {
            const unregister = api.dock.register({
              id: "workbench",
              title: "Git Workbench Probe",
              defaultArea: "middle",
              allowedAreas: ["middle"],
              mount({ element, signal }) {
                element.innerHTML = '<section data-testid="focus-probe" style="padding:16px">Active workbench</section>'
                signal.addEventListener("abort", () => element.replaceChildren())
              },
            })
            window.addEventListener("focus-probe-unregister", unregister, { once: true })
          },
        }
      `,
    }),
  )
}
