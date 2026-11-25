import { readFileSync } from "node:fs"
import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/Studio"
const alias = "c:\\opencode\\studio\\.\\"
const other = "D:/OpenCode/Studio"
const icon = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

async function configureNavigator(page: Page, directory: string, worktrees: string[]) {
  const plugin = "session-navigator-app"
  const module = `/app/plugin/${plugin}/1/app.js`
  await page.route("**/app/plugins**", (route) =>
    route.fulfill({
      headers: { "access-control-allow-origin": "*" },
      json: { plugins: [{ id: plugin, spec: plugin, version: "1", module, hash: "navigator" }] },
    }),
  )
  const source = readFileSync(new URL("../../../../.opencode/plugins/session-navigator-app/index.js", import.meta.url), "utf8")
  await page.route(`**${module}**`, (route) =>
    route.fulfill({ headers: { "access-control-allow-origin": "*" }, contentType: "text/javascript", body: source }),
  )
  await page.addInitScript(
    ({ directory, worktrees, item }) => {
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: worktrees.map((worktree) => ({ worktree })) }, lastProject: { local: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:layout",
        JSON.stringify({
          dock: {
            left: { visible: true, size: 300, tabs: [item], active: item },
            items: { [item]: { area: "left", visible: true } },
          },
        }),
      )
    },
    { directory, worktrees, item: `${plugin}/sessionNavigator` },
  )
  await page.setViewportSize({ width: 1440, height: 900 })
}

test("project Settings saves the chosen image and updates the Navigator without reloading", async ({ page }) => {
  const first = { id: "proj-a", worktree: directory, name: "Studio", time: { created: 1, updated: 2 }, sandboxes: [] }
  const session = {
    id: "ses_studio",
    slug: "studio",
    title: "Studio session",
    directory,
    projectID: first.id,
    version: "dev",
    time: { created: 1, updated: 2 },
  }
  await mockOpenCodeServer(page, {
    directory,
    project: [first, { ...first, id: "proj-alias", worktree: alias }, { ...first, id: "proj-b", worktree: other }],
    provider: { all: [], connected: [], default: {} },
    sessions: [session],
    pageMessages: () => ({ items: [] }),
  })
  await configureNavigator(page, directory, [directory, other])
  await page.route("**/experimental/session**", (route) =>
    route.fulfill({
      headers: { "access-control-allow-origin": "*" },
      json: new URL(route.request().url()).searchParams.has("directory") ? [] : [{ ...session, directory: alias }],
    }),
  )
  const writes: string[] = []
  await page.route((url) => url.pathname === "/project/proj-a", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback()
    const patch = route.request().postDataJSON()
    writes.push(patch.icon.override)
    await route.fulfill({ json: { ...first, icon: patch.icon } })
  })
  await page.goto(`/${base64Encode(directory)}/session/${session.id}`)
  const navigator = page.locator(".oc-session-nav")
  const header = navigator.locator(`.oc-session-nav__project-toggle[title="${directory}"]`)
  const otherHeader = navigator.locator(`.oc-session-nav__project-toggle[title="${other}"]`)
  const recentBadge = navigator.locator(
    `.oc-session-nav__session[data-session-id="${session.id}"] .oc-session-nav__session-main--project .oc-session-nav__avatar`,
  )
  await expect(header).toContainText(`Studio — ${directory}`)
  await expect(otherHeader).toContainText(`Studio — ${other}`)
  await expect(recentBadge).toHaveText("S")
  await page.getByRole("button", { name: "Open settings" }).click()
  const settings = page.locator('[data-action="settings-project-icons"]')
  await expect(settings.getByRole("button", { name: /^Edit Studio/ })).toHaveCount(2)
  const edit = settings.getByRole("button", { name: `Edit Studio (${directory})`, exact: true })
  const title = page.getByRole("heading", { name: "Edit project" })
  await edit.click()
  await expect(title).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(title).toBeHidden()
  await edit.click()
  await page.locator("#icon-upload").setInputFiles({
    name: "studio.png",
    mimeType: "image/png",
    buffer: Buffer.from(icon.split(",")[1]!, "base64"),
  })
  await expect(page.getByRole("img", { name: "Project icon" })).toHaveAttribute("src", icon)
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(title).toBeHidden()
  await expect(settings).toBeVisible()
  expect(writes).toEqual([icon])
  await expect(settings.locator(`img[src="${icon}"]`)).toHaveCount(1)
  await expect(header.locator("img")).toHaveAttribute("src", icon)
  await expect(recentBadge.locator("img")).toHaveAttribute("src", icon)
  await expect(otherHeader.locator("img")).toHaveCount(0)
})

