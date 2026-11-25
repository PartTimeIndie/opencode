#!/usr/bin/env bun
// Dedicated acceptance entry for the writing-task Chromium E2E. The gate
// check lives here (not only in the spec) so the acceptance command fails
// loudly with instructions when the environment is missing; ordinary
// `playwright test` discovery excludes the spec via playwright.config.ts.
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"

if (process.env.OPENCODE_TASK_WRITE_QA !== "1") {
  console.error(
    "The writing-task acceptance suite is strict opt-in: set OPENCODE_TASK_WRITE_QA=1 and a dedicated " +
      "PLAYWRIGHT_SERVER_PORT (see e2e/regression/native-task-write.spec.ts). No tests were run.",
  )
  process.exit(2)
}

const spec = "e2e/regression/native-task-write.spec.ts"
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const child = spawn("bun", ["./e2e/run-with-vite-server.ts", "--", spec], {
  cwd: root,
  stdio: "inherit",
  shell: false,
  env: process.env,
})
const code = await new Promise<number>((resolve) => {
  child.on("exit", (exitCode) => resolve(exitCode ?? 1))
  child.on("error", () => resolve(1))
})
process.exit(code)
