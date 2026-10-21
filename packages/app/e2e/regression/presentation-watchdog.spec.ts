import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"
import { trackNetworkFailures, trackPageErrors, expectNoSmokeErrors } from "../utils/errors"

const directory = "C:/OpenCode/PaintWatchdogQA"
const projectID = "proj_paint_watchdog_qa"
const sessionID = "ses_paint_watchdog_qa"
const title = "Paint watchdog QA"

// The presentation watchdog mounts once at the app root for every route. On
// the web bundle there is no desktop bridge, so it must stay completely inert
// while the app renders normally: no surface, no reports, no console errors.
test.describe("regression: presentation watchdog", () => {
  for (const desktopBridge of [false, true])
    test(`preserves a draft with ${desktopBridge ? "a recovering desktop bridge at mobile width" : "the inert web watchdog"}`, async ({
      page,
    }, testInfo) => {
      const errors = trackPageErrors(page)
      const failures = trackNetworkFailures(page)
      const manifests: string[] = []
      page.on("response", (response) => {
        const url = new URL(response.url())
        if (url.pathname === "/app/plugins" && response.status() === 200)
          manifests.push(url.searchParams.get("directory") ?? "")
      })
      await mockOpenCodeServer(page, {
        directory,
        project: project(),
        provider: provider(),
        sessions: [session()],
        pageMessages: () => ({ items: [] }),
      })
      await page.addInitScript((bridge) => {
        localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale: "en" }))
        localStorage.setItem("settings.v3", JSON.stringify({}))
        if (!bridge) return
        const original = window.requestAnimationFrame.bind(window)
        const state = { stalled: false, reports: [] as { stallMs: number }[], queue: [] as FrameRequestCallback[] }
        Object.defineProperty(window, "__paintQA", { value: state })
        Object.defineProperty(window, "api", {
          value: { reportFrameStall: (report: { stallMs: number }) => state.reports.push(report) },
        })
        window.requestAnimationFrame = (callback) =>
          original((time) => {
            if (state.stalled) {
              state.queue.push(callback)
              return
            }
            callback(time)
          })
      }, desktopBridge)
      await page.setViewportSize(desktopBridge ? { width: 390, height: 844 } : { width: 1440, height: 900 })
      await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

      const composer = page.locator('[data-component="session-composer"]')
      const sessionRow = page.locator('[data-component="home-session-row"]').filter({ hasText: title }).first()
      await expectAppVisible(composer.or(sessionRow).first())
      if (!(await composer.isVisible())) await sessionRow.click()
      await expectAppVisible(composer)
      const draft = composer.locator('[contenteditable="true"]').first()
      await draft.fill("Keep this unsent draft while frames recover.")

      const probe = await page.evaluate(async () => {
        const api = (window as unknown as { api?: { reportFrameStall?: unknown } }).api
        const framesFlowing = await new Promise<boolean>((resolve) => {
          requestAnimationFrame(() => resolve(true))
        })
        return {
          watchdogNodes: document.querySelectorAll("[data-component='presentation-watchdog']").length,
          reportFrameStall: typeof api?.reportFrameStall,
          framesFlowing,
          visibility: document.visibilityState,
        }
      })
      expect(probe).toEqual({
        watchdogNodes: 0,
        reportFrameStall: desktopBridge ? "function" : "undefined",
        framesFlowing: true,
        visibility: "visible",
      })

      if (desktopBridge) {
        await page.evaluate(() => {
          ;(window as unknown as { __paintQA: { stalled: boolean } }).__paintQA.stalled = true
        })
        await expect
          .poll(
            () =>
              page.evaluate(() =>
                (window as unknown as { __paintQA: { reports: { stallMs: number }[] } }).__paintQA.reports.some(
                  (report) => report.stallMs > 0,
                ),
              ),
            { timeout: 16000 },
          )
          .toBe(true)
        await page.evaluate(() => {
          const state = (window as unknown as { __paintQA: { stalled: boolean; queue: FrameRequestCallback[] } })
            .__paintQA
          state.stalled = false
          state.queue.splice(0).forEach((callback) => requestAnimationFrame(callback))
        })
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (window as unknown as { __paintQA: { reports: { stallMs: number }[] } }).__paintQA.reports.at(-1)
                  ?.stallMs,
            ),
          )
          .toBe(0)
      }
      await expect(draft).toHaveText("Keep this unsent draft while frames recover.")
      await expect.poll(() => manifests.includes(directory)).toBe(true)

      expectNoSmokeErrors(errors, [], [])
      // Entering the restored directory cancels the unscoped manifest request.
      // Its directory-scoped replacement must have succeeded before accepting it.
      expect(
        failures.filter((failure) => failure !== "GET http://127.0.0.1:4096/app/plugins net::ERR_ABORTED"),
      ).toEqual([])
      await page.screenshot({ path: testInfo.outputPath("draft-preserved.png"), fullPage: true })
    })
})

function base64Encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function project() {
  return {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "paint-watchdog-qa",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  }
}

function session() {
  return {
    id: sessionID,
    slug: "paint-watchdog-qa",
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

function provider() {
  return {
    all: [
      {
        id: "openrouter",
        name: "OpenRouter",
        models: { "stealth/ox-alpha": { id: "stealth/ox-alpha", name: "Ox Alpha", limit: { context: 200_000 } } },
      },
    ],
    connected: ["openrouter"],
    default: { providerID: "openrouter", modelID: "stealth/ox-alpha" },
  }
}
