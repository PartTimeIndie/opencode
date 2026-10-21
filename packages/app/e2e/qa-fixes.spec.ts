import { test, expect } from "@playwright/test"
import { writeFileSync } from "node:fs"

const URL = process.env.QA_URL || "http://localhost:4444"

test.describe("Visual QA - opencode UI fixes", () => {
  test("desktop 1280x720 - capture state", async ({ page }) => {
    const logs: string[] = []
    const errs: string[] = []
    const net: string[] = []
    page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`))
    page.on("pageerror", (e) => errs.push(`${e.name}: ${e.message}`))
    page.on("requestfailed", (r) => net.push(`${r.method()} ${r.url()} -> ${r.failure()?.errorText}`))

    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 20000 })
    await page.waitForTimeout(5000)

    const shot = "C:/Users/crisc/AppData/Local/Temp/oc-qa-desktop.png"
    await page.screenshot({ path: shot, fullPage: false })

    const title = await page.title()
    const sessionRows = await page.locator('a[href*="/session/"]').count()
    const toastEls = await page.locator('[data-component="toast"], [data-component="toast-v2"]').count()
    const iconEls = await page.locator('[data-component="icon"], [data-slot="icon-svg"]').count()
    const bodyText = (await page.locator("body").innerText().catch(() => "")).slice(0, 1200)

    const report = [
      "=== QA DESKTOP REPORT ===",
      `URL: ${URL} | title: ${title}`,
      `sessionRows: ${sessionRows} | toasts: ${toastEls} | icons: ${iconEls}`,
      `--- console (${logs.length}) ---`,
      ...logs.slice(-20),
      `--- pageerrors (${errs.length}) ---`,
      ...errs,
      `--- netfail (${net.length}) ---`,
      ...net.slice(-15),
      "--- body text ---",
      bodyText,
    ].join("\n")
    writeFileSync("C:/Users/crisc/AppData/Local/Temp/oc-qa-desktop.txt", report)
    console.log(report)
  })

  test("mobile 390x844 - capture state", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const page = await ctx.newPage()
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 20000 })
    await page.waitForTimeout(4000)
    await page.screenshot({ path: "C:/Users/crisc/AppData/Local/Temp/oc-qa-mobile.png", fullPage: false })
    console.log("MOBILE screenshot saved. title:", await page.title())
    await ctx.close()
  })
})
