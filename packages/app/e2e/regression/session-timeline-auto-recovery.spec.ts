import { expect, test, type Page, type Request } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { longFixture, pageMessagesFor } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible, expectSessionTitle } from "../utils/waits"

test.describe("regression: session timeline auto recovery", () => {
  test.setTimeout(300_000)

  test("recovers a >160-turn timeline automatically after the message route heals", async ({ page }) => {
    const consoleErrors: { text: string; at: number }[] = []
    const pageErrors: string[] = []
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push({ text: message.text(), at: Date.now() })
    })
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
    const messageRequests: { sessionID: string; limit: number; before?: string; phase: "start" | "end"; at: number }[] =
      []
    const outageRoutes = new Set<Request>()
    const injected: { url: string; status: number; at: number }[] = []
    const lateFailures: string[] = []
    const probeRequests: { url: string; directory: string | null; at: number }[] = []
    let outage = true
    const healedAt = { value: 0 }
    const outageBeganAt = Date.now()

    // Fixture-Länge ist der Beleg für >160: Timeline fenstert/virtualisiert,
    // DOM-count beweist keinen geladenen Verlauf.
    expect(longFixture.expected.targetMessageIDs.length).toBeGreaterThan(160)

    page.on("request", (request) => {
      const url = new URL(request.url())
      if (url.pathname === "/api/session/ses_smoke_target/message" && url.searchParams.get("limit") === "1") {
        const directory =
          url.searchParams.get("directory") ?? request.headers()["x-opencode-directory"] ?? null
        probeRequests.push({ url: request.url(), directory, at: Date.now() })
      }
    })
    page.on("requestfailed", (request) => {
      // Exakte Allowlist: nur tatsächlich injizierte Outage-Requests sind ok.
      if (outageRoutes.has(request)) return
      lateFailures.push(`requestfailed ${request.url()}`)
    })
    page.on("response", (response) => {
      const url = new URL(response.url())
      // Exakte Allowlist: nur status 503 UND tatsächlich injizierter Request.
      if (response.status() === 503 && outageRoutes.has(response.request())) {
        if (healedAt.value === 0) injected.push({ url: response.url(), status: response.status(), at: Date.now() })
        return
      }
      if (response.status() >= 400) lateFailures.push(`HTTP ${response.status()} ${response.url()}`)
    })

    await mockOpenCodeServer(page, {
      sessions: longFixture.sessions,
      provider: longFixture.provider,
      directory: longFixture.directory,
      project: longFixture.project,
      pageMessages: (sessionID, limit, before) => pageMessagesFor(longFixture.messages, sessionID, limit, before),
      onMessages: (input) => messageRequests.push({ ...input, at: Date.now() }),
    })
    // Route fällt mit 503 aus und wird nach 65s gesund: echter HTTP-Pfad mit
    // CORS-Headern, kein Mock-Throw. Die App muss ohne Klick/Tabwechsel/Reload recovern.
    await page.route("**/api/session/ses_smoke_target/message**", async (route) => {
      if (!outage) return route.fallback()
      outageRoutes.add(route.request())
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ error: "Simulated message route outage" }),
      })
    })
    await configureRecoveryPage(page, longFixture.directory, longFixture.sourceID, longFixture.targetID)

    await page.goto(`/${base64Encode(longFixture.directory)}/session/${longFixture.targetID}`)
    const tab = page.locator(`[data-dock-tab][data-session-id="${longFixture.targetID}"]`).getByRole("tab")
    await expectAppVisible(tab)
    await expectSessionTitle(page, longFixture.expected.targetTitle)

    // Cold open trifft die kaputte Route. Kein manueller Klick/Tabwechsel/Reload:
    // Route nach 65s heilen, Auto-Recovery muss selbst laden.
    await page.waitForTimeout(65_000)
    outage = false
    healedAt.value = Date.now()

    // Recovery ohne Reload: erfolgreiche HTTP-Seiten mit Cursor belegen Verlauf.
    await expect
      .poll(
        () =>
          messageRequests.filter((request) => request.sessionID === longFixture.targetID && request.phase === "end")
            .length,
        { timeout: 180_000 },
      )
      .toBeGreaterThan(0)
    expect(Date.now() - outageBeganAt).toBeGreaterThanOrEqual(60_000)
    const healedPages = messageRequests.filter(
      (request) => request.sessionID === longFixture.targetID && request.phase === "end",
    )
    expect(healedPages.length).toBeGreaterThan(0)
    expect(healedPages.every((request) => request.limit <= 200)).toBe(true)

    // Echte projDir/limit1-Probe: kein leerer every-Pass, Directory belegt.
    expect(probeRequests.length).toBeGreaterThan(0)
    expect(probeRequests.every((entry) => new URL(entry.url).searchParams.get("limit") === "1")).toBe(true)
    expect(probeRequests.some((entry) => entry.directory === longFixture.directory)).toBe(true)

    // Erst DANACH Historynavigation: neueste Seite ist nach Recovery
    // gemountet, älteren Boundary-Turn über Scrollen nachladen.
    await expect
      .poll(() => page.locator("[data-message-id]").count(), { timeout: 120_000 })
      .toBeGreaterThan(0)
    // Echte ältere HTTP-Seite mit before-Cursor belegen, kein DOM-Threshold.
    await scrollUpUntilBoundary(page, "msg_user_smoke_0120")
    const olderPage = messageRequests.find(
      (request) => request.sessionID === longFixture.targetID && !!request.before && request.phase === "end",
    )
    expect(olderPage?.before).toBeTruthy()
    // Ehrliche Abgrenzung: Boundary-Turn ist nach Scroll sichtbar; die
    // UserMessage-Row belegt den älteren Turn, unabhängige
    // Chronologie/Assistant-Boundary bleibt bei den 3 grünen bestehenden
    // Timeline-E2E (cold open, morning review, archived paging). Dieser Test
    // belegt AutoRecovery + before-Cursor + sichtbaren älteren Turn.
    const boundaryTurn = page.locator('[data-timeline-row="UserMessage"][data-message-id="msg_user_smoke_0120"]')
    await expect(boundaryTurn.first()).toBeVisible()
    await page.evaluate((messageID) => {
      window.location.hash = `message-${messageID}`
    }, "msg_user_smoke_0120")
    await expect(boundaryTurn).toBeVisible()

    // Genau die injizierten 503s sind erlaubt; alles nach Heilung bleibt rot.
    // 503-Ausnahme nur vor healedAt, ab healedAt keine Ausnahme, pageerrors immer rot.
    expect(injected.length).toBeGreaterThan(0)
    expect(lateFailures).toEqual([])
    const lateConsole = consoleErrors.filter(
      (entry) => entry.at >= healedAt.value || (!entry.text.includes("503") && !entry.text.includes("Service Unavailable")),
    )
    expect(lateConsole).toEqual([])
    expect(pageErrors).toEqual([])
    const toastCount = await page.locator('[data-component="toast"][data-variant="error"]').count()
    expect(toastCount).toBe(0)

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(boundaryTurn).toBeVisible()
  })
})

