import { expect, test, type Page, type TestInfo } from "@playwright/test"
import { execFile, spawn } from "node:child_process"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import path from "node:path"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { trackPageErrors, expectNoSmokeErrors } from "../utils/errors"
import { endFixtureWorkerInput } from "../utils/fixture-worker-input"

/**
 * Visual + runtime verification for session rollback against a REAL opencode
 * server (no mocks): the app calls POST /api/session/:id/rollback, the server
 * restores journaled file writes through the SessionFileMutation journal and
 * retains the reverted message range for recovery until replacement admission.
 *
 * A Bun worker (`utils/real-rollback-seed.worker.ts`) owns the whole fixture:
 * it spawns the isolated server, seeds session/messages/journal directly into
 * the server's SQLite database, and prints a READY marker with all paths. The
 * spec only drives the browser and inspects the worktree on disk.
 */

test.use({ video: "on", screenshot: "on" })
test.setTimeout(240_000)

const specDir = path.dirname(fileURLToPath(import.meta.url))
const rootHolder = { root: "", worktree: "", serverUrl: "", sessionID: "", dataHome: "" }
const worker = { child: undefined as ReturnType<typeof spawn> | undefined }

// Playwright workers may not resolve `bun` through PATH; look it up explicitly.
async function bunExecutable() {
  if (process.platform !== "win32") return "bun"
  return new Promise<string>((resolve) => {
    execFile("where.exe", ["bun"], (error, stdout) => {
      const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0)
      resolve(error || !first ? "bun.exe" : first.trim())
    })
  })
}

test.beforeAll(({}, testInfo) => {
  testInfo.setTimeout(240_000)
  return (async () => {
    // Hold a temp dir of our own for nothing but Playwright artifacts; the
    // worker owns the real fixture tree.
    await mkdtemp(path.join(tmpdir(), "opencode-rollback-visual-spec-"))

    const workerFile = path.resolve(specDir, "../utils/real-rollback-seed.worker.ts")
    const inputFile = path.join(await mkdtemp(path.join(tmpdir(), "opencode-rollback-worker-")), "input.json")
    await writeFile(
      inputFile,
      JSON.stringify({ opencodeDir: path.resolve(specDir, "../../../opencode"), bunExecutable: await bunExecutable() }),
    )
    const child = spawn(await bunExecutable(), [workerFile, inputFile], {
      cwd: path.resolve(specDir, "../.."),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    worker.child = child
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => process.stderr.write(`[worker] ${chunk}`))

    const ready = await new Promise<{
      root: string
      worktree: string
      serverUrl: string
      sessionID: string
      dataHome: string
    }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("rollback fixture worker did not become ready")), 240_000)
      let buffer = ""
      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk
        const match = /__OPENCODE_ROLLBACK_READY__(.+)/.exec(buffer)
        if (match) {
          clearTimeout(timeout)
          resolve(JSON.parse(match[1]!.trim()))
        }
      })
      child.once("exit", (code) => {
        clearTimeout(timeout)
        reject(new Error(`rollback fixture worker exited early with ${code}`))
      })
    })
    rootHolder.root = ready.root
    rootHolder.worktree = ready.worktree
    rootHolder.serverUrl = ready.serverUrl
    rootHolder.sessionID = ready.sessionID
    rootHolder.dataHome = ready.dataHome
  })()
})

test.afterAll(async () => {
  endFixtureWorkerInput(worker.child)
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  await rm(rootHolder.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => undefined)
})

async function readFileText(file: string) {
  try {
    return await readFile(file, "utf8")
  } catch {
    return "<missing>"
  }
}

async function fileExists(file: string) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

