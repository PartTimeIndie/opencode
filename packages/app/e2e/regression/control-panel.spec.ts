import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors, expectNoSmokeErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

test.use({ video: "on", screenshot: "on" })

const directory = "C:/OpenCode/ControlPanel"
const projectID = "proj_control_panel"
const sessionID = "ses_control_panel"

test("opens Control Panels as popups by default with explicit docking, pinning, and closing", async ({ page }) => {
  const errors = trackPageErrors(page)
  const warnings: string[] = []
  const mediaRequests: string[] = []
  const configApplies: { directory: string; body: unknown }[] = []
  const livePublishes: { directory: string; body: unknown }[] = []

  page.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text())
  })

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "control-panel",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session()],
    pageMessages: () => ({ items: messages() }),
    onControlConfigApply: (input) => {
      configApplies.push(input)
      return { ok: true }
    },
    onControlLivePublish: (input) => {
      livePublishes.push(input)
      return { ok: true }
    },
  })
  await page.route("**/app/media?**", (route) => {
    mediaRequests.push(new URL(route.request().url()).searchParams.get("path") ?? "")
    return route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    })
  })

  await page.addInitScript(
    ({ directory, dirBase64, sessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server: "http://127.0.0.1:4096", dirBase64, sessionId: sessionID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sessionID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  const popup = page.locator('[data-component="control-panel-popup"]')
  await expectAppVisible(popup)
  await expect(popup).toHaveAttribute("role", "dialog")
  await expect(popup).toHaveAttribute("aria-modal", "false")
  await expect(popup).toHaveAccessibleName("Second Control Panel")
  await expect(popup.getByText("Second Control Panel", { exact: true })).toHaveCount(1)
  expect(await popup.evaluate((element) => element.closest("main") === null && document.body.contains(element))).toBe(true)
  await expectAppVisible(
    popup.locator('[data-component="on-demand-expectation"][data-slot="control-panel-expectation"]'),
  )
  await expect(page.locator('[data-dock-area="bottom"]').getByRole("tab", { name: "QA Control Panel" })).toHaveCount(0)
  const secondDockTab = page.locator('[data-dock-area="middle"]').getByRole("tab", { name: "Second Control Panel" })
  const qaDockTab = page.locator('[data-dock-area="middle"]').getByRole("tab", { name: "QA Control Panel" })
  await expect(secondDockTab).toHaveCount(0)
  await expect(qaDockTab).toHaveCount(0)

  const secondPopupPanel = popup.locator(
    '[data-component="control-panel-card"][data-control-id="qa-control-panel-second"]',
  )
  await expectAppVisible(secondPopupPanel)
  const secondToggle = secondPopupPanel.getByRole("button", { name: "Enabled", exact: true })
  await expect(secondToggle).toHaveAttribute("aria-pressed", "true")
  await secondToggle.click()
  await expect(secondToggle).toHaveAttribute("aria-pressed", "false")
  await expect.poll(() => livePublishes.at(-1)?.body).toMatchObject({
    controlID: "qa-control-panel-second",
    control: "enabled",
    topic: "pu.cards",
    value: false,
  })
  const secondNotes = secondPopupPanel.getByRole("textbox", { name: "Notes", exact: true })
  const secondDescriptionID = await secondNotes.getAttribute("aria-describedby")
  expect(secondDescriptionID).toBeTruthy()
  await expect(page.locator(`[id="${secondDescriptionID}"]`)).toHaveText("Published live from the second panel.")
  await secondNotes.fill("second-state")
  await expect.poll(() => livePublishes.at(-1)?.body).toMatchObject({
    controlID: "qa-control-panel-second",
    control: "notes",
    topic: "pu.notes",
    value: "second-state",
  })

  await popup.getByRole("button", { name: "In Session-Dock", exact: true }).click()
  await expectAppVisible(secondDockTab)
  await expect(popup).toHaveAccessibleName("QA Control Panel")
  await expect(popup.getByText("QA Control Panel", { exact: true })).toHaveCount(1)
  const qaPanel = popup.locator('[data-component="control-panel-card"][data-control-id="qa-control-panel"]')
  await expectAppVisible(qaPanel)
  await expect(qaPanel.getByRole("textbox", { name: "Notes", exact: true })).toHaveValue("")
  await expect(popup.locator('[data-component="on-demand-expectation"]')).toHaveCount(1)

  const modeRow = qaPanel.locator('[data-slot="control-panel-row"][data-control-type="button_group"]').filter({ hasText: "Mode" })
  await expect(modeRow.getByRole("group", { name: "Mode", exact: true })).toBeVisible()
  const speedRow = qaPanel.locator('[data-slot="control-panel-row"][data-control-type="slider"]').filter({ hasText: "Speed" })
  const speedSlider = speedRow.getByRole("slider", { name: "Speed", exact: true })
  const speedInput = speedRow.getByRole("spinbutton", { name: "Speed", exact: true })
  await expectAppVisible(speedSlider)
  await expectAppVisible(speedInput)
  const speedDescriptionID = await speedSlider.getAttribute("aria-describedby")
  expect(speedDescriptionID).toBeTruthy()
  await expect(page.locator(`[id="${speedDescriptionID}"]`)).toHaveText("Controls the preview scale.")
  const qualityRow = qaPanel.locator('[data-slot="control-panel-row"][data-control-type="pick_one"]').filter({ hasText: "Quality" })
  await expect(qualityRow.getByRole("radiogroup", { name: "Quality", exact: true })).toBeVisible()
  await expect(qualityRow.getByRole("radio", { name: /Draft/ })).toHaveAttribute("aria-checked", "false")

  await page.setViewportSize({ width: 390, height: 844 })
  await expectAppVisible(popup)
  await expectAppVisible(popup.getByRole("button", { name: "In Session-Dock", exact: true }))
  const bounds = await popup.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844)
  const popupBody = popup.locator('[data-slot="control-panel-popup-body"]')
  const dialogTargets = qaPanel
    .locator('[data-slot="control-panel-row"][data-control-type="object_tree"]')
    .filter({ hasText: "PU Dialog Targets" })
  await dialogTargets.scrollIntoViewIfNeeded()
  await expect(dialogTargets).toBeInViewport()
  await expect(popup.getByRole("button", { name: "Schließen", exact: true })).toBeInViewport()
  await page.screenshot({ path: "test-results/control-panel-popup-mobile.png", fullPage: true })

  await page.setViewportSize({ width: 1280, height: 720 })
  await popupBody.evaluate((element) => {
    element.scrollTop = 0
  })
  const appliesBeforeButton = configApplies.length
  await qaPanel.getByRole("button", { name: "Apply changes", exact: true }).click()
  await expect.poll(() => configApplies.slice(appliesBeforeButton).at(-1)?.body).toMatchObject({
    value: "apply",
    target: { path: "config/pu-dialog-targets.json", pointer: "/action" },
  })
  await expect(modeRow.getByRole("button", { name: "Safe", exact: true })).toBeEnabled()
  await expect(modeRow.getByRole("button", { name: "Fast", exact: true })).toBeEnabled()
  await modeRow.getByRole("button", { name: "Fast", exact: true }).click()
  await expect.poll(() => configApplies.at(-1)?.body).toMatchObject({
    value: "fast",
    target: { path: "config/pu-dialog-targets.json", pointer: "/mode" },
  })
  await expect(qaPanel.getByRole("button", { name: "Unsupported command", exact: true })).toBeDisabled()
  await speedInput.fill("7")
  await expect.poll(() => configApplies.at(-1)?.body).toMatchObject({
    value: 7,
    target: { path: "config/pu-dialog-targets.json", pointer: "/speed" },
  })
  await expect(speedRow.locator('[data-slot="control-panel-status"]')).toHaveAttribute("data-status", "saved")
  const previewImage = qaPanel.locator('[data-slot="control-panel-row"][data-control-type="image_preview"]').locator('[data-slot="control-panel-image"]')
  await expect(previewImage).toHaveAttribute("src", /^blob:/)
  expect(mediaRequests).toContain("C:/Audit/head.png")
  await expect(previewImage).toHaveAttribute("style", /scale\(0\.7\)/)

  const finalQuality = qualityRow.getByRole("radio", { name: /Final/ })
  await finalQuality.click()
  await expect(finalQuality).toHaveAttribute("aria-checked", "true")
  await expect.poll(() => configApplies.at(-1)?.body).toMatchObject({
    value: "Final",
    target: { path: "config/pu-dialog-targets.json", pointer: "/quality" },
  })

  const notesRow = qaPanel.locator('[data-slot="control-panel-row"][data-control-type="ask_text"]').filter({ hasText: "Notes" })
  const notesInput = notesRow.getByRole("textbox", { name: "Notes", exact: true })
  const appliesBeforeNotes = configApplies.length
  await notesInput.pressSequentially("abc", { delay: 10 })
  await expect.poll(() => configApplies.slice(appliesBeforeNotes).length).toBe(1)
  await page.waitForTimeout(300)
  expect(configApplies.slice(appliesBeforeNotes)).toHaveLength(1)
  await expect.poll(() => configApplies.at(-1)?.body).toMatchObject({
    value: "abc",
    target: { path: "config/pu-dialog-targets.json", pointer: "/notes" },
  })
  await expect(notesRow.getByRole("status")).toHaveAttribute("data-status", "saved")

  await expectAppVisible(dialogTargets.locator('[data-slot="explorable-review"][data-variant="object_tree"]'))
  await dialogTargets.locator('[data-slot="explorable-node"]').filter({ hasText: "Merchant Cards" }).click()
  await expectAppVisible(dialogTargets.locator('[data-slot="explorable-detail"]').filter({ hasText: "Card affordances" }))
  await page.screenshot({ path: "e2e/test-results/control-panel-tweaks-desktop.png", fullPage: true })

  await page.locator(`[data-dock-tab][data-session-id="${sessionID}"]`).getByRole("tab").click()
  const composerInput = page.locator('[data-component="prompt-input"]')
  await composerInput.focus()
  await expect(composerInput).toBeFocused()
  const appliesBeforeClose = configApplies.length
  await notesInput.fill("flush on escape")
  await expect(notesInput).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(popup).toHaveCount(0)
  await expect(composerInput).toBeFocused()
  await expect.poll(() => configApplies.slice(appliesBeforeClose).at(-1)?.body).toMatchObject({
    value: "flush on escape",
    target: { path: "config/pu-dialog-targets.json", pointer: "/notes" },
  })

  await expect(qaDockTab).toHaveCount(0)
  await secondDockTab.click()
  const secondPanel = page.locator('[data-component="control-panel-dock-pane"][data-control-id="qa-control-panel-second"]')
  await expectAppVisible(secondPanel)
  await secondPanel.getByRole("button", { name: "Anheften" }).click()
  await expectAppVisible(secondPanel.getByRole("button", { name: "Angeheftet" }))
  const enabledToggle = secondPanel.getByRole("button", { name: "Enabled", exact: true })
  await expect(enabledToggle).toHaveAttribute("aria-pressed", "true")
  await enabledToggle.click()
  await expect(enabledToggle).toHaveAttribute("aria-pressed", "false")
  await expect.poll(() => livePublishes.at(-1)?.body).toMatchObject({
    controlID: "qa-control-panel-second",
    control: "enabled",
    topic: "pu.cards",
    value: false,
  })
  await secondPanel.locator('[data-slot="control-panel-dock-action"][data-area="right"]').click()
  await expectAppVisible(page.locator('[data-dock-area="right"]').getByRole("tab", { name: "Second Control Panel" }))

  await page.reload()
  await expectAppVisible(page.locator('[data-dock-area="right"]').getByRole("tab", { name: "Second Control Panel" }))
  await expectAppVisible(page.getByText("Angehefteter Snapshot aus Session ses_control_panel", { exact: true }))
  await expect(popup).toHaveCount(0)
  await page.screenshot({ path: "test-results/control-panel-desktop.png", fullPage: true })

  await page
    .locator('[data-dock-area="right"] [data-slot="control-panel-pane-header"]')
    .getByRole("button", { name: "Close Second Control Panel" })
    .click()
  await expect(page.locator('[data-dock-area="right"]').getByRole("tab", { name: "Second Control Panel" })).toHaveCount(0)
  await expect(qaDockTab).toHaveCount(0)

  expectNoSmokeErrors(errors, [], [])
  expect(
    warnings.filter(
      (warning) =>
        warning.includes("computations created outside a `createRoot` or `render`") ||
        warning.includes("Cannot remove nonexistent sensor with id: pointer-sensor"),
    ),
  ).toEqual([])
})

