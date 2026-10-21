import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/ToolbarContext"
const puDirectory = "C:/GitRepros/PU"
const sessionID = "ses_toolbar_context"
const nextSessionID = "ses_toolbar_context_next"
const server = "http://127.0.0.1:4096"

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
})

test("mobile toolbar refreshes run and mount contexts across project, session, and layout changes", async ({ page }) => {
  const errors = trackPageErrors(page)
  const sessions = [
    session(sessionID, directory, "proj-toolbar-context", "Toolbar context"),
    session(nextSessionID, puDirectory, "proj-pu", "PU follow-up"),
  ]
  let moveBody: unknown

  await mockOpenCodeServer(page, {
    directory,
    project: [
      project("proj-toolbar-context", directory, "Toolbar Context", "purple"),
      project("proj-pu", puDirectory, "PU", "green"),
    ],
    provider: provider(),
    agents: [{ name: "build", mode: "primary" }],
    sessions,
    sessionStatus: {},
    pageMessages: () => ({ items: [] }),
    onMoveSession: (body) => {
      moveBody = body
      sessions[0] = session(sessionID, puDirectory, "proj-pu", "Toolbar context")
      return {
        sessionIDs: [sessionID],
        directory: puDirectory,
        projectID: "proj-pu",
        subdirectory: "",
      }
    },
  })
  await mockContextPlugin(page)
  await configurePage(page)
  await page.goto("/")

  await expectAppVisible(page.locator('[data-component="session-composer"]'))
  await expectMountContext(page, { directory, sessionID })
  await expectSingleMount(page)

  const beforeProject = await contextEvents(page)
  await page.locator('[data-action="prompt-project"]').tap()
  await page.locator('[data-component="composer-picker-item"][data-label="PU"]').tap()
  await expect.poll(() => moveBody).toEqual({
    sessionID,
    destination: { directory: puDirectory },
    moveChanges: false,
  })
  await expect(page.locator('[data-action="prompt-project"]')).toContainText("PU")
  await expectMountContext(page, { directory: puDirectory, sessionID })
  await expectSingleMount(page)
  await expectLifecycleTransition(page, beforeProject.length, {
    cleanup: { directory, sessionID },
    mount: { directory: puDirectory, sessionID },
  })
  await runMobileToolbarButton(page)
  await expectLastRunContext(page, { directory: puDirectory, sessionID })
  await expectEffectiveAlign(page)

  const beforeSession = await contextEvents(page)
  await desktopAction(page, {
    type: "session.open",
    directory: puDirectory,
    sessionID: nextSessionID,
  })
  await expectMountContext(page, { directory: puDirectory, sessionID: nextSessionID })
  await expectSingleMount(page)
  await expectLifecycleTransition(page, beforeSession.length, {
    cleanup: { directory: puDirectory, sessionID },
    mount: { directory: puDirectory, sessionID: nextSessionID },
  })
  await runMobileToolbarButton(page)
  await expectLastRunContext(page, { directory: puDirectory, sessionID: nextSessionID })

  const beforeDesktop = await contextEvents(page)
  await page.setViewportSize({ width: 1024, height: 700 })
  await expect(page.getByRole("button", { name: "More tools", exact: true })).toHaveCount(0)
  await expectAppVisible(page.getByRole("button", { name: "Context run", exact: true }))
  await expectMountContext(page, { directory: puDirectory, sessionID: nextSessionID })
  await expectLifecycleTransition(page, beforeDesktop.length, {
    cleanup: { directory: puDirectory, sessionID: nextSessionID },
    mount: { directory: puDirectory, sessionID: nextSessionID },
  })
  await expectSingleMount(page)
  await page.getByRole("button", { name: "Context run", exact: true }).click()
  await expectLastRunContext(page, { directory: puDirectory, sessionID: nextSessionID })

  const beforeMobile = await contextEvents(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await expectAppVisible(page.getByRole("button", { name: "More tools", exact: true }))
  await expectMountContext(page, { directory: puDirectory, sessionID: nextSessionID })
  await expectLifecycleTransition(page, beforeMobile.length, {
    cleanup: { directory: puDirectory, sessionID: nextSessionID },
    mount: { directory: puDirectory, sessionID: nextSessionID },
  })
  await expectSingleMount(page)

  expectNoSmokeErrors(errors, [], [])
})

type ContextSnapshot = {
  directory: string
  sessionID: string
}

type ContextEvent = ContextSnapshot & {
  type: "cleanup" | "mount" | "run"
  align: string
}

async function expectMountContext(page: Page, context: ContextSnapshot) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const element = document.querySelector<HTMLElement>("[data-context-probe-mount]")
        if (!element) return
        return {
          directory: element.dataset.contextProbeDirectory,
          sessionID: element.dataset.contextProbeSession,
        }
      }),
    )
    .toEqual(context)
}

async function expectSingleMount(page: Page) {
  await expect(page.locator("[data-context-probe-mount]")).toHaveCount(1)
}

async function expectLifecycleTransition(
  page: Page,
  offset: number,
  expected: { cleanup: ContextSnapshot; mount: ContextSnapshot },
) {
  await expect
    .poll(async () => {
      const events = (await contextEvents(page)).slice(offset)
      return {
        cleanup: events.some((event) => event.type === "cleanup" && sameContext(event, expected.cleanup)),
        mount: events.some((event) => event.type === "mount" && sameContext(event, expected.mount)),
      }
    })
    .toEqual({ cleanup: true, mount: true })
}

