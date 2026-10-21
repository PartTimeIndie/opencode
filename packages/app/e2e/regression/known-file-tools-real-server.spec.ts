import { expect, test } from "@playwright/test"
import { spawn, execFileSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { trackPageErrors, trackNetworkFailures } from "../utils/errors"

// Controlled SOURCE integration, not installed-desktop or cloud-model evidence.
test.use({
  video: { mode: "on", size: { width: 1280, height: 720 } },
  screenshot: "on",
  viewport: { width: 1280, height: 720 },
})
test.setTimeout(180000)

test("native read-edit-own-write and stale conflict through the real browser and server", async ({
  page,
}, testInfo) => {
  const bun =
    process.platform === "win32"
      ? execFileSync("where.exe", ["bun"], { encoding: "utf8" }).split(/\r?\n/)[0]!.trim()
      : "bun"
  const child = spawn(bun, [path.resolve(import.meta.dirname, "../utils/known-file-tools.worker.ts")], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  })
  let diagnostics = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    diagnostics = `${diagnostics}${chunk}`.slice(-8000)
  })
  let ready: { root: string; worktree: string; serverUrl: string; sessionID: string } | undefined
  try {
    ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`isolated QA worker not ready: ${diagnostics}`)), 125000)
      let output = ""
      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => {
        output += chunk
        const match = /__FILE_KNOWLEDGE_READY__(.+)/.exec(output)
        if (match) {
          clearTimeout(timer)
          resolve(JSON.parse(match[1]!))
        }
      })
      child.once("exit", (code) => {
        clearTimeout(timer)
        reject(new Error(`isolated QA worker exited ${code}: ${diagnostics}`))
      })
    })
    const errors = trackPageErrors(page)
    const network = trackNetworkFailures(page)
    const dirBase64 = base64Encode(ready.worktree)
    await page.addInitScript(
      ({ worktree, serverUrl, sessionID, dirBase64 }) => {
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
      { ...ready, dirBase64 },
    )
    await page.goto(`/${dirBase64}/session/${ready.sessionID}`, { waitUntil: "commit" })
    const composer = page.locator('[data-component="session-composer"]')
    await expect(composer).toBeVisible({ timeout: 90000 })
    const textbox = composer.getByRole("textbox")
    await textbox.pressSequentially(
      "qa-file-normal: Read a.txt, edit it, then make an own confirmed follow-up write.",
      { delay: 20 },
    )
    await textbox.press("Enter")
    await expect(page.getByText("Protected read-edit-own-write flow complete.", { exact: true })).toBeVisible({
      timeout: 60000,
    })
    const target = path.join(ready.worktree, "a.txt")
    expect(await readFile(target, "utf8")).toBe("own confirmed follow-up")
    // Brief stable holds make the real interactions legible in the continuous video.
    await page.waitForTimeout(1000)
    await page.screenshot({ path: testInfo.outputPath("native-file-normal.png"), fullPage: true })
    await textbox.pressSequentially(
      "qa-file-conflict: Read a.txt, then attempt one write after an outside change. Preserve the conflict; no retry.",
      { delay: 20 },
    )
    await textbox.press("Enter")
    await expect(page.getByText("Conflict preserved. No automatic retry.", { exact: true })).toBeVisible({
      timeout: 60000,
    })
    expect(await readFile(target, "utf8")).toBe("human concurrent change")
    const requests = await readFile(path.join(ready.root, "requests.json"), "utf8")
    expect(requests).toContain("Read required")
    expect(requests).toContain("No files were changed")
    await expect(page.getByText("Read required for a.txt; current SHA-256", { exact: false })).toBeVisible()
    await page.waitForTimeout(1000)
    await page.screenshot({ path: testInfo.outputPath("native-file-conflict.png"), fullPage: true })
    expect(errors).toEqual([])
    expect(network).toEqual([])
    await writeFile(
      testInfo.outputPath("acceptance.json"),
      JSON.stringify(
        {
          sourceOnly: true,
          scriptedLocalProvider: true,
          normalFinal: "own confirmed follow-up",
          conflictFinal: "human concurrent change",
          console: errors,
          network,
          sessionID: ready.sessionID,
        },
        null,
        2,
      ),
    )
  } finally {
    await mkdir(testInfo.outputDir, { recursive: true })
    if (ready)
      for (const filename of ["server.log", "requests.json"]) {
        const content = await readFile(path.join(ready.root, filename), "utf8").catch(() => "unavailable")
        await writeFile(testInfo.outputPath(filename), content)
      }
    await writeFile(testInfo.outputPath("worker-stderr.log"), diagnostics)
    child.stdin.end()
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve()
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 10000)
      child.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
})
