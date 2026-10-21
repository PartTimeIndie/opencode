import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors, expectNoSmokeErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/PermissionToast"
const projectID = "proj_permission_toast"
const sourceID = "ses_permission_source"
const targetID = "ses_permission_target"
const requestID = "per_permission_target"

const permissionRequest = () => ({
  id: requestID,
  sessionID: targetID,
  action: "bash",
  resources: ["bun test"],
  metadata: {},
})

const session = (id: string, title: string) => ({
  id,
  slug: id,
  projectID,
  directory,
  title,
  version: "dev",
  time: { created: 1700000000000, updated: 1700000000000 },
})

async function setup(
  page: Page,
  replies: Array<{ sessionID: string; requestID: string; body: unknown }>,
  options?: {
    requests?: ReturnType<typeof permissionRequest>[]
    onPermissionReply?: (reply: { sessionID: string; requestID: string; body: unknown }) => unknown
    emitSettled?: boolean
  },
) {
  const requests = options?.requests ?? [permissionRequest()]
  let initialEventsSent = false
  let settled: { sessionID: string; requestID: string; body: unknown } | undefined
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "permission-toast",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "test-model": { id: "test-model", name: "Test model", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "test-model" },
    },
    sessions: [session(sourceID, "Permission source"), session(targetID, "Permission target")],
    pageMessages: () => ({ items: [] }),
    config: () => ({ permission: "ask", access_control: { mode: "ask" } }),
    permissions: () => requests,
    eventRetry: options?.emitSettled ? 10 : undefined,
    events: () => {
      if (initialEventsSent) {
        if (!settled) return []
        const reply = settled
        settled = undefined
        return [
          {
            directory,
            payload: {
              id: `evt_${reply.requestID}_replied`,
              type: "permission.v2.replied",
              properties: { sessionID: reply.sessionID, requestID: reply.requestID, reply: "once" },
            },
          },
        ]
      }
      initialEventsSent = true
      return requests.map((request) => ({
        directory,
        payload: {
          id: `evt_${request.id}`,
          type: "permission.v2.asked",
          properties: request,
        },
      }))
    },
    onPermissionReply: (reply) => {
      replies.push(reply)
      return options?.onPermissionReply?.(reply)
    },
  })

  await page.addInitScript(
    ({ directory }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
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

  return {
    settle(requestID: string) {
      settled = { sessionID: targetID, requestID, body: { reply: "once" } }
    },
  }
}

async function openPermissionToast(page: Page) {
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`, { waitUntil: "commit" })
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0)
  await expectAppVisible(page.getByText("Permission required"))
  await expectAppVisible(page.getByText("bash: bun test"))
  await expectAppVisible(page.getByRole("button", { name: "Go to session" }))
  await expectAppVisible(page.getByRole("button", { name: "Deny" }))
  await expectAppVisible(page.getByRole("button", { name: "Allow always" }))
  await expectAppVisible(page.getByRole("button", { name: "Allow once" }))
  await expect(page.getByRole("button", { name: "Dismiss" })).toHaveCount(1)

  const layout = await page.locator('[data-component="toast-v2"], [data-component="toast"]').evaluate((toast) => {
    const container = toast.getBoundingClientRect()
    const actions = [...toast.querySelectorAll<HTMLElement>('button, [role="button"]')].map((element) =>
      element.getBoundingClientRect(),
    )
    return {
      insideToast: actions.every(
        (rect) =>
          rect.left >= container.left &&
          rect.right <= container.right &&
          rect.top >= container.top &&
          rect.bottom <= container.bottom,
      ),
      insideViewport: container.left >= 0 && container.right <= innerWidth && container.top >= 0 && container.bottom <= innerHeight,
      actionsDoNotOverlap: actions.every((rect, index) =>
        actions.slice(index + 1).every(
          (other) =>
            rect.right <= other.left || other.right <= rect.left || rect.bottom <= other.top || other.bottom <= rect.top,
        ),
      ),
    }
  })
  expect(layout).toEqual({ insideToast: true, insideViewport: true, actionsDoNotOverlap: true })
}

for (const decision of [
  { label: "Deny", reply: "reject" },
  { label: "Allow always", reply: "always" },
  { label: "Allow once", reply: "once" },
] as const) {
  test(`answers an off-session permission with ${decision.reply}`, async ({ page }) => {
    const errors = trackPageErrors(page)
    const replies: Array<{ sessionID: string; requestID: string; body: unknown }> = []
    await setup(page, replies)
    await page.setViewportSize({ width: 1280, height: 720 })
    await openPermissionToast(page)

    if (decision.reply === "reject") {
      await page.screenshot({ path: "test-results/permission-toast-desktop.png", fullPage: true })
    }
    await page.getByRole("button", { name: decision.label }).click()

    await expect.poll(() => replies).toEqual([
      { sessionID: targetID, requestID, body: { reply: decision.reply } },
    ])
    expectNoSmokeErrors(errors, [], [])
  })
}

test("puts the goal and agent action ahead of a technical reviewer outage", async ({ page }) => {
  const errors = trackPageErrors(page)
  await setup(page, [], {
    requests: [
      {
        ...permissionRequest(),
        metadata: {
          "$opencode.permission.safety_review": {
            cause: "reviewers_unavailable",
            risk: "high",
            context: { goal: "Fix only the requested translation", action: "Inspect the localization entry" },
            attempts: [
              { role: "primary", model: "test/primary", status: "transport_error" },
              { role: "fallback", model: "test/fallback", status: "malformed" },
            ],
          },
        },
      },
    ],
  })
  await page.route("**/api/session/*/held-inputs**", (route) => route.fulfill({ json: { data: [] } }))
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`, { waitUntil: "commit" })

  await expectAppVisible(page.getByText("Fix only the requested translation"))
  await expectAppVisible(page.getByText("Inspect the localization entry"))
  await expectAppVisible(page.getByText(/deny it so the agent looks for a different authorized approach/))
  await expect(page.getByText("Safety review unavailable")).toHaveCount(1)
  await expect(page.getByText("The configured reviewers did not provide a verdict.")).toBeHidden()
  await page.screenshot({ path: "test-results/permission-toast-technical-desktop.png", fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expectAppVisible(page.getByText("Fix only the requested translation"))
  await page.screenshot({ path: "test-results/permission-toast-technical-mobile.png", fullPage: true })
  expectNoSmokeErrors(errors, [], [])
})

test("keeps coarse permission and legacy toast controls touchable at mobile and tablet widths", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  const page = await context.newPage()
  const errors = trackPageErrors(page)
  const replies: Array<{ sessionID: string; requestID: string; body: unknown }> = []
  await setup(page, replies)
  await openPermissionToast(page)

  const permissionToast = page.locator('[data-component="toast-v2"]').filter({ hasText: "Permission required" })
  const allowOnce = permissionToast.getByRole("button", { name: "Allow once" })
  await allowOnce.evaluate((element) => {
    element.textContent = "OK"
  })
  await page.evaluate(() => {
    const region = document.createElement("div")
    region.dataset.component = "toast-region"
    region.dataset.testid = "legacy-coarse-toast-region"
    const toast = document.createElement("div")
    toast.dataset.component = "toast"
    toast.dataset.testid = "legacy-coarse-toast"
    const action = document.createElement("button")
    action.dataset.slot = "toast-action"
    action.textContent = "OK"
    const dismiss = document.createElement("button")
    dismiss.dataset.slot = "toast-close-button"
    dismiss.ariaLabel = "Dismiss legacy toast"
    dismiss.textContent = "×"
    toast.append(action, dismiss)
    region.append(toast)
    document.body.append(region)
  })

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport)
    const geometry = await page.evaluate(() => {
      const measure = (selector: string) => {
        const toast = document.querySelector<HTMLElement>(selector)
        if (!toast) return
        const rect = toast.getBoundingClientRect()
        return {
          width: rect.width,
          insideViewport:
            rect.left >= 0 &&
            rect.right <= innerWidth &&
            rect.top >= 0 &&
            rect.bottom <= innerHeight,
          controls: [...toast.querySelectorAll<HTMLElement>('button, [role="button"]')].map((control) => {
            const controlRect = control.getBoundingClientRect()
            return {
              label: control.getAttribute("aria-label") ?? control.textContent?.trim(),
              width: controlRect.width,
              height: controlRect.height,
            }
          }),
        }
      }
      return {
        v2: measure('[data-component="toast-v2"]'),
        legacy: measure('[data-testid="legacy-coarse-toast"]'),
      }
    })

    expect(geometry.v2?.width).toBeLessThanOrEqual(320)
    expect(geometry.legacy?.width).toBeLessThanOrEqual(400)
    expect(geometry.v2?.insideViewport).toBe(true)
    expect(geometry.legacy?.insideViewport).toBe(true)
    expect(geometry.v2?.controls.length).toBeGreaterThan(0)
    expect(geometry.legacy?.controls.length).toBe(2)
    for (const control of [...(geometry.v2?.controls ?? []), ...(geometry.legacy?.controls ?? [])]) {
      // Fractional viewport/layout scaling can report 43.9999 for a CSS 44px target.
      expect(Math.ceil(control.width), `${control.label} width at ${viewport.width}px`).toBeGreaterThanOrEqual(44)
      expect(Math.ceil(control.height), `${control.label} height at ${viewport.width}px`).toBeGreaterThanOrEqual(44)
    }
  }

  await page.getByTestId("legacy-coarse-toast-region").evaluate((element) => element.remove())
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: "test-results/permission-toast-mobile.png", fullPage: true })
  await permissionToast.getByRole("button", { name: "OK", exact: true }).tap()

  await expect.poll(() => replies).toEqual([
    { sessionID: targetID, requestID, body: { reply: "once" } },
  ])
  expectNoSmokeErrors(errors, [], [])
  await context.close()
})