test("a folder without its own project saves and clears its icon on the canonical directory", async ({ page }) => {
  const real = "E:/Projects/Workshop"
  const junction = "C:/Projects/Workshop"
  const missing = "C:/task/workspace"
  const session = {
    id: "ses_workshop",
    slug: "workshop",
    title: "Workshop session",
    directory: junction,
    projectID: "global",
    version: "dev",
    time: { created: 1, updated: 2 },
  }
  await mockOpenCodeServer(page, {
    directory: real,
    project: { id: "global", worktree: "/", time: { created: 1, updated: 2 }, sandboxes: [], sessionDirectories: [junction] },
    provider: { all: [], connected: [], default: {} },
    sessions: [session],
    pageMessages: () => ({ items: [] }),
  })
  await configureNavigator(page, real, [junction, real, missing])
  await page.route((url) => url.pathname === "/project/resolve", (route) => {
    const { directories } = route.request().postDataJSON() as { directories: string[] }
    return route.fulfill({ json: directories.map((directory) => ({
      directory,
      real: directory === junction ? real : directory,
      exists: directory !== missing,
    })) })
  })
  const canonicalSession = { ...session, id: "ses_workshop_current", directory: real, title: "Current Workshop session" }
  await page.route("**/experimental/session**", (route) => {
    const directory = new URL(route.request().url()).searchParams.get("directory")
    const sessions = directory === junction ? [session] : directory === real ? [canonicalSession] : []
    return route.fulfill({ json: sessions })
  })
  const writes: { directory: string; url?: string }[] = []
  await page.route((url) => url.pathname === "/project/directory-icons", (route) => route.fulfill({ json: [] }))
  await page.route((url) => url.pathname === "/project/directory-icon", (route) => {
    expect(route.request().method()).toBe("PUT")
    const body = route.request().postDataJSON() as (typeof writes)[number]
    writes.push(body)
    return route.fulfill({ json: { directory: real.toLowerCase(), ...(body.url ? { icon: { override: body.url } } : {}) } })
  })

  await page.goto(`/${base64Encode(real)}/session/${session.id}`)
  const nav = page.locator(".oc-session-nav")
  const headers = nav.locator(".oc-session-nav__project-toggle")
  const project = nav.locator(".oc-session-nav__project")
  const header = project.locator(`.oc-session-nav__project-toggle[title="${real}"]`)
  await expect(headers).toHaveCount(1)
  await expect(header).toContainText("Workshop")
  await header.click()
  await expect(project.locator(`[data-session-id="${session.id}"]`)).toBeVisible()
  await expect(project.locator(`[data-session-id="${canonicalSession.id}"]`)).toBeVisible()
  await page.getByRole("button", { name: "Open settings" }).click()
  const settings = page.locator('[data-action="settings-project-icons"]')
  const edit = settings.getByRole("button", { name: `Edit Workshop (${real})`, exact: true })
  const title = page.getByRole("heading", { name: "Edit project" })
  const save = page.getByRole("button", { name: "Save", exact: true })
  await expect(settings.getByRole("button", { name: /^Edit / })).toHaveCount(1)
  await edit.click()
  await page.locator("#icon-upload").setInputFiles({
    name: "workshop.png",
    mimeType: "image/png",
    buffer: Buffer.from(icon.split(",")[1]!, "base64"),
  })
  const preview = page.getByRole("img", { name: "Project icon" })
  await expect(preview).toHaveAttribute("src", icon)
  await save.click()
  await expect(title).toBeHidden()
  await expect(settings.locator(`img[src="${icon}"]`)).toHaveCount(1)
  await expect(header).toContainText("Workshop")
  await expect(header.locator("img")).toHaveAttribute("src", icon)

  await edit.click()
  await preview.hover()
  await preview.click()
  await expect(preview).toHaveCount(0)
  await save.click()
  await expect(title).toBeHidden()
  await expect(settings.locator(`img[src="${icon}"]`)).toHaveCount(0)
  await expect(header.locator("img")).toHaveCount(0)
  expect(writes).toEqual([{ directory: real, url: icon }, { directory: real }])
})

