import { expect, test } from "@playwright/test"
import { readFile } from "node:fs/promises"

const pluginURL = new URL("../../../../.opencode/plugins/session-navigator-app/index.js", import.meta.url)

test("renders recent sessions above favorites only in the mobile dock layout", async ({ page }) => {
  const errors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("pageerror", (error) => errors.push(error.message))

  await page.setViewportSize({ width: 390, height: 844 })
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
          #navigator { width: min(100%, 390px); }
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
    const projects = {
      list: () => [],
      subscribe: (listener: (projects: unknown[]) => void) => {
        listener([])
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
            list: () => [
              {
                id: "favorite-session",
                title: "Favorite session",
                directory: "C:/OpenCode/MobileQA",
                time: { updated: 1 },
              },
            ],
            subscribe: () => () => {},
          },
          subscribe: () => () => {},
          working: () => false,
        },
      },
      client: {
        experimental: {
          session: {
            list: async () => ({
              data: [
                {
                  id: "recent-session",
                  title: "Recent session",
                  directory: "C:/OpenCode/MobileQA",
                  time: { updated: 2 },
                },
              ],
            }),
          },
        },
      },
    })
    registration!.mount({
      area: "mobile",
      element: document.querySelector("#navigator") as HTMLElement,
      signal: new AbortController().signal,
    })
  })

  const titles = page.locator(".oc-session-nav__group-title")
  await expect(titles).toHaveText(["Recent sessions", "Favorites"])
  await expect(page.getByText("Recent session", { exact: true })).toBeVisible()
  await expect(page.getByText("Favorite session", { exact: true })).toBeVisible()
  await page.screenshot({ path: "e2e/test-results/session-navigator-mobile-order.png", fullPage: true })

  await page.setViewportSize({ width: 900, height: 844 })
  await expect(titles).toHaveText(["Favorites", "Recent sessions"])
  expect(errors).toEqual([])
})
