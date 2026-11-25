import { defineConfig, devices } from "@playwright/test"

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3000)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`
const serverHost = process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"
const serverPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
const debugBar = process.env.VITE_DISABLE_DEBUG_BAR ?? "1"
const command = `bun run dev -- --host 0.0.0.0 --port ${port}`
const reuse = !process.env.CI
const workers = Number(process.env.PLAYWRIGHT_WORKERS ?? (process.env.CI ? 5 : 0)) || undefined
const webServer = process.env.PLAYWRIGHT_NO_WEB_SERVER === "1"
  ? undefined
  : {
      command,
      url: baseURL,
      reuseExistingServer: reuse,
      timeout: 120_000,
      env: {
        VITE_OPENCODE_SERVER_HOST: serverHost,
        VITE_OPENCODE_SERVER_PORT: serverPort,
        VITE_DISABLE_DEBUG_BAR: debugBar,
      },
    }

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/test-results",
  timeout: 60_000,
  // The writing-task acceptance spec is a strict opt-in: exclude it from
  // ordinary discovery so an un-gated default run stays green, while the
  // dedicated acceptance command still fails loudly without its environment.
  testIgnore: process.env.OPENCODE_TASK_WRITE_QA === "1" ? [] : ["**/native-task-write.spec.ts"],
  expect: {
    timeout: 10_000,
  },
  fullyParallel: process.env.PLAYWRIGHT_FULLY_PARALLEL === "1",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers,
  reporter: [["html", { outputFolder: "e2e/playwright-report", open: "never" }], ["line"]],
  webServer,
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: process.env.PLAYWRIGHT_VIDEO === "on" ? "on" : "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
})