async function configureRecoveryPage(page: Page, directory: string, sourceID: string, targetID: string) {
  await page.addInitScript(
    ({ directory, dirBase64, sourceID, targetID }) => {
      const server = "http://127.0.0.1:4096"
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify(
          [sourceID, targetID].map((sessionId) => ({ type: "session", server, dirBase64, sessionId })),
        ),
      )
      localStorage.setItem("opencode.global.dat:tabs.recent", JSON.stringify({ key: `${server}\n${dirBase64}\n${targetID}` }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }),
      )
    },
    { directory, dirBase64: base64Encode(directory), sourceID, targetID },
  )
}

async function scrollUpUntilBoundary(page: Page, messageID: string) {
  const viewport = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  const row = page.locator(`[data-timeline-row="UserMessage"][data-message-id="${messageID}"]`)
  const box = await viewport.boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let attempt = 0; attempt < 400; attempt++) {
    // Bei AssistantPart unter derselben ID nicht stoppen: erst die sichtbare
    // UserMessage-Row im Scrollviewport beendet die Suche.
    if ((await row.count()) > 0 && (await row.first().isVisible())) {
      const visible = await row.first().evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const view = element.closest(".scroll-view__viewport")?.getBoundingClientRect()
        if (!view) return false
        return rect.bottom > view.top && rect.top < view.bottom
      })
      if (visible) return
    }
    await page.mouse.wheel(0, -240)
    await page.waitForTimeout(50)
  }
}
