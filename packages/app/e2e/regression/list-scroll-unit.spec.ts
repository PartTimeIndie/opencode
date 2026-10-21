import { expect, test } from "@playwright/test"

// Isolated component unit contract, rendered by Vite/Solid in a real DOM.
// No app providers, server, persisted model state, or duplicated List logic.
test.beforeEach(async ({ page }) => {
  await page.route("**/list-scroll-unit?*", (route) => route.fulfill({
    contentType: "text/html",
    body: `<html><head><style>[data-component="list"] { height: 200px; width: 300px }</style></head><body><div id="root"></div><script type="module" src="/e2e/fixtures/list-scroll.tsx"></script></body></html>`,
  }))
})

test("scroll header shares item scrolling, not search, and remains independently selectable", async ({ page }) => {
  await page.goto("/list-scroll-unit?header")
  const scroll = page.locator('[data-slot="list-scroll"]')
  const header = page.getByTestId("header")
  await expect(scroll.getByTestId("header")).toBeVisible()
  await expect(scroll.locator('[data-slot="list-search"]')).toHaveCount(0)
  await header.click()
  await expect(page.locator("output")).toHaveText("Chain")
  await page.getByRole("button", { name: "Model 0", exact: true }).click()
  await expect(page.locator("output")).toHaveText("Model 0")
  await page.getByPlaceholder("Search models").fill("Model 29")
  await expect(scroll.locator('[data-slot="list-item"]')).toHaveCount(1)
  await expect(header).toBeVisible()
  await page.getByRole("button", { name: "Toggle header" }).click()
  await expect(header).toHaveCount(0)
})

test("header is available with no model items and remains optional", async ({ page }) => {
  await page.goto("/list-scroll-unit?header&empty")
  await expect(page.locator('[data-slot="list-scroll"]').getByTestId("header")).toBeVisible()
  await expect(page.getByText("No models", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Toggle header" }).click()
  await expect(page.getByTestId("header")).toHaveCount(0)
  await expect(page.getByText("No models", { exact: true })).toBeVisible()
})
