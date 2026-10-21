import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackNetworkFailures, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/SafetyReviewPersistence"
const projectID = "proj_safety_review_persistence"
const sessionID = "ses_safety_review_persistence"
const secondSessionID = "ses_safety_review_persistence_second"
const server = "http://127.0.0.1:4096"
type GlobalAccessControl = {
  mode?: "ask" | "approve_for_me" | "full_access"
  safety_review?: {
    model?: string
    fallback?: { model?: string }
    prompt?: string
    chain?: Array<{ providerID: string; modelID: string; variant?: string }>
  }
}

const provider = {
  all: [
    {
      id: "opencode",
      name: "OpenCode",
      models: {
        "global-reviewer": { id: "global-reviewer", name: "Global Reviewer", limit: { context: 200_000 } },
        "global-fallback": { id: "global-fallback", name: "Global Fallback", limit: { context: 200_000 } },
      },
    },
  ],
  connected: ["opencode"],
  default: { providerID: "opencode", modelID: "global-reviewer" },
}

// The configured default chain is the sole persisted reviewer source; its
// validated snapshot is what host consumers read from global config.
const globalChain = [
  { providerID: "opencode", modelID: "global-reviewer" },
  { providerID: "opencode", modelID: "global-fallback" },
]

test("keeps the global safety-review chain across scoped modes and reloads", async ({ page }) => {
  const errors = trackPageErrors(page)
  const networkFailures = trackNetworkFailures(page)
  const configUpdates: Array<{ access_control?: GlobalAccessControl }> = []
  const globalConfig: { access_control: GlobalAccessControl } = {
    access_control: {
      mode: "ask" as const,
      safety_review: {
        prompt: "custom prompt",
      },
    },
  }

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "safety-review-persistence",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider,
    globalConfig: () => globalConfig,
    onGlobalConfigUpdate: async (body) => {
      const patch = body as { access_control?: GlobalAccessControl }
      configUpdates.push(patch)
      const next = {
        ...globalConfig.access_control,
        ...patch.access_control,
      }
      if (patch.access_control?.safety_review !== undefined) next.safety_review = patch.access_control.safety_review
      globalConfig.access_control = next
      return globalConfig
    },
    sessions: [
      session(sessionID, "Safety review persistence"),
      session(secondSessionID, "Safety review persistence second"),
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ directory, encoded, server, sessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { [server]: [{ worktree: directory, expanded: true }] }, lastProject: { [server]: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server, dirBase64: encoded, sessionId: sessionID }]),
      )
      localStorage.setItem(
        "opencode.global.dat:permission",
        JSON.stringify({
          autoAccept: {},
          accessControl: {
            project: {},
            session: {
              [`${encoded}/${sessionID}`]: {
                mode: "approve_for_me",
                safety_review: {
                  model: "opencode/scoped-reviewer",
                  fallback: { model: "opencode/scoped-fallback" },
                },
              },
            },
            workspace: {},
            updateProjectDefault: false,
            updateUserDefault: false,
            safetyReviewMigrated: true,
          },
        }),
      )
      // Seed once: reloads must observe the store the app itself persisted.
      if (!localStorage.getItem("opencode.global.dat:model")) {
        localStorage.setItem(
          "opencode.global.dat:model",
          JSON.stringify({
            user: [],
            recent: [],
            variant: {},
            selection: { chainID: "chain-global" },
            chains: [
              {
                id: "chain-global",
                name: "Global Chain",
                steps: [
                  { providerID: "opencode", modelID: "global-reviewer" },
                  { providerID: "opencode", modelID: "global-fallback" },
                ],
              },
            ],
            defaultChainID: "chain-global",
          }),
        )
      }
    },
    { directory, encoded: base64Encode(directory), server, sessionID },
  )

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await openSettings(page)
  await expectGlobalChain(page, "opencode/global-reviewer", "opencode/global-fallback")

  // The bridge persists the validated default-chain snapshot while preserving
  // the rest of the configured safety review.
  await expect
    .poll(() => JSON.stringify(globalConfig.access_control.safety_review?.chain))
    .toBe(JSON.stringify(globalChain))
  expect(globalConfig.access_control.safety_review?.prompt).toBe("custom prompt")

  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Access control" }).click()
  await page.getByRole("menuitemcheckbox", { name: "Update User default" }).click()
  const fullAccess = page.getByRole("menuitemradio", { name: /Full access/ })
  if (!(await fullAccess.isVisible())) await page.getByRole("button", { name: "Access control" }).click()
  await expectAppVisible(fullAccess)
  await fullAccess.click()
  await expect.poll(() => configUpdates.some((update) => update.access_control?.mode === "full_access")).toBe(true)
  // A default-mode write merges access_control and must never clobber the
  // global safety-review chain living in the same config object.
  const modeUpdate = configUpdates.find((update) => update.access_control?.mode === "full_access")
  expect(modeUpdate?.access_control?.safety_review).toMatchObject({ chain: globalChain })
  await openSettings(page)
  await expectGlobalChain(page, "opencode/global-reviewer", "opencode/global-fallback")

  await page.reload()
  await openSettings(page)
  await expectGlobalChain(page, "opencode/global-reviewer", "opencode/global-fallback")
  await expect
    .poll(() => JSON.stringify(globalConfig.access_control.safety_review?.chain))
    .toBe(JSON.stringify(globalChain))

  await page.goto(`/${base64Encode(directory)}/session/${secondSessionID}`)
  await openSettings(page)
  await expectGlobalChain(page, "opencode/global-reviewer", "opencode/global-fallback")
  await page.screenshot({ path: "e2e/test-results/settings-safety-review-persistence-desktop.png", fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await expectGlobalChain(page, "opencode/global-reviewer", "opencode/global-fallback")
  expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await page.screenshot({ path: "e2e/test-results/settings-safety-review-persistence-mobile.png", fullPage: true })
  expectNoSmokeErrors(errors, [], [])
  expect(
    networkFailures.filter(
      (failure) =>
        !(
          failure.includes(" net::ERR_ABORTED") &&
          (failure.includes("/perf/record") ||
            failure.includes("/global/event") ||
            failure.includes("/@fs/") ||
            failure.includes("/assets/") ||
            failure.includes(".woff") ||
            // Reload-navigated shell probe; real pty errors stay failures.
            failure.includes("/pty/shells"))
        ),
    ),
  ).toEqual([])

  await page.setViewportSize({ width: 1280, height: 800 })
  // Clearing the configured default chain removes the persisted snapshot from
  // global config; the safety row then reports no valid default chain.
  await page.getByRole("tab", { name: "Models", exact: true }).click()
  await page
    .locator('[data-action="settings-model-chain-chain-global"]')
    .getByRole("button", { name: "Clear default" })
    .click()
  await expect.poll(() => globalConfig.access_control.safety_review?.chain).toBeUndefined()
  await page.getByRole("tab", { name: "General", exact: true }).click()
  await expect(page.locator('[data-action="settings-safety-review-chain"]')).toContainText(
    "No valid default model chain configured",
  )
  expect(globalConfig.access_control.safety_review?.prompt).toBe("custom prompt")

  await page.locator('[data-action="settings-safety-review-prompt"] textarea').fill("")
  await expect.poll(() => globalConfig.access_control.safety_review?.prompt).toBeUndefined()
})

