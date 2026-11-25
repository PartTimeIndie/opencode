import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import type { SessionDelegationPreferencesResponses, SessionPatchDelegationPreferencesData } from "@opencode-ai/sdk/v2"
import { mockOpenCodeServer } from "../utils/mock-server"
import { fixture } from "../smoke/session-timeline.fixture"
import { trackPageErrors } from "../utils/errors"

const directory = "C:/OpenCode/DelegationSettingsQA"
const sessionID = "ses_delegation_settings_qa"
type Snapshot = SessionDelegationPreferencesResponses[200]
type Patch = NonNullable<SessionPatchDelegationPreferencesData["body"]>

for (const width of [1280, 390]) test(`delegation Settings scope, CAS, remount and focus ${width}`, async ({ page, context }, info) => {
  const values = new Map<string, Snapshot>()
  const patches: Patch[] = []
  const errors: string[] = []
  let rejectedSaves = 0
  const setup = async (view: Page) => {
    await view.setViewportSize({ width, height: 844 })
    const pageErrors = trackPageErrors(view)
    view.on("close", () => errors.push(...pageErrors))
    await mockOpenCodeServer(view, {
      directory, provider: fixture.provider,
      project: { id: "project-delegation", worktree: directory, name: "Delegation QA", vcs: "git" },
      sessions: [{ id: sessionID, slug: "delegation", projectID: "project-delegation", directory, title: "Delegation QA", version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 } }],
      pageMessages: () => ({ items: [] }), globalConfig: () => ({}),
    })
    await view.route("**/app/plugins**", (route) => route.fulfill({ json: { plugins: [] } }))
    await view.route(/\/session\/[^/]+\/delegation-preferences(?:\?|$)/, async (route) => {
      const url = new URL(route.request().url())
      if (route.request().method() === "GET") {
        const scope = url.searchParams.get("scope") ?? "session"
        const value = values.get(scope) ?? { scope, value: {}, ...(scope === "project" || scope === "global" ? { version: "a".repeat(64) } : { revision: 0 }) }
        await route.fulfill({ json: value })
        return
      }
      const body: Patch = route.request().postDataJSON()
      patches.push(body)
      const scope = body.scope ?? "session"
      const old = values.get(scope) ?? { scope, value: {}, ...(scope === "project" || scope === "global" ? { version: "a".repeat(64) } : { revision: 0 }) }
      if (body.expectedRevision !== old.revision || body.expectedVersion !== old.version) {
        rejectedSaves++
        await route.fulfill({ status: 409, json: { message: "Settings changed in another window. Read this scope again." } })
        return
      }
      const saved: Snapshot = { scope, value: { ...(body.patch.ordinaryQuestions === null ? {} : { ordinaryQuestions: body.patch.ordinaryQuestions }),
        ...(body.patch.preferences === null ? {} : { preferences: body.patch.preferences }),
        ...(body.patch.rules === null ? {} : { rules: body.patch.rules }) },
        ...(old.revision === undefined ? { version: "b".repeat(64) } : { revision: old.revision + 1 }) }
      values.set(scope, saved)
      await route.fulfill({ json: saved })
    })
    await view.addInitScript(({ directory, sessionID }) => {
      // Seed once per browser context. Re-seeding on reload would replace the
      // application's newly persisted dock layout with the legacy tabs fixture.
      if (localStorage.getItem("delegation-settings-fixture") === "initialized") return
      localStorage.setItem("delegation-settings-fixture", "initialized")
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
      localStorage.setItem("opencode.global.dat:tabs", JSON.stringify([{ type: "session", server: "local", dirBase64: btoa(directory), sessionId: sessionID }]))
    }, { directory, sessionID })
    await view.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    await expect(view.getByRole("textbox", { name: /Ask anything/i })).toBeVisible()
    return pageErrors
  }
  const open = async (view: Page) => {
    await view.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true, cancelable: true })))
    await view.getByRole("tab", { name: "Skills & Plugins", exact: true }).click()
    const panel = view.locator("[data-delegation-settings]")
    await expect(panel).toBeVisible()
    await panel.getByRole("button", { name: "Read scope", exact: true }).click()
    await expect(panel.getByRole("button", { name: "Save scope", exact: true })).toBeVisible()
    return panel
  }
  const firstErrors = await setup(page)
  const first = await open(page)
  await expect(first).toContainText("Revision 0")
  const secondPage = await context.newPage()
  const secondErrors = await setup(secondPage)
  const second = await open(secondPage)
  await first.getByLabel("Ordinary-question preference").selectOption("false")
  const advanced = first.getByRole("textbox", { name: "Delegation preferences and rules", exact: true })
  await advanced.fill(JSON.stringify({ preferences: [{ topic: "tests", selections: [{ agent: "build" }] }] }))
  await expect(advanced).toBeFocused()
  await first.getByRole("button", { name: "Save scope", exact: true }).click()
  await expect(first).toContainText("Revision 1")
  expect(patches[0]).toMatchObject({ scope: "session", expectedRevision: 0, patch: { ordinaryQuestions: false, rules: null } })
  await second.getByLabel("Ordinary-question preference").selectOption("true")
  await second.getByRole("button", { name: "Save scope", exact: true }).click()
  await expect(second.getByRole("alert")).toContainText("another window")
  await expect(second.getByRole("button", { name: "Save scope", exact: true })).toHaveCount(0)
  expect(patches).toHaveLength(2)
  await second.getByRole("button", { name: "Read scope", exact: true }).click()
  await expect(second).toContainText("Revision 1")
  await expect(second.getByLabel("Ordinary-question preference")).toHaveValue("false")
  await page.reload()
  const remounted = await open(page)
  await expect(remounted).toContainText("Revision 1")
  // A textarea exposes its state through the form value, not textContent.
  await expect(remounted.getByRole("textbox", { name: "Delegation preferences and rules", exact: true })).toHaveValue(/"tests"/)
  await remounted.getByLabel("Delegation scope").selectOption("project")
  await expect(remounted.getByRole("button", { name: "Save scope", exact: true })).toHaveCount(0)
  await remounted.getByRole("button", { name: "Read scope", exact: true }).click()
  await expect(remounted).toContainText("File version aaaaaaaaaaaa")
  await remounted.getByLabel("Ordinary-question preference").selectOption("false")
  await remounted.getByRole("button", { name: "Save scope", exact: true }).click()
  await expect(remounted).toContainText("File version bbbbbbbbbbbb")
  expect(patches.at(-1)).toMatchObject({ scope: "project", expectedVersion: "a".repeat(64) })
  const shot = info.outputPath(`delegation-settings-${width}.png`)
  await page.screenshot({ path: shot })
  await info.attach("Delegation Settings", { path: shot, contentType: "image/png" })
  const bounds = await remounted.boundingBox()
  if (!bounds) throw new Error("Settings panel has no rendered bounds")
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1)
  // Chromium logs the deliberately rejected stale save as a resource error.
  // Allow exactly that many occurrences; any other console error still fails.
  const withoutRejectedSave = (messages: string[]) => {
    let allowed = rejectedSaves
    return messages.filter((message) =>
      message === "Failed to load resource: the server responded with a status of 409 (Conflict)" && allowed-- > 0
        ? false
        : true,
    )
  }
  expect(withoutRejectedSave(firstErrors)).toEqual([])
  expect(withoutRejectedSave(secondErrors)).toEqual([])
  await secondPage.close()
  expect(withoutRejectedSave(errors)).toEqual([])
})
