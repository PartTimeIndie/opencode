import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors } from "../utils/errors"
import { fixture } from "../smoke/session-timeline.fixture"

const directory = "C:/OpenCode/SkillPolicyQA"
const sessionID = "ses_skill_policy_qa"
const server = "local"

const skills = [
  {
    name: "effect",
    description: "Effect guidance",
    location: `${directory}/.opencode/skills/effect/SKILL.md`,
    content: "body",
  },
  {
    name: "visual-qa-testing",
    description: "Visual QA workflow",
    disableModelInvocation: true,
    effective: {
      visible: false,
      invocation: "allow",
      sources: { visible: "global-entry", invocation: "global-entry" },
    },
    location: `${directory}/.opencode/skills/visual-qa-testing/SKILL.md`,
    content: "body",
  },
  {
    name: "imagegen",
    description: "Image generation",
    location: `${directory}/.opencode/skills/imagegen/SKILL.md`,
    content: "body",
  },
]

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }])
  test(`skill policy settings round-trip ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport)
    const errors = trackPageErrors(page)
    const networkFailures: string[] = []
    page.on("requestfailed", (request) =>
      networkFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`),
    )
    page.on("response", (response) => {
      if (response.status() >= 400) networkFailures.push(`${response.status()} ${response.url()}`)
    })

    let currentSkills = skills
    const patches: unknown[] = []
    await mockOpenCodeServer(page, {
      directory,
      provider: fixture.provider,
      project: { id: "project-skill-policy-qa", name: "Skill Policy QA", worktree: directory, vcs: "git" },
      sessions: [{ id: sessionID, slug: "policy", projectID: "project-skill-policy-qa", directory, title: "Skill Policy QA", version: "dev", time: { created: 1700000000000, updated: 1700000000000 } }],
      pageMessages: () => ({ items: [] }),
      globalConfig: () => ({}),
      onGlobalConfigUpdate: (body) => {
        patches.push(body)
        return body
      },
    })
    await page.route(/\/api\/skill(?:\?|$)/, (route) =>
      route.fulfill({ json: { data: currentSkills } }),
    )
    // The Skills & Plugins tab also mounts the plugin toolbar panel; the app
    // plugin list is irrelevant here and its dialog-lifecycle refetch aborts.
    await page.route("**/app/plugins**", (route) => route.fulfill({ json: { plugins: [] } }))

    await page.addInitScript(
      ({ dir, dirBase64, serverKey }) => {
        localStorage.setItem("settings.v3", JSON.stringify({}))
        localStorage.setItem(
          "opencode.global.dat:server",
          JSON.stringify({ projects: { [serverKey]: [{ worktree: dir, expanded: true }] }, lastProject: { [serverKey]: dir } }),
        )
        localStorage.setItem(
          "opencode.global.dat:tabs",
          JSON.stringify([{ type: "session", server: serverKey, dirBase64, sessionId: "ses_skill_policy_qa" }]),
        )
      },
      { dir: directory, dirBase64: base64Encode(directory), serverKey: server },
    )

    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible()

    await page.evaluate(() => {
      const event = new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true, cancelable: true })
      document.dispatchEvent(event)
    })
    const tab = page.getByRole("tab", { name: "Skills & Plugins", exact: true })
    await expect(tab).toBeVisible()
    await tab.click()

    const panel = page.locator('[data-skill-policy-settings]')
    await expect(panel).toBeVisible()
    await expect(panel.locator('[data-skill-policy-row]')).toHaveCount(0)
    await expect(panel.getByRole("button", { name: "Browse skills", exact: true })).toHaveAttribute("aria-expanded", "false")
    await panel.getByRole("button", { name: "Browse skills", exact: true }).click()
    await expect(panel.getByRole("button", { name: "Hide skills", exact: true })).toHaveAttribute("aria-expanded", "true")
    await expect(panel).toContainText("effective policy unavailable")
    await expect(panel.locator('[data-skill-policy-row="effect"]').getByRole("switch")).toBeDisabled()
    const searchBounds = await panel.getByRole("searchbox", { name: "Filter skills" }).boundingBox()
    const panelBounds = await panel.boundingBox()
    expect(searchBounds!.x + searchBounds!.width).toBeLessThanOrEqual(panelBounds!.x + panelBounds!.width + 1)
    const descriptionBounds = await panel.getByText("Visibility controls the model catalog only.", { exact: false }).boundingBox()
    expect(descriptionBounds!.width).toBeGreaterThanOrEqual(130)
    const unavailable = info.outputPath("skills-policy-unavailable.png")
    await page.screenshot({ path: unavailable })
    await info.attach("Unavailable skill policy", { path: unavailable, contentType: "image/png" })
    await panel.getByRole("searchbox", { name: "Filter skills" }).fill("visual")
    await expect(panel.locator('[data-skill-policy-row]')).toHaveCount(1)

    // The hidden+allow toolbar skill appears for management, with its source.
    const row = panel.locator('[data-skill-policy-row="visual-qa-testing"]')
    await expect(row).toBeVisible()
    await expect(panel).toContainText("catalog: hidden (global setting)")
    await expect(panel).toContainText("invocation: allow (global setting)")

    // Visibility and invocation are independent controls on one row.
    const visibleSwitch = row.getByRole("switch")
    await expect(visibleSwitch).not.toBeChecked()
    await row.locator('[data-slot="switch-control"]').click()
    await expect.poll(() => patches.length, { timeout: 5000 }).toBeGreaterThan(0)
    const firstPatch = patches.at(-1) as { skill_policy?: { global?: Record<string, unknown> } }
    expect(firstPatch.skill_policy?.global?.["visual-qa-testing"]).toEqual({ visible: true })

    // The server reflects the new policy on the next list; the panel re-reads it.
    currentSkills = skills.map((item) =>
      item.name === "visual-qa-testing" && item.effective
        ? {
            ...item,
            effective: {
              visible: true,
              invocation: "allow",
              sources: { visible: "global-entry", invocation: "global-entry" },
            },
          }
        : item,
    )
    await expect(panel).toContainText("catalog: shown (global setting)")

    // Invocation stays independently changeable after the visibility flip.
    await row.locator('[data-component="select-v2"]').click()
    await page.locator('[data-slot="select-v2-listbox"] [role="option"]').filter({ hasText: "Ask" }).click()
    await expect.poll(() => patches.length).toBeGreaterThan(1)
    const secondPatch = patches.at(-1) as { skill_policy?: { global?: Record<string, unknown> } }
    expect(secondPatch.skill_policy?.global?.["visual-qa-testing"]).toEqual({ invocation: "ask" })
    await panel.getByRole("button", { name: "Hide skills", exact: true }).click()
    await expect(panel.locator('[data-skill-policy-row]')).toHaveCount(0)
    const collapsed = info.outputPath("skills-collapsed.png")
    await page.screenshot({ path: collapsed })
    await info.attach("Compact Skills & Plugins", { path: collapsed, contentType: "image/png" })
    const settingsSearch = page.getByRole("searchbox", { name: "Search settings" })
    await settingsSearch.fill("Browse skills")
    await page.getByRole("region", { name: "Search results" }).getByRole("button", { name: /Browse skills/ }).click()
    await expect(panel.getByRole("button", { name: "Hide skills", exact: true })).toBeVisible()
    await expect(row).toBeVisible()
    await panel.getByRole("searchbox", { name: "Filter skills" }).fill("not-an-installed-skill")
    await expect(panel).toContainText("No matching skills.")
    await panel.getByRole("searchbox", { name: "Filter skills" }).fill("visual")
    const expanded = info.outputPath("skills-search.png")
    await page.screenshot({ path: expanded })
    await info.attach("Skills search", { path: expanded, contentType: "image/png" })

    expect(errors).toEqual([])
    // Contract: the settings dialog unmount aborts the in-flight app-plugin
    // toolbar readiness fetch; only that exact GET may abort, nothing else.
    const unexpected = networkFailures.filter((failure) => {
      if (!failure.endsWith("net::ERR_ABORTED")) return true
      try {
        return new URL(failure.split(" ")[1]!).pathname !== "/app/plugins"
      } catch {
        return true
      }
    })
    expect(unexpected).toEqual([])
  })
