import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"
import { fixture } from "../smoke/session-timeline.fixture"

const directory = "C:/OpenCode/BrowserToolCatalog"
const browserIDs = ["browser_click", "browser_navigate", "browser_snapshot", "browser_type", "browser_wait"]

for (const mode of ["explicit", "inherit"] as const)
test(`inactive Browser tools can be configured without changing the ${mode} tool mode`, async ({ page }, testInfo) => {
  const errors = trackPageErrors(page)
  const updates: Array<Record<string, unknown>> = []
  const agentUpdates = () => updates.filter((update) => update.agent)
  let config: Record<string, unknown> = {
    default_agent: "plan",
    agent: {
      plan: {
        mode: "primary",
        tools: { mode, entries: {
          read: { visible: true, permission: "allow" },
          ...(mode === "inherit" ? Object.fromEntries(browserIDs.map((id) => [id, { visible: false, permission: "deny" }])) : {}),
        } },
      },
    },
  }
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_browser_catalog",
      worktree: directory,
      vcs: "git",
      name: "browser-catalog",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    agents: [{ name: "plan", mode: "primary" }],
    provider: fixture.provider,
    sessions: [],
    pageMessages: () => ({ items: [] }),
    globalConfig: () => config,
    onGlobalConfigUpdate: (body) => {
      const update = body as Record<string, unknown>
      updates.push(update)
      config = { ...config, ...update }
      return config
    },
  })
  await page.route(
    (url) => url.pathname === "/experimental/tool",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "read",
            description: "Read files",
            parameters: { type: "object", properties: {} },
            scope: "application",
            visible: true,
          },
          ...browserIDs.map((id) => ({
            id,
            description: "Control the integrated Browser Dock after capability activation.",
            parameters: { type: "object", properties: {} },
            scope: "location",
            visible: true,
          })),
        ]),
      }),
  )
  await page.route(
    (url) => url.pathname === "/experimental/tool/ids",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(["read", ...browserIDs]),
      }),
  )
  await page.addInitScript(
    ({ directory }) => {
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
    },
    { directory },
  )
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/")
  await page.getByRole("button", { name: "Open settings", exact: true }).click()
  await page.getByRole("tab", { name: "Agents", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("heading", { name: "Agents", exact: true })).toBeVisible()
  await dialog.getByLabel("Select agent").selectOption("plan")
  await expect(dialog.getByLabel("Tool list mode")).toHaveValue(mode)
  await dialog.getByLabel("Filter tools").fill("browser")
  await expect(dialog.locator("[data-tool]")).toHaveCount(5)
  for (const id of browserIDs) {
    const row = dialog.locator(`[data-tool="${id}"]`)
    await row.scrollIntoViewIfNeeded()
    await expect(row).toBeVisible()
    await expect(row.locator('[data-slot="switch-input"]')).not.toBeChecked()
    await row.getByText("Visible", { exact: true }).click()
    await row.getByLabel(`${id} permission`).selectOption("allow")
  }
  for (const viewport of [
    { width: 1280, height: 900, name: "desktop" },
    { width: 390, height: 844, name: "narrow" },
  ]) {
    await page.setViewportSize(viewport)
    const first = dialog.locator('[data-tool="browser_click"]')
    await first.scrollIntoViewIfNeeded()
    const box = await dialog.boundingBox()
    expect(box).toBeTruthy()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
    const measure = () =>
      first.evaluate((element) => ({
        fits: element.scrollWidth <= element.clientWidth,
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflowing: Array.from(element.querySelectorAll<HTMLElement>("*"))
          .filter((child) => child.getBoundingClientRect().right > element.getBoundingClientRect().right)
          .map((child) => ({
            tag: child.tagName,
            className: child.className,
            width: child.clientWidth,
            minWidth: getComputedStyle(child).minWidth,
            whiteSpace: getComputedStyle(child).whiteSpace,
          })),
      }))
    const measurements = await measure()
    await testInfo.attach(`layout-${viewport.name}`, {
      body: JSON.stringify(measurements),
      contentType: "application/json",
    })
    if (!measurements.fits) console.log(`Tool layout overflow: ${JSON.stringify(measurements)}`)
    await expect.poll(measure).toMatchObject({ fits: true })
    const rowBox = await first.boundingBox()
    const permissionBox = await first.getByLabel("browser_click permission").boundingBox()
    expect(rowBox).toBeTruthy()
    expect(permissionBox).toBeTruthy()
    expect(permissionBox!.x + permissionBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width)
    await page.screenshot({ path: testInfo.outputPath(`browser-tool-catalog-${viewport.name}.png`), fullPage: true })
  }
  await dialog.getByRole("button", { name: "Save agent", exact: true }).click()
  await expect.poll(() => agentUpdates().length).toBe(1)
  const saved = agentUpdates().at(-1) as { agent: { plan: { tools: { mode: string; entries: Record<string, unknown> } } } }
  expect(saved.agent.plan.tools.mode).toBe(mode)
  expect(saved.agent.plan.tools.entries.read).toEqual({ visible: true, permission: "allow" })
  for (const id of browserIDs) {
    expect(saved.agent.plan.tools.entries[id]).toEqual({ visible: true, permission: "allow" })
  }
  if (mode === "inherit") {
    await dialog.getByRole("button", { name: "New", exact: true }).click()
    await expect(dialog.getByLabel("Tool list mode")).toHaveValue("inherit")
    await dialog.getByLabel("Filter tools").fill("read")
    const row = dialog.locator('[data-tool="read"]')
    await expect(row.locator('[data-slot="switch-input"]')).toBeChecked()
    await row.getByText("Visible", { exact: true }).click()
    await expect(dialog.getByLabel("Tool list mode")).toHaveValue("inherit")
    await dialog.getByRole("button", { name: "Save agent", exact: true }).click()
    await expect.poll(() => agentUpdates().length).toBe(2)
    const added = agentUpdates().at(-1) as { agent: Record<string, { tools: { mode: string; entries: Record<string, unknown> } }> }
    expect(added.agent["new-agent"].tools).toEqual({ mode: "inherit", entries: { read: { visible: false, permission: "deny" } } })
  }
  expectNoSmokeErrors(errors, [], [])
})
