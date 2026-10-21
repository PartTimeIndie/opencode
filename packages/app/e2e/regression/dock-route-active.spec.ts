import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"
import { trackPageErrors, expectNoSmokeErrors } from "../utils/errors"

const directory = "C:/OpenCode/DockRouteActiveQA"
const projectID = "proj_dock_route_active_qa"
const sessionID = "ses_dock_route_active_qa"
const secondSessionID = "ses_dock_route_active_qa_second"
const thirdSessionID = "ses_dock_route_active_qa_third"
const title = "Dock route active QA"
const secondTitle = "Dock route active QA follow-up"
const thirdTitle = "Dock route active QA deep link"

test.describe("dock route activation", () => {
  test("activates the routed session pane when dock active is stale", async ({ page }) => {
    const errors = trackPageErrors(page)
    await mockOpenCodeServer(page, {
      directory,
      project: project(),
      provider: provider(),
    sessions: [session(), secondSession(), thirdSession()],
      pageMessages: (id) => ({ items: messages(id) }),
    })
    await configurePage(page)

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto("/")

    await expect(dockSessionTab(page, secondTitle)).toHaveAttribute("aria-selected", "true")
    await expectAppVisible(page.getByText("Second routed session content."))

    await dockSessionTab(page, title).click()
    await expect(dockSessionTab(page, title)).toHaveAttribute("aria-selected", "true")
    await expectAppVisible(page.getByText("First routed session content."))

    await dockSessionTab(page, secondTitle).click()
    await expect(dockSessionTab(page, secondTitle)).toHaveAttribute("aria-selected", "true")
    await expectAppVisible(page.getByText("Second routed session content."))

    await page.reload()
    await expect(dockSessionTab(page, secondTitle)).toHaveAttribute("aria-selected", "true")
    await expectAppVisible(page.getByText("Second routed session content."))

    await page.goto(`/?dir=${base64Encode(directory)}&session=${thirdSessionID}`)
    await expect(dockSessionTab(page, thirdTitle)).toHaveAttribute("aria-selected", "true")
    await expectAppVisible(page.getByText("Deep-linked session content."))
    await expect
      .poll(() =>
        page.evaluate((sessionID) => {
          const tabs = JSON.parse(localStorage.getItem("opencode.global.dat:tabs") ?? "[]") as Array<{ sessionId?: string }>
          return tabs.some((tab) => tab.sessionId === sessionID)
        }, thirdSessionID),
      )
      .toBe(true)
    await expect
      .poll(() =>
        page.evaluate((sessionID) => {
          const recent = JSON.parse(localStorage.getItem("opencode.global.dat:tabs.recent") ?? "{}") as { key?: string }
          return recent.key?.endsWith(`\n${sessionID}`) === true
        }, thirdSessionID),
      )
      .toBe(true)

    await page.reload()
    await expect(dockSessionTab(page, title)).toBeVisible()
    await expect(dockSessionTab(page, secondTitle)).toBeVisible()
    await expect(dockSessionTab(page, thirdTitle)).toHaveAttribute("aria-selected", "true")
    await expectAppVisible(page.getByText("Deep-linked session content."))

    expectNoSmokeErrors(errors, [], [])
  })

  test("keeps an older deep-linked session while the recent list finishes loading", async ({ page }) => {
    const errors = trackPageErrors(page)
    const recent = Array.from({ length: 12 }, (_, index) =>
      sessionWithID(`ses_dock_route_recent_${String(index).padStart(2, "0")}`, `Recent session ${index}`, 1_800_000_000_000 + index),
    )
    await mockOpenCodeServer(page, {
      directory,
      project: project(),
      provider: provider(),
      sessions: [session(), secondSession(), thirdSession(), ...recent],
      sessionList: recent,
      pageMessages: (id) => ({ items: messages(id) }),
    })
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url())
      if (
        route.request().method() === "GET" &&
        (url.pathname === "/session" || url.pathname === "/api/session") &&
        url.searchParams.get("roots") === "true"
      ) {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      await route.fallback()
    })
    await configurePage(page)
    await page.setViewportSize({ width: 390, height: 844 })

    await page.goto(`/${base64Encode(directory)}/session/${thirdSessionID}`)

    await expect(page.getByRole("heading", { name: thirdTitle })).toBeVisible()
    await expectAppVisible(page.getByText("Deep-linked session content."))
    await page.waitForTimeout(750)
    await expect(page.getByRole("heading", { name: thirdTitle })).toBeVisible()
    await expectAppVisible(page.getByText("Deep-linked session content."))
    expectNoSmokeErrors(errors, [], [])
  })
})

