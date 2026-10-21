import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackNetworkFailures, trackPageErrors } from "../utils/errors"
import { expectSessionTitle } from "../utils/waits"

test.use({ video: "on", screenshot: "on" })

const directory = "C:/OpenCode/SurfaceInvariants"
const projectID = "proj_surface_invariants"
const sessionID = "ses_surface_invariants"
const userMessageID = "msg_surface_user"
const assistantMessageID = "msg_surface_assistant"
const title = "Surface invariants"
const model = { providerID: "opencode", modelID: "claude-opus-4-6" }

test.describe("visual qa: surface invariants", () => {
  test("typed error card stays above composer on desktop and mobile", async ({ page }) => {
    const errors = trackPageErrors(page)
    const network = trackNetworkFailures(page)
    await mockOpenCodeServer(page, {
      directory,
      project: {
        id: projectID,
        worktree: directory,
        vcs: "git",
        name: "surface-invariants",
        time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
        sandboxes: [],
      },
      provider: {
        all: [
          {
            id: model.providerID,
            name: "OpenCode",
            models: { [model.modelID]: { id: model.modelID, name: "Claude Opus 4.6", limit: { context: 200_000 } } },
          },
        ],
        default: { providerID: model.providerID, modelID: model.modelID },
        connected: [model.providerID],
      },
      sessions: [
        {
          id: sessionID,
          slug: sessionID,
          projectID,
          directory,
          title,
          version: "dev",
          time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
        },
      ],
      pageMessages: () => ({ items: messages() }),
    })

    await page.addInitScript(
      ({ directory, dirBase64, sessionID }) => {
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
          JSON.stringify([{ type: "session", server: "http://127.0.0.1:4096", dirBase64, sessionId: sessionID }]),
        )
      },
      { directory, dirBase64: base64Encode(directory), sessionID },
    )

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    const tab = page.locator(`[data-dock-tab][data-session-id="${sessionID}"]`).getByRole("tab")
    await expect(tab).toBeVisible({ timeout: 30_000 })
    await tab.click()
    await expectSessionTitle(page, title)

    const card = page.locator(".error-card")
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute("data-failure-code", "provider.transport")
    await expect(card).toHaveAttribute("data-surface-kind", "error-card")
    await expect(card.locator("xpath=..")).toHaveAttribute("data-surface-region", "timeline")
    await expect(card).toContainText("[provider.transport]")
    await expect(card).toContainText("→ Retry")
    await expect(page.locator('[data-component="session-dock-shell"]')).toHaveAttribute("data-surface-region", "docks")

    const composer = page.locator('[data-component="prompt-input"], [data-slot="composer"], textarea').first()
    await expect(composer).toBeVisible()
    const cardBox = await card.boundingBox()
    const composerBox = await composer.boundingBox()
    expect(cardBox).toBeTruthy()
    expect(composerBox).toBeTruthy()
    if (cardBox && composerBox) {
      const overlap =
        cardBox.x < composerBox.x + composerBox.width &&
        cardBox.x + cardBox.width > composerBox.x &&
        cardBox.y < composerBox.y + composerBox.height &&
        cardBox.y + cardBox.height > composerBox.y
      expect(overlap).toBe(false)
    }
    await page.screenshot({ path: test.info().outputPath("surface-invariants-desktop.png"), fullPage: true })

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute("data-failure-code", "provider.transport")
    const mobileCard = await card.boundingBox()
    const mobileComposer = await composer.boundingBox()
    if (mobileCard && mobileComposer) {
      const overlap =
        mobileCard.x < mobileComposer.x + mobileComposer.width &&
        mobileCard.x + mobileCard.width > mobileComposer.x &&
        mobileCard.y < mobileComposer.y + mobileComposer.height &&
        mobileCard.y + mobileCard.height > mobileComposer.y
      expect(overlap).toBe(false)
    }
    await page.screenshot({ path: test.info().outputPath("surface-invariants-mobile.png"), fullPage: true })

    const unexpectedNetwork = network.filter((item) => !item.includes("/event") && !item.includes("favicon"))
    expect(unexpectedNetwork).toEqual([])
    expectNoSmokeErrors(errors, [], [])
  })
})

function messages() {
  return [
    {
      info: {
        id: userMessageID,
        sessionID,
        role: "user",
        time: { created: 1_700_000_000_000 },
        summary: { diffs: [] },
        agent: "build",
        model,
      },
      parts: [{ id: "prt_surface_user", sessionID, messageID: userMessageID, type: "text", text: "Retry this turn." }],
    },
    {
      info: {
        id: assistantMessageID,
        sessionID,
        role: "assistant",
        time: { created: 1_700_000_001_000, completed: 1_700_000_001_500 },
        parentID: userMessageID,
        modelID: model.modelID,
        providerID: model.providerID,
        mode: "build",
        agent: "build",
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        error: {
          name: "UnknownError",
          data: {
            message: "The provider stream or request failed before completion.",
            code: "provider.transport",
            remediation: "retry",
          },
        },
      },
      parts: [],
    },
  ]
}