function messages() {
  const userID = "msg_user_control_panel"
  const assistantID = "msg_assistant_control_panel"
  return [
    {
      info: {
        id: userID,
        sessionID,
        role: "user",
        time: { created: 1700000000000 },
        summary: { diffs: [] },
        agent: "build",
        model: { providerID: "opencode", modelID: "claude-opus-4-6", variant: "max" },
      },
      parts: [{ id: "prt_user_control_panel", sessionID, messageID: userID, type: "text", text: "Show controls" }],
    },
    {
      info: {
        id: assistantID,
        sessionID,
        role: "assistant",
        time: { created: 1700000001000, completed: 1700000002000 },
        parentID: userID,
        modelID: "claude-opus-4-6",
        providerID: "opencode",
        mode: "build",
        agent: "build",
        path: { cwd: directory, root: directory },
        cost: 0.01,
        tokens: { input: 100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        variant: "max",
        finish: "stop",
      },
      parts: [
        {
          id: "prt_control_panel_1",
          sessionID,
          messageID: assistantID,
          type: "custom",
          kind: "opencode/control-panel",
          title: "QA Control Panel",
          fallback: "QA Control Panel\n\n- Speed: slider",
          data: {
            version: 1,
            controlID: "qa-control-panel",
            title: "QA Control Panel",
            controls: [
              { id: "apply-changes", type: "button", label: "Apply changes", value: "apply" },
              {
                id: "mode",
                type: "button_group",
                label: "Mode",
                options: [
                  { id: "safe", label: "Safe" },
                  { id: "fast", label: "Fast" },
                ],
              },
              { id: "unsupported-command", type: "command_trigger", label: "Unsupported command" },
              {
                id: "speed",
                type: "slider",
                label: "Speed",
                description: "Controls the preview scale.",
                min: 0,
                max: 10,
                value: 4,
              },
              { id: "head", type: "image_preview", label: "Head Preview" },
              {
                id: "quality",
                type: "pick_one",
                label: "Quality",
                options: [
                  { label: "Draft", description: "Fast iteration" },
                  { label: "Final", description: "Higher quality" },
                ],
              },
              {
                id: "notes",
                type: "ask_text",
                label: "Notes",
                description: "Saved to the project configuration.",
                placeholder: "Type panel notes",
              },
              {
                id: "dialog-targets",
                type: "object_tree",
                label: "PU Dialog Targets",
                content: "Tune dialogue targets and card behavior before applying changes.",
                sections: [
                  {
                    id: "goals",
                    title: "Scene Goals",
                    content: "Keep each NPC beat tied to one clear player-facing intention.",
                    children: [
                      { id: "intro", title: "Intro", content: "Short greeting, one conflict hook, no lore dump." },
                      { id: "exit", title: "Exit", content: "Close with a concrete next action." },
                    ],
                  },
                  {
                    id: "cards",
                    title: "Merchant Cards",
                    content: "Card affordances should stay readable while dialog is active.",
                    children: [
                      { id: "rarity", title: "Rarity Chips", content: "Use compact labels and avoid covering card costs." },
                      { id: "hover", title: "Hover Timing", content: "Delay reveal enough to avoid accidental card jumps." },
                    ],
                  },
                ],
              },
            ],
            effects: [
              { id: "head_src", target: "ui.head.src", value: "C:/Audit/head.png" },
              { id: "head_scale", target: "ui.head.style.transform", value: "scale(0.${values.speed})" },
            ],
            actions: [
              {
                id: "apply_changes",
                trigger: { event: "click", source: "apply-changes" },
                steps: [
                  { type: "configWrite", target: { path: "config/pu-dialog-targets.json", format: "json", pointer: "/action" }, debounceMs: 0 },
                ],
              },
              {
                id: "safe_mode",
                trigger: { event: "click", source: "mode", when: { field: "mode", equals: "safe" } },
                steps: [
                  { type: "configWrite", target: { path: "config/pu-dialog-targets.json", format: "json", pointer: "/mode" }, debounceMs: 0 },
                ],
              },
              {
                id: "fast_mode",
                trigger: { event: "click", source: "mode", when: { field: "mode", equals: "fast" } },
                steps: [
                  { type: "configWrite", target: { path: "config/pu-dialog-targets.json", format: "json", pointer: "/mode" }, debounceMs: 0 },
                ],
              },
              {
                id: "unsupported_command",
                trigger: { event: "click", source: "unsupported-command" },
                steps: [{ type: "command", command: "echo", arguments: ["not-run"] }],
              },
              {
                id: "write_speed",
                trigger: { event: "change", source: "speed" },
                steps: [{ type: "configWrite", target: { path: "config/pu-dialog-targets.json", format: "json", pointer: "/speed" }, debounceMs: 0 }],
              },
              {
                id: "write_quality",
                trigger: { event: "change", source: "quality" },
                steps: [{ type: "configWrite", target: { path: "config/pu-dialog-targets.json", format: "json", pointer: "/quality" }, debounceMs: 0 }],
              },
              {
                id: "write_notes",
                trigger: { event: "change", source: "notes" },
                steps: [{ type: "configWrite", target: { path: "config/pu-dialog-targets.json", format: "json", pointer: "/notes" } }],
              },
            ],
          },
        },
        {
          id: "prt_control_panel_2",
          sessionID,
          messageID: assistantID,
          type: "custom",
          kind: "opencode/control-panel",
          title: "Second Control Panel",
          fallback: "Second Control Panel\n\n- Enabled: toggle",
          data: {
            version: 1,
            controlID: "qa-control-panel-second",
            title: "Second Control Panel",
            controls: [
              {
                id: "enabled",
                type: "toggle",
                label: "Enabled",
                value: true,
              },
              {
                id: "notes",
                type: "ask_text",
                label: "Notes",
                description: "Published live from the second panel.",
                placeholder: "Type second panel notes",
              },
              {
                id: "card-tabs",
                type: "tabs",
                label: "Card Tweaks",
                sections: [
                  { id: "front", title: "Front", content: "Primary card face keeps title, cost, and action clear." },
                  { id: "back", title: "Back", content: "Back face shows compact upgrade hints only." },
                ],
              },
            ],
            actions: [
              {
                id: "publish_enabled",
                trigger: { event: "change", source: "enabled" },
                steps: [{ type: "livePublish", topic: "pu.cards", debounceMs: 0 }],
              },
              {
                id: "publish_notes",
                trigger: { event: "change", source: "notes" },
                steps: [{ type: "livePublish", topic: "pu.notes", debounceMs: 0 }],
              },
            ],
          },
        },
      ],
    },
  ]
}

function session() {
  return {
    id: sessionID,
    slug: "control-panel",
    projectID,
    directory,
    title: "Control Panel QA",
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

function base64Encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}
