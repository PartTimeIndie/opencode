import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackNetworkFailures, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/SettingsVisionPersistence"
const server = "http://127.0.0.1:4096"
const sessionID = "ses_settings_vision_persistence"

const provider = {
  all: [
    {
      id: "opencode",
      name: "OpenCode",
      models: {
        "vision-initial": {
          id: "vision-initial",
          name: "Vision Initial",
          limit: { context: 200_000 },
          variants: { high: {} },
        },
        "vision-updated": {
          id: "vision-updated",
          name: "Vision Updated",
          limit: { context: 200_000 },
          variants: { high: {} },
        },
      },
    },
  ],
  connected: ["opencode"],
  default: { providerID: "opencode", modelID: "vision-initial" },
}

test("preserves rapid edits to different global vision fields", async ({ page }) => {
  const errors = trackPageErrors(page)
  const networkFailures = trackNetworkFailures(page)
  const updates: Array<{ enabled?: boolean; primary?: { model?: string; variant?: string }; prompt_template?: string }> = []
  const globalConfig = {
    access_control: {
      safety_review: { model: "opencode/deepseek-v4-flash-free" },
    },
    vision: {
      enabled: false,
      primary: { model: "opencode/vision-initial", variant: "high" },
      prompt_template: "custom template",
    },
  }

  await mockOpenCodeServer(page, {
    directory,
    provider,
    project: { id: "project-settings-vision-persistence", name: "Vision settings", worktree: directory, vcs: "git" },
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
    globalConfig: () => globalConfig,
    onGlobalConfigUpdate: async (body) => {
      const patch = body as {
        vision?: { enabled?: boolean; primary?: { model?: string; variant?: string }; prompt_template?: string }
      }
      if (!patch.vision) return globalConfig
      updates.push(patch.vision)
      if (updates.length === 1) await new Promise((resolve) => setTimeout(resolve, 500))
      globalConfig.vision = {
        ...globalConfig.vision,
        ...patch.vision,
        primary: { ...globalConfig.vision.primary, ...patch.vision.primary },
      }
      return globalConfig
    },
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
            session: {},
            workspace: {},
            updateProjectDefault: false,
            updateUserDefault: false,
            safetyReviewMigrated: true,
          },
        }),
      )
    },
    { directory, encoded: base64Encode(directory), server, sessionID },
  )

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const settings = page.getByRole("button", { name: "Open settings" })
  await expectAppVisible(settings)
  await settings.click()
  await page.getByRole("tab", { name: "Vision", exact: true }).click()

  await page.locator('[data-action="settings-vision-enabled"] [data-component="switch"]').click()
  await page.locator('[data-action="settings-vision-primary"]').getByRole("button", { name: "Primary vision model" }).click()
  await page.locator('[data-slot="list-item"]').filter({ hasText: "Vision Updated" }).click()

  await expect.poll(() => updates.length).toBe(3)
  await expect.poll(() => globalConfig.vision).toEqual({
    enabled: true,
    primary: { model: "opencode/vision-updated" },
    prompt_template: "custom template",
  })

  await page.locator('[data-action="settings-vision-primary"]').getByRole("button", { name: "Clear" }).click()
  await expect.poll(() => globalConfig.vision.primary).toBeUndefined()
  await page.getByRole("button", { name: "Reset to default" }).click()
  await expect.poll(() => globalConfig.vision.prompt_template).toBeUndefined()
  expect(updates).toHaveLength(5)
  expect(errors).toEqual([])
  expect(networkFailures).toEqual([])
})

function session() {
  return {
    id: sessionID,
    slug: sessionID,
    projectID: "project-settings-vision-persistence",
    directory,
    title: "Vision settings persistence",
    version: "dev",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  }
}