async function configurePage(page: Page) {
  await page.addInitScript(
    ({ directory, dirBase64, sessionID, secondSessionID, server, firstPaneID, secondPaneID }) => {
      if (sessionStorage.getItem("opencode.dock-route-active.seeded")) return
      sessionStorage.setItem("opencode.dock-route-active.seeded", "true")
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([
          {
            type: "session",
            server: "http://127.0.0.1:4096",
            dirBase64,
            sessionId: sessionID,
          },
          {
            type: "session",
            server: "http://127.0.0.1:4096",
            dirBase64,
            sessionId: secondSessionID,
          },
        ]),
      )
      const tabKey = (id: string) => `${server}\n${dirBase64}\n${id}`
      localStorage.setItem("opencode.global.dat:tabs.recent", JSON.stringify({ key: tabKey(secondSessionID) }))
      localStorage.setItem(
        "opencode.global.dat:layout",
        JSON.stringify({
          dock: {
            schema: 2,
            top: { visible: false, size: 160, tabs: [] },
            left: { visible: false, size: 280, tabs: [] },
            middle: {
              visible: true,
              size: 720,
              tabs: [firstPaneID, secondPaneID],
              active: firstPaneID,
            },
            right: { visible: false, size: 280, tabs: ["review", "fileTree", "gitChanges"], active: "review" },
            bottom: { visible: false, size: 280, tabs: ["terminal"], active: "terminal" },
            items: {
              session: { area: "middle", visible: true },
              terminal: { area: "bottom", visible: false },
              review: { area: "right", visible: true },
              fileTree: { area: "right", visible: false },
              gitChanges: { area: "right", visible: false },
              [firstPaneID]: { area: "middle", visible: true },
              [secondPaneID]: { area: "middle", visible: true },
            },
          },
        }),
      )
    },
    {
      directory,
      dirBase64: base64Encode(directory),
      sessionID,
      secondSessionID,
      server: "http://127.0.0.1:4096",
      firstPaneID: dockPaneID(sessionID),
      secondPaneID: dockPaneID(secondSessionID),
    },
  )
}

function dockPaneID(id: string) {
  return `tab:${base64Encode(`http://127.0.0.1:4096\n${base64Encode(directory)}\n${id}`)}`
}

function dockSessionTab(page: Page, name: string) {
  return page.locator('[data-dock-area="middle"]').getByRole("tab", { name }).first()
}

function messages(targetSessionID: string) {
  const second = targetSessionID === secondSessionID
  const third = targetSessionID === thirdSessionID
  const userID = second
    ? "msg_user_dock_route_active_second"
    : third
      ? "msg_user_dock_route_active_third"
      : "msg_user_dock_route_active"
  return [
    {
      info: {
        id: userID,
        sessionID: targetSessionID,
        role: "user",
        time: { created: 1700000000000 },
        summary: { diffs: [] },
        agent: "build",
        model: { providerID: "opencode", modelID: "claude-opus-4-6", variant: "max" },
      },
      parts: [
        {
          id: second ? "prt_user_dock_route_active_second" : third ? "prt_user_dock_route_active_third" : "prt_user_dock_route_active",
          sessionID: targetSessionID,
          messageID: userID,
          type: "text",
          text: second ? "Second routed session content." : third ? "Deep-linked session content." : "First routed session content.",
        },
      ],
    },
  ]
}

function project() {
  return {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "dock-route-active-qa",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  }
}

function session() {
  return {
    id: sessionID,
    slug: "dock-route-active-qa",
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

function secondSession() {
  return {
    id: secondSessionID,
    slug: "dock-route-active-qa-follow-up",
    projectID,
    directory,
    title: secondTitle,
    version: "dev",
    time: { created: 1700000001000, updated: 1700000001000 },
  }
}

function thirdSession() {
  return {
    id: thirdSessionID,
    slug: "dock-route-active-qa-deep-link",
    projectID,
    directory,
    title: thirdTitle,
    version: "dev",
    time: { created: 1700000002000, updated: 1700000002000 },
  }
}

function sessionWithID(id: string, title: string, updated: number) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: updated, updated },
  }
}

function provider() {
  return {
    all: [
      {
        id: "opencode",
        name: "OpenCode",
        models: { "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } } },
      },
    ],
    connected: ["opencode"],
    default: { providerID: "opencode", modelID: "claude-opus-4-6" },
  }
}

function base64Encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}
