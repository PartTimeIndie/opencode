import { expect, test, type Locator, type Page, type Route } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors, expectNoSmokeErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

test.use({ video: "on", screenshot: "on" })
test.setTimeout(120_000)

const directory = "C:/OpenCode/RuntimeServices"
const projectID = "proj_runtime_services"
const sessionID = "ses_runtime_services"
const server = `http://127.0.0.1:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

test("edits and controls only allowlisted runtime service fields", async ({ page }) => {
  const errors = trackPageErrors(page)
  const patches: unknown[] = []
  const actions: unknown[] = []
  const service = {
    name: "OpenCodeAppDevServer",
    displayName: "OpenCode App Dev Server",
    state: "Running",
    startMode: "Auto",
    description: "Keeps the OpenCode app dev server available.",
    processId: 4242,
    manager: "nssm",
  }
  const detail = {
    ...service,
    configuredStartMode: "automatic",
    application: "C:/Program Files/Bun/bun.exe",
    appDirectory: "C:/GitRepros/opencode/packages/app",
    appParameters: "run dev",
    stdout: "C:/Logs/opencode-app.out.log",
    stderr: "C:/Logs/opencode-app.err.log",
    environmentKeys: ["OPENCODE_CHANNEL"],
  }

  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
  })
  await mockRuntimeServicesPlugin(page)
  await mockRuntimeServicesApi(page, service, detail, patches, actions)
  await configurePage(page)

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  const panel = page.locator(".oc-runtime-services")
  const row = panel.locator('[data-service-name="OpenCodeAppDevServer"]')
  await expectAppVisible(panel)
  await expect(row.locator(".oc-runtime-services__description")).toHaveText(
    "Keeps the OpenCode app dev server available.",
  )
  await expect(row.locator(".oc-runtime-services__status")).toContainText("Running · Auto · NSSM · PID 4242")

  await row.getByRole("button", { name: "Delete", exact: true }).click()
  const deleteDialog = panel.locator(".oc-runtime-services__dialog")
  await expect(deleteDialog.getByRole("heading", { name: "Delete OpenCode App Dev Server?" })).toBeVisible()
  await expectOpaqueDialog(deleteDialog)
  await panel.getByRole("button", { name: "Cancel" }).click()

  await row.getByRole("button", { name: "Revise with agent" }).click()
  const projectDialog = panel.locator(".oc-runtime-services__dialog")
  await expect(projectDialog.getByRole("heading", { name: "Choose project for service session" })).toBeVisible()
  await expectOpaqueDialog(projectDialog)
  await panel.getByRole("button", { name: "Cancel" }).click()

  await row.getByRole("button", { name: "Edit" }).click()
  await expect(row.getByRole("heading", { name: "Edit OpenCode App Dev Server" })).toBeVisible()
  await expect(row.getByLabel("Start mode")).toHaveValue("automatic")
  await expect(row.getByLabel("Start mode").locator('option[value="disabled"]')).toHaveText("Disabled")
  await row.getByPlaceholder("NEW_KEY").fill("FIRST_VALUE")
  await row.getByPlaceholder("New value").fill("one")
  await row.getByRole("button", { name: "Add or replace" }).click()
  await expect(row.getByText("FIRST_VALUE", { exact: true })).toBeVisible()
  await row.getByPlaceholder("NEW_KEY").fill("SECOND_VALUE")
  await row.getByPlaceholder("New value").fill("two")
  await row.getByRole("button", { name: "Add or replace" }).click()
  await expect(row.getByText("SECOND_VALUE", { exact: true })).toBeVisible()
  await row.getByLabel("Description").fill("Updated service description.")
  await row.getByRole("button", { name: "Save changes" }).click()

  await expect.poll(() => patches.length).toBe(1)
  expect(patches[0]).toEqual({
    changes: { description: "Updated service description." },
    environment: { set: { FIRST_VALUE: "one", SECOND_VALUE: "two" }, remove: [] },
  })

  detail.application = "C:/Program Files/Bun/bun-v2.exe"
  await panel.getByRole("button", { name: "Refresh" }).click()
  await row.getByRole("button", { name: "Edit" }).click()
  await expect(row.getByLabel("Application")).toHaveValue("C:/Program Files/Bun/bun-v2.exe")
  await row.getByRole("button", { name: "Cancel" }).click()

  await row.getByRole("button", { name: "Restart" }).click()
  await expect.poll(() => actions.length).toBe(1)
  expect(actions[0]).toEqual({ action: "restart" })
  await expect(panel.locator(".oc-runtime-services__notice")).toContainText("restart completed")
  expectNoSmokeErrors(errors, [], [])
})

test("polls accepted operations and requires acknowledgement before deleting indeterminate evidence", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests = { patches: 0, actions: 0, polls: 0, cleanups: [] as string[] }
  const service = {
    name: "OpenCodeAppDevServer",
    displayName: "OpenCode App Dev Server",
    state: "Running",
    startMode: "Auto",
    description: "Keeps the OpenCode app dev server available.",
    processId: 4242,
    manager: "nssm",
  }
  const detail = {
    ...service,
    configuredStartMode: "automatic",
    application: "C:/Program Files/Bun/bun.exe",
    appDirectory: "C:/GitRepros/opencode/packages/app",
    appParameters: "run dev",
    stdout: "C:/Logs/opencode-app.out.log",
    stderr: "C:/Logs/opencode-app.err.log",
    environmentKeys: [],
  }

  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
  })
  await mockRuntimeServicesPlugin(page)
  await mockRuntimeOperationsApi(page, service, detail, requests)
  await configurePage(page)

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  const panel = page.locator(".oc-runtime-services")
  const row = panel.locator('[data-service-name="OpenCodeAppDevServer"]')
  await expectAppVisible(panel)
  await row.getByRole("button", { name: "Edit" }).click()
  await row.getByLabel("Description").fill("Pending description.")
  await row.getByRole("button", { name: "Save changes" }).click()

  const patchOperation = panel.locator('[data-operation-id="11111111-1111-4111-8111-111111111111"]')
  await expect(patchOperation).toHaveAttribute("data-status", "pending")
  await expect(patchOperation.getByText("Pending — waiting for elevated helper")).toBeVisible()
  await expect(panel.locator(".oc-runtime-services__notice")).toContainText("No success has been recorded")
  await expect(patchOperation.getByRole("button", { name: "Remove evidence" })).toHaveCount(0)
  await expect(patchOperation).toHaveAttribute("data-status", "succeeded", { timeout: 10_000 })
  await expect(panel.locator(".oc-runtime-services__notice")).toContainText("was updated")
  expect(requests.patches).toBe(1)
  expect(requests.polls).toBeGreaterThanOrEqual(2)

  await row.getByRole("button", { name: "Restart" }).click()
  const indeterminate = panel.locator('[data-operation-id="22222222-2222-4222-8222-222222222222"]')
  await expect(indeterminate).toHaveAttribute("data-status", "indeterminate")
  await expect(indeterminate.getByText("Indeterminate — outcome not confirmed")).toBeVisible()
  await expect(indeterminate).toContainText("may still have changed")
  await expect(row).toBeVisible()
  await expect(panel).not.toContainText("restart completed")
  expect(requests.actions).toBe(1)

  await indeterminate.getByRole("button", { name: "Acknowledge uncertainty…" }).click()
  const dialog = panel.getByRole("dialog", { name: "Acknowledge an indeterminate outcome?" })
  await expectOpaqueDialog(dialog)
  const confirm = dialog.getByRole("button", { name: "Acknowledge and delete evidence" })
  await expect(confirm).toBeDisabled()
  await dialog.getByRole("checkbox").check()
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect(indeterminate).toHaveCount(0)
  expect(requests.cleanups).toEqual(["true"])
  await expect(panel).not.toContainText("restart completed")
  expectNoSmokeErrors(errors, [], [])
})

test("rehydrates retained operations when the plugin remounts after reload", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests = { inventories: 0, polls: 0 }
  const service = {
    name: "OpenCodeAppDevServer",
    displayName: "OpenCode App Dev Server",
    state: "Running",
    startMode: "Auto",
    description: "Keeps the OpenCode app dev server available.",
    processId: 4242,
    manager: "nssm",
  }
  const pendingID = "33333333-3333-4333-8333-333333333333"
  const indeterminateID = "44444444-4444-4444-8444-444444444444"

  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
  })
  await mockRuntimeServicesPlugin(page)
  await page.route(/\/plugins\/opencode-runtime-services\/services\/[^/?]+(?:\?|$)/, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const serviceID = url.pathname.split("/").at(-1)
    const input = request.postDataJSON().input
    if (serviceID === "list") return json(route, { services: [service] })
    if (serviceID === "operations") {
      requests.inventories++
      return json(route, [
        {
          id: pendingID,
          status: "pending",
          serviceName: service.name,
          kind: "patch",
          code: "elevation_pending",
          error: "The elevated helper is still running.",
        },
        {
          id: indeterminateID,
          status: "indeterminate",
          serviceName: service.name,
          kind: "action",
          action: "restart",
          code: "elevation_indeterminate",
          error: "The elevated helper outcome is indeterminate.",
        },
      ])
    }
    if (serviceID === "operation" && input.operationID === pendingID) {
      requests.polls++
      return json(route, {
        id: pendingID,
        status: "pending",
        serviceName: service.name,
        kind: "patch",
        code: "elevation_pending",
        error: "The elevated helper is still running.",
      })
    }
    return json(route, { error: "Unexpected retained Runtime Services request" }, 405)
  })
  await configurePage(page)

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const panel = page.locator(".oc-runtime-services")
  await expectAppVisible(panel)
  await expect(panel.locator(`[data-operation-id="${pendingID}"]`)).toHaveAttribute("data-status", "pending")
  await expect(panel.locator(`[data-operation-id="${indeterminateID}"]`)).toHaveAttribute("data-status", "indeterminate")
  await expect(panel.getByText("OpenCode App Dev Server", { exact: true })).toHaveCount(3)

  await page.reload()
  await expectAppVisible(panel)
  await expect(panel.locator(`[data-operation-id="${pendingID}"]`)).toHaveAttribute("data-status", "pending")
  await expect(panel.locator(`[data-operation-id="${indeterminateID}"]`)).toHaveAttribute("data-status", "indeterminate")
  await expect.poll(() => requests.inventories).toBeGreaterThanOrEqual(2)
  await expect.poll(() => requests.polls).toBeGreaterThanOrEqual(1)
  await expect(panel).not.toContainText("completed")
  await expect(panel).not.toContainText("was updated")
  expectNoSmokeErrors(errors, [], [])
})

async function configurePage(page: Page) {
  await page.addInitScript(
    ({ directory, dirBase64, server, sessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true, name: "Runtime Services" }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server, dirBase64, sessionId: sessionID }]),
      )
      localStorage.setItem(
        "opencode.global.dat:layout",
        JSON.stringify({
          dock: {
            schema: 2,
            left: {
              visible: true,
              size: 520,
              tabs: ["runtime-services-app/runtimeServices"],
              active: "runtime-services-app/runtimeServices",
            },
            items: {
              session: { area: "middle", visible: true },
              "runtime-services-app/runtimeServices": { area: "left", visible: true },
            },
          },
        }),
      )
    },
    { directory, dirBase64: base64Encode(directory), server, sessionID },
  )
}

async function mockRuntimeServicesPlugin(page: Page) {
  const root = path.resolve("../../.opencode/plugin-sources/runtime-services-app")
  const body = await fs.readFile(path.join(root, "index.js"), "utf8")
  const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))
  await page.route("**/app/plugins**", (route) =>
    json(route, {
      plugins: [
        {
          id: "runtime-services-app",
          spec: "runtime-services-app",
          version: "1",
          module: "/app/plugin/runtime-services-app/1/index.js",
          hash: "runtime-services",
          capabilities: manifest.opencode.app.capabilities,
          api: manifest.opencode.api,
        },
      ],
    }),
  )
  await page.route("**/app/plugin/runtime-services-app/1/index.js**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body,
    }),
  )
  await page.route("**/app/plugin/runtime-services-app/1/assets/*", async (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      headers: { "access-control-allow-origin": "*" },
      body: await fs.readFile(path.join(root, "assets", path.basename(new URL(route.request().url()).pathname)), "utf8"),
    }),
  )
}

async function mockRuntimeServicesApi(
  page: Page,
  service: Record<string, unknown>,
  detail: Record<string, unknown>,
  patches: unknown[],
  actions: unknown[],
) {
  await page.route(/\/plugins\/opencode-runtime-services\/services\/[^/?]+(?:\?|$)/, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const serviceID = url.pathname.split("/").at(-1)
    const input = request.postDataJSON().input
    const body = input.payload
    if (serviceID === "list") return json(route, { services: [service] })
    if (serviceID === "operations") return json(route, [])
    if (serviceID === "detail") return json(route, detail)
    if (serviceID === "patch") {
      patches.push(body)
      Object.assign(detail, body.changes)
      Object.assign(service, body.changes)
      return json(route, detail)
    }
    if (serviceID === "action") {
      actions.push(body)
      return json(route, { services: [service] })
    }
    return json(route, { error: "Unexpected runtime services request" }, 405)
  })
}

async function mockRuntimeOperationsApi(
  page: Page,
  service: Record<string, unknown>,
  detail: Record<string, unknown>,
  requests: { patches: number; actions: number; polls: number; cleanups: string[] },
) {
  await page.route(/\/plugins\/opencode-runtime-services\/services\/[^/?]+(?:\?|$)/, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const serviceID = url.pathname.split("/").at(-1)
    const input = request.postDataJSON().input
    if (serviceID === "list") return json(route, { services: [service] })
    if (serviceID === "operations") {
      return json(route, requests.polls >= 2 ? [{
        id: "11111111-1111-4111-8111-111111111111",
        status: "succeeded",
        serviceName: service.name,
        kind: "patch",
      }] : [])
    }
    if (serviceID === "operation" && input.operationID === "11111111-1111-4111-8111-111111111111") {
      requests.polls++
      if (requests.polls === 1) {
        return json(route, {
          id: "11111111-1111-4111-8111-111111111111",
          status: "pending",
          code: "elevation_pending",
          error: "The elevated helper is still running.",
        })
      }
      return json(route, {
        id: "11111111-1111-4111-8111-111111111111",
        status: "succeeded",
      })
    }
    if (serviceID === "operation") {
      return json(route, {
        id: "22222222-2222-4222-8222-222222222222",
        status: "indeterminate",
        code: "elevation_indeterminate",
        error: "The elevated helper outcome is indeterminate.",
      })
    }
    if (serviceID === "detail") return json(route, detail)
    if (serviceID === "patch") {
      requests.patches++
      return json(route, {
        success: false,
        code: "elevation_pending",
        error: "The elevated helper has not published a final result yet.",
        operationID: "11111111-1111-4111-8111-111111111111",
      }, 202)
    }
    if (serviceID === "action") {
      requests.actions++
      return json(route, {
        success: false,
        code: "elevation_indeterminate",
        error: "The elevated helper outcome is indeterminate.",
        operationID: "22222222-2222-4222-8222-222222222222",
      }, 202)
    }
    if (serviceID === "cleanup") {
      requests.cleanups.push(input.acknowledgeIndeterminate ? "true" : "")
      return json(route, true)
    }
    return json(route, { error: "Unexpected runtime services request" }, 405)
  })
}

function project() {
  return {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "Runtime Services",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  }
}

function session() {
  return {
    id: sessionID,
    slug: "runtime-services-qa",
    projectID,
    directory,
    title: "Runtime Services QA",
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

function provider() {
  return {
    all: [{ id: "opencode", name: "OpenCode", models: { "gpt-fast": { id: "gpt-fast", name: "GPT Fast" } } }],
    connected: ["opencode"],
    default: { providerID: "opencode", modelID: "gpt-fast" },
  }
}

function json(route: Route, body: unknown, status = 200) {
  const service = new URL(route.request().url()).pathname.startsWith("/plugins/opencode-runtime-services/services/")
  const error = service && body && typeof body === "object" && "success" in body && body.success === false
  const payload = service ? { ok: true, data: error ? { ...body, ok: false, status } : { ok: true, data: body } } : body
  return route.fulfill({
    status: service ? 200 : status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(payload),
  })
}

async function expectOpaqueDialog(dialog: Locator) {
  await expect(dialog).toBeVisible()
  expect(await dialog.evaluate((node) => {
    const color = getComputedStyle(node).backgroundColor
    if (color === "transparent") return 0
    const rgba = color.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([^)]+)\)$/)
    return rgba ? Number(rgba[1]) : 1
  })).toBe(1)
}
