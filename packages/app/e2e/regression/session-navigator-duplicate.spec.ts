import { expect, test } from "@playwright/test"
import { readFile } from "node:fs/promises"

const pluginURL = new URL("../../../../.opencode/plugins/session-navigator-app/index.js", import.meta.url)

test("navigator keeps one canonical row per host session id across all section projections", async ({ page }) => {
  const errors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("pageerror", (error) => errors.push(error.message))

  await page.setViewportSize({ width: 900, height: 844 })
  await page.route("http://session-navigator.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `
        <style>
          :root {
            --background-stronger: #111318;
            --background-base: #181b22;
            --text-base: #f5f7fa;
            --text-weak: #a8afbd;
            --border-weak-base: #363c48;
            --surface-hover-base: #252a34;
          }
          html, body, #navigator { height: 100%; margin: 0; }
          #navigator { width: min(100%, 900px); }
        </style>
        <div id="navigator"></div>
      `,
    }),
  )
  await page.goto("http://session-navigator.test/")
  await page.addScriptTag({
    content: (await readFile(pluginURL, "utf8"))
      .replace("export default {", "window.__sessionNavigator = {")
      .replaceAll("export ", ""),
  })
  await page.evaluate(() => {
    const plugin = (window as unknown as { __sessionNavigator: { app: (api: unknown) => void } }).__sessionNavigator
    let registration: {
      mount: (context: { area: string; element: HTMLElement; signal: AbortSignal }) => () => void
    }
    const project = { name: "Session Navigator", worktree: "C:/OpenCode/SessionNavigator" }
    const projects = {
      list: () => [project],
      subscribe: (listener: (projects: unknown[]) => void) => {
        listener([project])
        return () => {}
      },
      open: () => {},
    }
    plugin.app({
      dock: {
        state: { item: () => ({}) },
        register: (input: typeof registration) => {
          registration = input
        },
        open: { item: () => {} },
      },
      host: {
        projects,
        sessions: {
          favorites: {
            // The favorite repeats the shared host session id with its own
            // metadata; search must keep the durable row instead.
            list: () => [
              {
                id: "shared-session",
                title: "Favorite shared session",
                directory: "C:/OpenCode/SessionNavigator",
                time: { created: 1, updated: 99 },
              },
              {
                id: "favorite-only",
                title: "Favorite only session",
                directory: "C:/OpenCode/SessionNavigator",
                time: { created: 1, updated: 98 },
              },
            ],
            subscribe: () => () => {},
          },
          // One real session, projected by the host once with an aliased and
          // once with a missing directory, next to an unlisted active session.
          active: () => [
            { id: "shared-session", title: "Active shared session", directory: "c:/opencode/sessionnavigator/" },
            { id: "shared-session", title: "Active shared session" },
            { id: "unlisted-active", title: "Active session without durable row" },
          ],
          status: () => "running",
          subscribe: () => () => {},
          working: () => false,
        },
      },
      client: {
        experimental: {
          session: {
            list: async ({ directory }: { directory?: string }) => ({
              data: directory
                ? [
                    // The loaded project group repeats the shared host session
                    // id without a directory of its own.
                    { id: "shared-session", title: "Project shared session", time: { updated: 2 } },
                    { id: "project-only-session", title: "Project-only session", time: { updated: 1 } },
                  ]
                : [
                    {
                      id: "shared-session",
                      title: "Durable shared session",
                      directory: "C:/OpenCode/SessionNavigator",
                      time: { updated: 3 },
                    },
                    {
                      id: "global-only",
                      title: "Global only session",
                      directory: "C:/OpenCode/OtherProject",
                      time: { updated: 2 },
                    },
                  ],
            }),
          },
        },
      },
    })
    registration!.mount({
      area: "left",
      element: document.querySelector("#navigator") as HTMLElement,
      signal: new AbortController().signal,
    })
  })

  const recent = page.locator('[data-group-key="recent"]')
  // The durable row wins: canonical directory, durable title, project badge.
  await expect(recent.getByText("Durable shared session", { exact: true })).toBeVisible()
  await expect(
    recent.locator(
      '.oc-session-nav__session[data-session-id="shared-session"][data-directory="C:/OpenCode/SessionNavigator"]',
    ),
  ).toHaveCount(1)
  await expect(recent.locator('[data-session-id="shared-session"]')).toHaveCount(1)
  await expect(
    recent
      .locator('[data-session-id="shared-session"]')
      .locator(".oc-session-nav__session-main--project .oc-session-nav__avatar"),
  ).toHaveCount(1)
  // Unknown active sessions still join Recent exactly once.
  await expect(recent.locator('[data-session-id="unlisted-active"]')).toHaveCount(1)

  // A loaded project group keeps its own rows for the shared host session id.
  await page.locator(".oc-session-nav__project-toggle").click()
  const project = page.locator('[data-group-key^="project:"]')
  await expect(project.locator('[data-session-id="project-only-session"]')).toBeVisible()
  await expect(project.locator('[data-session-id="shared-session"]')).toHaveCount(1)

  // Search candidates dedupe by host session id with the durable row winning.
  await page.locator('input[placeholder="Search sessions"]').fill("session")
  const search = page.locator(".oc-session-nav__section").filter({ hasText: "Search" })
  await expect(
    search.locator('[data-session-id="shared-session"][data-directory="C:/OpenCode/SessionNavigator"]'),
  ).toHaveCount(1)
  await expect(search.locator('[data-session-id="shared-session"]')).toHaveCount(1)
  await expect(search.locator('[data-session-id="shared-session"] .oc-session-nav__session-title')).toHaveText(
    "Durable shared session",
  )
  await expect(search.locator('[data-session-id="unlisted-active"]')).toHaveCount(1)
  await expect(search.locator('[data-session-id="global-only"]')).toHaveCount(1)
  // Unknown favorites stay candidates; favorite metadata never wins over the
  // durable row and no project/active copy duplicates the shared session.
  await expect(search.locator('[data-session-id="favorite-only"]')).toHaveCount(1)
  await expect(search.getByText("Favorite shared session", { exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
})
