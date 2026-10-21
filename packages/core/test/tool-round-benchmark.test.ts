import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

// The test preload isolates HOME/XDG paths; the benchmark also owns its temp
// project and database. Never probe the installed app or the user's sessions.
test("tool-round benchmark wires real services and completes one read/write/reply round", async () => {
  const child = Bun.spawn([
    process.execPath,
    "run",
    "script/tool-round-benchmark.ts",
    "--label",
    "routing-regression",
    "--sessions",
    "1",
    "--rounds",
    "1",
    "--warmup",
    "0",
  ], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, stderr }).toMatchObject({ code: 0 })
  // Effect diagnostics precede the script's final JSON report on stdout.
  const report = stdout.lastIndexOf('{\n  "label":')
  expect(report).toBeGreaterThanOrEqual(0)
  expect(JSON.parse(stdout.slice(report))).toMatchObject({
    label: "routing-regression",
    sessions: 1,
    rounds: 1,
    matched_assemblies: 3,
    expected_assemblies: 3,
    provider_calls: 3,
    contract: { journal_rows: 1 },
  })
}, 40_000)