async function rollbackScenario(page: Page, testInfo: TestInfo) {
  const errors = trackPageErrors(page)
  const failing: string[] = []
  page.on("response", (response) => {
    if (response.status() >= 400 && response.url().includes("/api/"))
      failing.push(`${response.status()} ${response.url()}`)
  })

  const { worktree, serverUrl, sessionID } = rootHolder
  const dirBase64 = base64Encode(worktree)
  await page.addInitScript(
    ({ serverUrl, worktree, dirBase64, sessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale: "en" }))
      localStorage.setItem("opencode.settings.dat:defaultServerUrl", serverUrl)
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [serverUrl],
          projects: { local: [{ worktree, expanded: true }], [serverUrl]: [{ worktree, expanded: true }] },
          lastProject: { local: worktree, [serverUrl]: worktree },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server: serverUrl, dirBase64, sessionId: sessionID }]),
      )
    },
    { serverUrl, worktree, dirBase64, sessionID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${dirBase64}/session/${sessionID}`, { waitUntil: "commit" })
  const composer = page.locator('[data-component="session-composer"]')
  await expect(composer).toBeVisible({ timeout: 120_000 })

  const message = page.locator('[data-message-id="msg_visual_user_2"]')
  await expect(message).toBeVisible({ timeout: 60_000 })
  await expect(message).toContainText("Please edit tracked.txt")
  await page.screenshot({ path: testInfo.outputPath("rollback-visual-before.png"), fullPage: true })

  await message.locator('[data-component="user-message"]').hover()
  await message.getByRole("button", { name: "Restore message", exact: true }).click()

  // The server restores the journaled file writes; poll the worktree so the
  // restore is observed through real state, not just the UI.
  await expect.poll(async () => readFileText(path.join(worktree, "tracked.txt")), { timeout: 30_000 }).toBe("base")
  await expect.poll(async () => fileExists(path.join(worktree, "created.txt")), { timeout: 30_000 }).toBe(false)

  // The range is hidden, not deleted: it must still support recovery after reload.
  await expect(page.locator('[data-message-id="msg_visual_user_2"]')).toHaveCount(0)
  await expect(page.locator('[data-message-id="msg_visual_assistant_2"]')).toHaveCount(0)
  await expect(page.locator('[data-message-id="msg_visual_user_1"]')).toBeVisible()
  // Rollback must retain the recoverable range until the next prompt commits it.
  // Otherwise the tray's Message/Both actions lose their source immediately.
  await expect(page.locator('[data-component="session-revert-dock"]')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("rollback-visual-after.png"), fullPage: true })

  await page.reload({ waitUntil: "commit" })
  const tray = page.locator('[data-component="session-revert-dock"]')
  const input = composer.locator('[data-component="prompt-input"]')
  await expect(tray).toBeVisible({ timeout: 60_000 })
  await tray.getByRole("button", { name: "Expand rolled back messages", exact: true }).click()
  await composer.getByRole("textbox").fill("")
  await tray.getByRole("button", { name: "Message", exact: true }).click()
  await expect(input).toHaveText("Please edit tracked.txt")
  await expect(input).toBeFocused()
  await expect(message).toHaveCount(0)
  expect(await readFileText(path.join(worktree, "tracked.txt"))).toBe("base")
  await page.screenshot({ path: testInfo.outputPath("rollback-message-desktop.png"), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(input).toBeVisible()
  // Responsive placement remounts the tray in its collapsed state.
  await tray.getByRole("button", { name: "Expand rolled back messages", exact: true }).click()
  await expect(tray.getByRole("button", { name: "Both", exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("rollback-message-mobile.png"), fullPage: true })

  // Both restores the file checkpoint AND full original dialogue, not an empty draft.
  const restoreResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/unrevert"))
  await tray.getByRole("button", { name: "Both", exact: true }).click()
  const restoredHTTP = await restoreResponse
  const restoredBody = await restoredHTTP.json()
  await writeFile(testInfo.outputPath("unrevert-response.json"), JSON.stringify(restoredBody, null, 2))
  await testInfo.attach("unrevert-response", {
    path: testInfo.outputPath("unrevert-response.json"),
    contentType: "application/json",
  })
  if (!restoredHTTP.ok()) {
    await writeFile(testInfo.outputPath("server.log"), await readFile(path.join(rootHolder.root, "server.log"), "utf8"))
  }
  expect(restoredHTTP.ok(), JSON.stringify(restoredBody)).toBe(true)
  expect(restoredBody.revert).toBeUndefined()
  await expect.poll(async () => readFileText(path.join(worktree, "tracked.txt"))).toBe("ours")
  await expect.poll(async () => readFileText(path.join(worktree, "created.txt"))).toBe("created")
  await expect(tray).toHaveCount(0)
  await expect(message).toBeVisible()
  await expect(input).toHaveText("Please edit tracked.txt")

  await page.setViewportSize({ width: 1280, height: 720 })
  await message.locator('[data-component="user-message"]').hover()
  await message.getByRole("button", { name: "Restore message", exact: true }).click()
  await expect(tray).toBeVisible()
  await tray.getByRole("button", { name: "Checkpoint", exact: true }).click()
  await expect(message).toBeVisible()
  await expect(tray).toHaveCount(0)
  expect(await readFileText(path.join(worktree, "tracked.txt"))).toBe("ours")

  // A genuine external edit blocks file rollback without blanking dialogue or
  // silently sending the replacement prompt against the unreverted history.
  await writeFile(path.join(worktree, "tracked.txt"), "external edit")
  await message.locator('[data-component="user-message"]').hover()
  await message.getByRole("button", { name: "Restore message", exact: true }).click()
  await expect(tray).toContainText("Revert blocked by 1 file conflict(s)")
  await expect(message).toBeVisible()
  await expect(composer.getByRole("button", { name: "Send", exact: true })).toBeDisabled()
  const blockedPrompt = await page.request.post(`${serverUrl}/api/session/${sessionID}/prompt`, {
    data: { prompt: { text: "Must not run against unreverted history" }, resume: false },
  })
  expect(blockedPrompt.status()).toBe(409)
  await tray.getByRole("button", { name: "Expand rolled back messages", exact: true }).click()
  await tray.getByRole("button", { name: "Keep files, roll back messages", exact: true }).click()
  await expect(message).toHaveCount(0)
  await expect(composer.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
  expect(await readFileText(path.join(worktree, "tracked.txt"))).toBe("external edit")
  await tray.getByRole("button", { name: "Checkpoint", exact: true }).click()
  await expect(message).toBeVisible()
  await expect(tray).toHaveCount(0)

  // Roll back all the way to the first turn, then really execute a new prompt.
  // The local model transport records the exact request, so stale history cannot
  // hide behind optimistic UI or a mocked prompt endpoint.
  await writeFile(path.join(worktree, "tracked.txt"), "ours")
  const first = page.locator('[data-message-id="msg_visual_user_1"]')
  await first.locator('[data-component="user-message"]').hover()
  await first.getByRole("button", { name: "Restore message", exact: true }).click()
  await expect(tray).toBeVisible()
  await tray.getByRole("button", { name: "Expand rolled back messages", exact: true }).click()
  await tray.getByRole("button", { name: "Message", exact: true }).last().click()
  await expect(input).toHaveText("Please edit tracked.txt")
  await expect(input).toBeFocused()
  await input.press("ControlOrMeta+A")
  await input.press("Backspace")
  await input.pressSequentially("Continue from checkpoint")
  await expect(input).toHaveText("Continue from checkpoint")
  await composer.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByText("QA continuation from checkpoint", { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(tray).toHaveCount(0)
  await expect(first).toHaveCount(0)
  await expect(message).toHaveCount(0)
  const requests = await readFile(path.join(rootHolder.root, "llm-requests.json"), "utf8")
  expect(requests).toContain("Continue from checkpoint")
  expect(requests).not.toContain("Please edit tracked.txt")
  expect(requests).not.toContain("Keep this turn")
  await page.reload({ waitUntil: "commit" })
  await expect(page.getByText("Continue from checkpoint", { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText("QA continuation from checkpoint", { exact: true })).toBeVisible()
  await expect(tray).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath("rollback-continuation-desktop.png"), fullPage: true })

  expect(failing, `unexpected API failures: ${failing.join(", ")}`).toEqual([])
  expectNoSmokeErrors(errors, [], [])
}

test("rollback remains recoverable through reload, Message, Both, Checkpoint and file conflicts", async ({
  page,
}, testInfo) => {
  await rollbackScenario(page, testInfo)
})
