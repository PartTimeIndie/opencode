import assert from "node:assert/strict"
import { mkdir, readFile } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

// Manual Windows installed-app QA, not CI and not proof that an OS viewer opened.
// Navigation uses the typed bridge; CDP only inspects and clicks the requested link.
export function parseLocalFileLinkQAArgs(args) {
  const { values } = parseArgs({
    args,
    options: {
      session: { type: "string" },
      directory: { type: "string" },
      label: { type: "string" },
      href: { type: "string" },
      screenshot: { type: "string" },
      click: { type: "boolean", default: false },
    },
  })
  if (
    !values.session?.startsWith("ses_") ||
    !values.directory ||
    !isAbsolute(values.directory) ||
    !values.label ||
    !values.href ||
    !values.screenshot
  ) {
    throw new Error(
      "Usage: node scripts/verify-local-file-links.mjs --session <id> --directory <absolute-path> --label <link-text> --href <file-url> --screenshot <output.png> [--click]",
    )
  }
  if (!URL.canParse(values.href) || new URL(values.href).protocol !== "file:" || new URL(values.href).hostname) {
    throw new Error("Expected href must be a local file URL")
  }
  if (!values.screenshot.toLowerCase().endsWith(".png")) throw new Error("Screenshot output must be a PNG file")
  return {
    sessionID: values.session,
    directory: values.directory,
    label: values.label,
    href: new URL(values.href).href,
    screenshot: resolve(values.screenshot),
    click: values.click,
  }
}

export function sessionOpenAction(route) {
  if (route?.type !== "session" || typeof route.sessionId !== "string" || typeof route.dir !== "string") return
  return { type: "session.open", sessionID: route.sessionId, directory: route.dir }
}

export async function verifyLocalFileLink(input) {
  const { chromium } = await import("playwright-core")
  const bridge = JSON.parse(
    await readFile(
      process.env.OPENCODE_DESKTOP_TESTING_TOKEN_FILE ??
        join(process.env.APPDATA, "ai.opencode.desktop", "desktop-testing.json"),
      "utf8",
    ),
  )
  const request = async (path, action) => {
    const response = await fetch(`${bridge.url}${path}`, {
      method: action ? "POST" : "GET",
      headers: { authorization: `Bearer ${bridge.token}`, ...(action ? { "content-type": "application/json" } : {}) },
      ...(action ? { body: JSON.stringify({ action }) } : {}),
    })
    if (!response.ok) throw new Error(`Desktop bridge request failed: ${response.status}`)
    return response.json()
  }
  const status = await request("/status")
  const original = sessionOpenAction(status.renderer?.route)
  // Do not leave the user on a different screen that this helper cannot restore.
  if (!original) throw new Error("Open a Session first so QA can restore the original route")
  const browser = await chromium.connectOverCDP(status.cdp.cdpUrl)
  try {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url().startsWith("oc://renderer"))
    if (!page) throw new Error("Desktop renderer not found")
    const errors = []
    const failedRequests = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    page.on("requestfailed", (request) => {
      if (!request.failure()?.errorText.includes("ERR_ABORTED")) failedRequests.push(request.failure()?.errorText)
    })
    await request("/action", { type: "session.open", sessionID: input.sessionID, directory: input.directory })
    const opened = sessionOpenAction((await request("/status")).renderer?.route)
    assert.equal(opened?.sessionID, input.sessionID, "Desktop did not select the requested Session")
    assert.equal(normalize(opened.directory).toLowerCase(), normalize(input.directory).toLowerCase())
    const link = page.locator("a.external-link").filter({ hasText: input.label, visible: true }).last()
    await link.waitFor({ state: "visible" })
    await link.scrollIntoViewIfNeeded()
    await mkdir(dirname(input.screenshot), { recursive: true })
    await page.screenshot({ path: input.screenshot })
    const href = await link.getAttribute("href")
    assert.equal(href, input.href)
    if (input.click) await link.click()
    assert.deepEqual(errors, [])
    assert.deepEqual(failedRequests, [])
    console.log(
      JSON.stringify(
        {
          href,
          screenshot: input.screenshot,
          errors,
          failedRequests,
          clickDispatched: input.click,
          osViewer: input.click ? "manual-confirmation-required" : "not-tested",
        },
        null,
        2,
      ),
    )
  } finally {
    try {
      await request("/action", original)
      const restored = sessionOpenAction((await request("/status")).renderer?.route)
      assert.equal(restored?.sessionID, original.sessionID, "Original Session was not restored")
      assert.equal(normalize(restored.directory).toLowerCase(), normalize(original.directory).toLowerCase())
    } finally {
      // Playwright disconnects this CDP client; it does not close the attached app.
      await browser.close()
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await verifyLocalFileLink(parseLocalFileLinkQAArgs(process.argv.slice(2)))
}