test("dismisses a coarse permission toast by touch without replying", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  const page = await context.newPage()
  const errors = trackPageErrors(page)
  const replies: Array<{ sessionID: string; requestID: string; body: unknown }> = []
  await setup(page, replies)
  await openPermissionToast(page)

  const permissionToast = page.locator('[data-component="toast-v2"]').filter({ hasText: "Permission required" })
  const dismiss = permissionToast.getByRole("button", { name: "Dismiss" })
  await dismiss.focus()
  const dismissFocus = await dismiss.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const toast = element.closest<HTMLElement>('[data-component="toast-v2"]')?.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      active: document.activeElement === element,
      insideToast:
        !!toast &&
        rect.left >= toast.left &&
        rect.right <= toast.right &&
        rect.top >= toast.top &&
        rect.bottom <= toast.bottom,
      insetRing: style.outlineStyle === "none" && style.boxShadow.includes("inset"),
    }
  })
  expect(dismissFocus).toEqual({ active: true, insideToast: true, insetRing: true })
  await dismiss.tap()
  await expect(permissionToast).toHaveCount(0)
  expect(replies).toEqual([])
  expectNoSmokeErrors(errors, [], [])
  await context.close()
})

test("keeps concurrent coarse permission toasts inside the safe viewport and scrollable", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 360 },
    hasTouch: true,
    isMobile: true,
  })
  const page = await context.newPage()
  const errors = trackPageErrors(page)
  const replies: Array<{ sessionID: string; requestID: string; body: unknown }> = []
  await setup(page, replies, {
    requests: Array.from({ length: 3 }, (_, index) => ({
      ...permissionRequest(),
      id: `${requestID}_${index}`,
      resources: [`bun test --filter mobile-${index}`],
    })),
  })

  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`, { waitUntil: "commit" })
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0)
  await expect(page.locator('[data-component="toast-v2"]')).toHaveCount(3)
  await expect(page.getByText("bun test --filter mobile-2")).toBeAttached()
  const toastList = page.locator('[data-slot="toast-v2-list"]')
  await expect.poll(() => toastList.evaluate((list) => list.scrollHeight > list.clientHeight)).toBe(true)
  const geometry = await page.locator('[data-component="toast-v2-region"]').evaluate((region) => {
    const list = region.querySelector<HTMLElement>('[data-slot="toast-v2-list"]')
    const regionRect = region.getBoundingClientRect()
    const listRect = list?.getBoundingClientRect()
    return {
      regionInsideViewport:
        regionRect.left >= 0 &&
        regionRect.right <= innerWidth &&
        regionRect.top >= 0 &&
        regionRect.bottom <= innerHeight,
      listInsideRegion:
        !!listRect &&
        listRect.left >= regionRect.left &&
        listRect.right <= regionRect.right &&
        listRect.top >= regionRect.top &&
        listRect.bottom <= regionRect.bottom,
      scrollable: !!list && list.scrollHeight > list.clientHeight,
      overflowX: list ? getComputedStyle(list).overflowX : undefined,
      overflowY: list ? getComputedStyle(list).overflowY : undefined,
    }
  })

  expect(geometry).toEqual({
    regionInsideViewport: true,
    listInsideRegion: true,
    scrollable: true,
    overflowX: "hidden",
    overflowY: "auto",
  })
  await toastList.evaluate((list) => {
    list.scrollTop = list.scrollHeight
  })
  await expectAppVisible(
    page
      .locator('[data-component="toast-v2"]')
      .filter({ hasText: "bun test --filter mobile-2" })
      .getByRole("button", { name: "Allow once" }),
  )
  expect(replies).toEqual([])
  expectNoSmokeErrors(errors, [], [])
  await context.close()
})

test("dismisses only the matching toast when concurrent permission settles", async ({ page }) => {
  const errors = trackPageErrors(page)
  const replies: Array<{ sessionID: string; requestID: string; body: unknown }> = []
  const events = await setup(page, replies, {
    requests: [permissionRequest(), { ...permissionRequest(), id: `${requestID}_second`, resources: ["bun typecheck"] }],
    emitSettled: true,
  })
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`, { waitUntil: "commit" })
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0)

  const testToast = page
    .locator('[data-component="toast-v2"], [data-component="toast"]')
    .filter({ hasText: "bash: bun test" })
  const typecheckToast = page
    .locator('[data-component="toast-v2"], [data-component="toast"]')
    .filter({ hasText: "bash: bun typecheck" })
  await expectAppVisible(testToast)
  await expectAppVisible(typecheckToast)
  events.settle(requestID)

  await expect(testToast).toHaveCount(0)
  await expectAppVisible(typecheckToast)
  await expectAppVisible(typecheckToast.getByRole("button", { name: "Allow once" }))
  expect(replies).toEqual([])
  expectNoSmokeErrors(errors, [], [])
})

test("restores direct permission actions after a failed reply", async ({ page }) => {
  const replies: Array<{ sessionID: string; requestID: string; body: unknown }> = []
  await setup(page, replies, {
    onPermissionReply: () => (replies.length === 1 ? { status: 500, body: { message: "Try again" } } : undefined),
  })
  await page.setViewportSize({ width: 1280, height: 720 })
  await openPermissionToast(page)

  await page.getByRole("button", { name: "Allow once" }).click()

  await expectAppVisible(page.getByText("Request failed"))
  await expectAppVisible(page.getByRole("button", { name: "Allow once" }))
  await page.getByRole("button", { name: "Allow once" }).click()
  await expect.poll(() => replies).toHaveLength(2)
})

test("keeps session navigation available without replying", async ({ page }) => {
  const errors = trackPageErrors(page)
  const replies: Array<{ sessionID: string; requestID: string; body: unknown }> = []
  await setup(page, replies)
  await page.setViewportSize({ width: 1280, height: 720 })
  await openPermissionToast(page)

  await page.getByRole("button", { name: "Go to session" }).click()

  await expectAppVisible(page.getByRole("heading", { name: "Permission target" }))
  expect(replies).toEqual([])
  expectNoSmokeErrors(errors, [], [])
})