test("Navigator scopes same-ID checkouts and queries a verified alias by its stored path", async ({ page }) => {
  const primary = "E:/Projects/Studio"
  const junction = "C:/Projects/Studio"
  const clone = "E:/Clones/Studio"
  const unlisted = "D:/Clones/Studio"
  const time = { created: 1, updated: 2 }
  const session = (id: string, directory: string) => ({ id, directory, slug: id, title: id, projectID: "shared", version: "dev", time })
  const primaryRow = session("ses_primary", primary)
  const aliasRow = session("ses_alias", junction)
  const cloneRow = session("ses_clone", clone)
  const unlistedRow = session("ses_unlisted", unlisted)
  await mockOpenCodeServer(page, {
    directory: primary,
    project: { id: "shared", worktree: primary, time, sandboxes: [], sessionDirectories: [primary, junction, clone, unlisted] },
    provider: { all: [], connected: [], default: {} },
    sessions: [primaryRow, aliasRow, cloneRow, unlistedRow],
    pageMessages: () => ({ items: [] }),
  })
  await configureNavigator(page, primary, [primary, clone])
  await page.route((url) => url.pathname === "/project/resolve", (route) => {
    const { directories } = route.request().postDataJSON() as { directories: string[] }
    return route.fulfill({ json: directories.map((directory) => ({ directory, real: directory === junction ? primary : directory, exists: true })) })
  })
  const requests: string[] = []
  await page.route("**/experimental/session**", (route) => {
    const scoped = new URL(route.request().url()).searchParams.get("directory")
    if (scoped) requests.push(scoped)
    // Return wrong-checkout rows even for scoped requests to exercise the Navigator's own guard.
    const json = scoped === junction ? [aliasRow] : scoped === primary ? [primaryRow, cloneRow, unlistedRow] :
      scoped === clone ? [cloneRow, primaryRow] : [primaryRow, aliasRow, cloneRow, unlistedRow]
    return route.fulfill({ json })
  })
  await page.goto(`/${base64Encode(primary)}/session/${primaryRow.id}`)
  const projects = page.locator(".oc-session-nav__project")
  const toggle = (directory: string) => page.locator(`.oc-session-nav__project-toggle[title="${directory}"]`)
  const primaryGroup = projects.filter({ has: toggle(primary) })
  const cloneGroup = projects.filter({ has: toggle(clone) })
  await expect(projects).toHaveCount(2)
  await toggle(primary).click()
  await toggle(clone).click()
  const rows = (group: ReturnType<typeof projects.filter>) => group.locator("[data-session-id]")
  await expect(rows(primaryGroup)).toHaveCount(2)
  await expect(rows(cloneGroup)).toHaveCount(1)
  await expect(primaryGroup.locator(`[data-session-id="${aliasRow.id}"]`)).toBeVisible()
  await expect(primaryGroup.locator(`[data-session-id="${primaryRow.id}"]`)).toBeVisible()
  await expect(cloneGroup.locator(`[data-session-id="${cloneRow.id}"]`)).toBeVisible()
  expect(new Set(requests)).toEqual(new Set([primary, clone, junction]))

  await page.route((url) => url.pathname === `/session/${primaryRow.id}`, (route) => {
    if (route.request().method() !== "PATCH") return route.fallback()
    return route.fulfill({ json: { ...primaryRow, time: { ...time, archived: 3 } } })
  })
  const current = primaryGroup.locator(`[data-session-id="${primaryRow.id}"]`)
  await current.hover()
  await current.getByRole("button", { name: "Archive" }).click()
  const tab = page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${aliasRow.id}"]`)
  await expect(tab.getByRole("tab")).toHaveAttribute("aria-selected", "true")
  await expect(page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${cloneRow.id}"]`)).toHaveCount(0)
})