async function runMobileToolbarButton(page: Page) {
  const more = page.getByRole("button", { name: "More tools", exact: true })
  if ((await more.getAttribute("aria-expanded")) !== "true") await more.tap()
  const run = page.getByRole("button", { name: "Context run", exact: true })
  await expectAppVisible(run)
  await run.tap()
}

async function expectLastRunContext(page: Page, context: ContextSnapshot) {
  await expect
    .poll(async () => {
      const event = (await contextEvents(page)).findLast((item) => item.type === "run")
      if (!event) return
      return { type: event.type, directory: event.directory, sessionID: event.sessionID }
    })
    .toEqual({ type: "run", ...context })
}

async function expectEffectiveAlign(page: Page) {
  await expect
    .poll(async () => {
      const events = await contextEvents(page)
      return {
        mount: events.findLast((event) => event.type === "mount")?.align,
        run: events.findLast((event) => event.type === "run")?.align,
      }
    })
    .toEqual({ mount: "left", run: "left" })
}

async function contextEvents(page: Page) {
  return page.evaluate(
    () =>
      JSON.parse(document.documentElement.dataset.contextProbeEvents ?? "[]") as Array<{
        type: "cleanup" | "mount" | "run"
        directory: string
        sessionID: string
        align: string
      }>,
  )
}

function sameContext(event: ContextEvent, context: ContextSnapshot) {
  return event.directory === context.directory && event.sessionID === context.sessionID
}

async function desktopAction(
  page: Page,
  action: { type: "session.open"; sessionID: string; directory: string },
) {
  await page.evaluate(async (input) => {
    const bridge = (
      window as Window & {
        __OPENCODE__?: {
          desktopTesting?: {
            action(value: typeof input): Promise<unknown>
          }
        }
      }
    ).__OPENCODE__?.desktopTesting
    if (!bridge) throw new Error("Desktop testing bridge is unavailable")
    await bridge.action(input)
  }, action)
}

async function mockContextPlugin(page: Page) {
  await page.route("**/app/plugins**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        plugins: [
          {
            id: "contextProbe",
            spec: "context-probe",
            version: "1",
            module: "/app/plugin/contextProbe/1/app.js",
            hash: "context-probe",
          },
        ],
      }),
    }),
  )
  await page.route("**/app/plugin/contextProbe/1/app.js**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: `
        const snapshot = (context) => ({
          directory: context.directory ?? "",
          sessionID: context.sessionID ?? "",
          align: context.align ?? "",
        })
        const record = (type, context) => {
          const events = JSON.parse(document.documentElement.dataset.contextProbeEvents ?? "[]")
          events.push({ type, ...snapshot(context) })
          document.documentElement.dataset.contextProbeEvents = JSON.stringify(events)
        }

        export default {
          id: "contextProbe",
          app(api) {
            api.toolbar.register({
              id: "contextRun",
              title: "Context run",
              placement: "composer",
              order: 1,
              run(context) {
                record("run", context)
              },
            })
            api.toolbar.register({
              id: "contextMount",
              title: "Context mount",
              placement: "composer",
              kind: "mount",
              order: 2,
              mount({ element, signal, context }) {
                record("mount", context)
                const button = document.createElement("button")
                button.type = "button"
                button.setAttribute("aria-label", "Context mount")
                button.dataset.contextProbeMount = ""
                button.dataset.contextProbeDirectory = context.directory ?? ""
                button.dataset.contextProbeSession = context.sessionID ?? ""
                button.textContent = "Context mount"
                element.append(button)
                signal.addEventListener(
                  "abort",
                  () => {
                    record("cleanup", context)
                    element.replaceChildren()
                  },
                  { once: true },
                )
              },
            })
          },
        }
      `,
    }),
  )
}

async function configurePage(page: Page) {
  await page.addInitScript(
    ({ directory, encoded, server }) => {
      localStorage.clear()
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: {
            local: [
              { worktree: directory, expanded: true, name: "Toolbar Context", icon: { color: "purple" } },
              { worktree: "C:/GitRepros/PU", expanded: true, name: "PU", icon: { color: "green" } },
            ],
          },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([
          {
            type: "session",
            server,
            dirBase64: encoded,
            sessionId: "ses_toolbar_context",
            createdEmpty: true,
          },
        ]),
      )
      localStorage.setItem(
        "opencode.global.dat:plugin-toolbar-visibility",
        JSON.stringify({
          version: 1,
          global: {
            "contextProbe/contextRun": true,
            "contextProbe/contextMount": true,
          },
          projects: {},
        }),
      )
    },
    { directory, encoded: base64Encode(directory), server },
  )
}

function session(id: string, worktree: string, projectID: string, title: string) {
  return {
    id,
    slug: id,
    projectID,
    directory: worktree,
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
        id: "openai",
        name: "OpenAI",
        models: {
          "context-model": {
            id: "context-model",
            name: "Context Model",
            limit: { context: 200_000 },
          },
        },
      },
    ],
    connected: ["openai"],
    default: { providerID: "openai", modelID: "context-model" },
  }
}
