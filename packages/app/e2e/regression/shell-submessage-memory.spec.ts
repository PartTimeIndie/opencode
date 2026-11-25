import { expect, test } from "@playwright/test"

test.use({ video: { mode: "on", size: { width: 1280, height: 844 } } })

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport })
    test("disposed tool animations release their view", async ({ page }) => {
      const errors: string[] = []
      const failed: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      page.on("requestfailed", (request) => failed.push(request.url()))
      page.on("response", (response) => {
        if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`)
      })
      await page.route("**/__shell-motion-test", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><div id="root"></div><script type="module">import { mount } from "/e2e/fixtures/shell-submessage.tsx"; mount(document.getElementById("root"))</script>',
        }),
      )
      await page.goto("/__shell-motion-test")
      await expect(page.getByRole("status")).toHaveText("Tool view closed")
      await page.evaluate(() => Object.assign(window, { shellMotionViews: [] }))

      for (let index = 0; index < 16; index++) {
        await page.getByRole("button", { name: "Show tool update" }).click()
        await expect(page.locator('[data-component="shell-submessage"]')).toHaveText("Explored 4 reads, 2 searches")
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => {
                const views = (window as unknown as { shellMotionViews: WeakRef<Element>[] }).shellMotionViews
                views.push(new WeakRef(document.querySelector('[data-slot="shell-submessage-width"]')!))
                requestAnimationFrame(() => resolve())
              }),
            ),
        )
        await page.getByRole("button", { name: "Switch away" }).click()
        await expect(page.getByRole("status")).toHaveText("Tool view closed")
      }
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      )
      const cdp = await page.context().newCDPSession(page)
      await cdp.send("HeapProfiler.collectGarbage")
      const retained = await page.evaluate(
        () =>
          (window as unknown as { shellMotionViews: WeakRef<Element>[] }).shellMotionViews.filter((ref) => ref.deref())
            .length,
      )
      expect(retained).toBe(0)
      expect(errors).toEqual([])
      expect(failed).toEqual([])
      await page.screenshot({ path: test.info().outputPath("closed-tool-view.png") })
      await cdp.detach()
    })
  })
}