test("normalizes the default safety review to the chain contract once without promoting stale mirror copies", async ({ page }) => {
  const errors = trackPageErrors(page)
  const networkFailures = trackNetworkFailures(page)
  const configUpdates: Array<Record<string, unknown>> = []
  const globalConfig: { access_control?: GlobalAccessControl } = {}

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "safety-review-persistence",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider,
    globalConfig: () => globalConfig,
    onGlobalConfigUpdate: (body) => {
      const patch = body as { access_control?: GlobalAccessControl }
      configUpdates.push(patch)
      globalConfig.access_control = { ...globalConfig.access_control, ...patch.access_control }
      return globalConfig
    },
    sessions: [session(sessionID, "Safety review migration")],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ directory, encoded, server, sessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { [server]: [{ worktree: directory, expanded: true }] }, lastProject: { [server]: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server, dirBase64: encoded, sessionId: sessionID }]),
      )
      if (localStorage.getItem("opencode.global.dat:permission")) return
      localStorage.setItem(
        "opencode.global.dat:permission",
        JSON.stringify({
          autoAccept: {},
          accessControl: {
            project: {},
            session: {
              [`${encoded}/${sessionID}`]: {
                mode: "approve_for_me",
                safety_review: {
                  model: "opencode/scoped-reviewer",
                  fallback: { model: "opencode/scoped-fallback" },
                },
              },
            },
            workspace: {},
            updateProjectDefault: false,
            updateUserDefault: false,
          },
        }),
      )
    },
    { directory, encoded: base64Encode(directory), server, sessionID },
  )

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expect.poll(() => configUpdates.length).toBe(1)
  // With no default chain configured, startup seeds an empty chain-shaped
  // safety review: no hardcoded reviewer model, no fallback, no chain.
  expect(configUpdates[0]).toMatchObject({
    access_control: {
      safety_review: {},
    },
  })
  expect(configUpdates[0]?.access_control).not.toHaveProperty("mode")
  // Mirrored scoped copies are stale by definition and must never reach
  // global config.
  expect(JSON.stringify(configUpdates)).not.toContain("scoped-reviewer")
  expect(JSON.stringify(configUpdates)).not.toContain("scoped-fallback")
  await openSettings(page)
  await expect(page.locator('[data-action="settings-safety-review-chain"]')).toContainText(
    "No valid default model chain configured",
  )

  await page.reload()
  await expect.poll(() => configUpdates.length).toBe(1)
  await openSettings(page)
  await expect(page.locator('[data-action="settings-safety-review-chain"]')).toContainText(
    "No valid default model chain configured",
  )
  // The embedded mirror copy is stripped from the persisted store on load so
  // it can never be promoted or written back later. Check the actual profile
  // keys, not a substring: this test's session id contains "safety_review".
  await expect
    .poll(() =>
      page
        .evaluate(() => {
          const parsed = JSON.parse(localStorage.getItem("opencode.global.dat:permission") || "{}") as {
            accessControl?: Record<string, unknown>
          }
          const accessControl = parsed.accessControl ?? {}
          const profiles = [
            accessControl.user,
            ...Object.values((accessControl.project as Record<string, unknown>) ?? {}),
            ...Object.values((accessControl.session as Record<string, unknown>) ?? {}),
            ...Object.values((accessControl.workspace as Record<string, unknown>) ?? {}),
          ]
          return profiles.filter((profile) => profile !== null && typeof profile === "object" && "safety_review" in profile)
            .length
        })
        .then((count) => count === 0),
    )
    .toBe(true)
  expectNoSmokeErrors(errors, [], [])
  expect(
    networkFailures.filter(
      (failure) =>
        !(
          failure.includes(" net::ERR_ABORTED") &&
          (failure.includes("/perf/record") ||
            failure.includes("/global/event") ||
            failure.includes("/@fs/") ||
            failure.includes("/assets/") ||
            failure.includes(".woff") ||
            // Reload-navigated shell probe; real pty errors stay failures.
            failure.includes("/pty/shells"))
        ),
    ),
  ).toEqual([])
})

function session(id: string, title: string) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

async function openSettings(page: Page) {
  const button = page.getByRole("button", { name: "Open settings" })
  await expectAppVisible(button)
  await button.click()
  await expectAppVisible(page.locator('[data-action="settings-safety-review-chain"]'))
}

async function expectGlobalChain(page: Page, primary: string, fallback: string) {
  const row = page.locator('[data-action="settings-safety-review-chain"]')
  await expectAppVisible(row)
  const steps = row.locator('[data-slot="model-chain-path-step"]')
  await expect(steps).toHaveCount(2)
  await expect(steps.nth(0)).toHaveText(primary)
  await expect(steps.nth(1)).toHaveText(fallback)
  await expect(row.locator('[data-slot="model-chain-path-sep"]')).toHaveCount(1)
}
