import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { rendererUncaughtConsoleProblem } from "../script/desktop-testing-diagnose"

test.each([
  {
    name: "healthy renderer and capture",
    screen: { ok: true, probablyBlank: false, state: { title: "OpenCode" } },
    status: 200,
    capture: 200,
    screenStatus: 200,
    classification: "healthy",
  },
  {
    name: "renderer timeout behind HTTP 200",
    screen: { ok: true, probablyBlank: false, state: { error: "renderer request timed out" } },
    status: 200,
    capture: 200,
    screenStatus: 200,
    classification: "warning",
  },
  {
    name: "blank capture behind HTTP 200",
    screen: { ok: true, probablyBlank: true, state: { title: "OpenCode" } },
    status: 200,
    capture: 200,
    screenStatus: 200,
    classification: "warning",
  },
  {
    name: "explicit screen failure behind HTTP 200",
    screen: { ok: false, error: "OpenCode window is not available" },
    status: 200,
    capture: 200,
    screenStatus: 200,
    classification: "warning",
  },
  {
    name: "renderer failure without another working probe",
    screen: { ok: true, state: { error: "renderer request timed out" } },
    status: 500,
    capture: 500,
    screenStatus: 200,
    classification: "error",
  },
  {
    name: "screen transport failure with bridge fallback",
    screen: { error: "screen unavailable" },
    status: 200,
    capture: 500,
    screenStatus: 500,
    classification: "warning",
  },
  {
    name: "all probes unavailable",
    screen: { error: "screen unavailable" },
    status: 500,
    capture: 500,
    screenStatus: 500,
    classification: "error",
  },
  {
    name: "recovered screen after earlier probe failures",
    screen: { ok: true, probablyBlank: false, state: { title: "OpenCode" } },
    status: 500,
    capture: 500,
    screenStatus: 200,
    classification: "healthy",
  },
  {
    name: "unhealthy sidecar in successful status response",
    screen: { ok: true, probablyBlank: false, state: { title: "OpenCode" } },
    statusData: { sidecar: { healthy: false } },
    status: 200,
    capture: 200,
    screenStatus: 200,
    classification: "warning",
  },
  {
    name: "renderer error in successful status response",
    screen: { ok: true, probablyBlank: false, state: { title: "OpenCode" } },
    statusData: { renderer: { error: "renderer request timed out" } },
    status: 200,
    capture: 200,
    screenStatus: 200,
    classification: "warning",
  },
  {
    name: "recent uncaught renderer console error blocks healthy",
    screen: {
      ok: true,
      probablyBlank: false,
      state: {
        title: "OpenCode",
        console: [
          {
            level: "error",
            message: "Uncaught TypeError: Cannot read properties of undefined (reading '1')",
            time: Date.now() - 60_000,
          },
          { level: "log", message: "boot", time: Date.now() - 1_000 },
        ],
      },
    },
    status: 200,
    capture: 200,
    screenStatus: 200,
    classification: "warning",
  },
  {
    name: "old uncaught renderer console error stays healthy",
    screen: {
      ok: true,
      probablyBlank: false,
      state: {
        title: "OpenCode",
        console: [
          {
            level: "error",
            message: "Uncaught TypeError: Cannot read properties of undefined (reading '1')",
            time: Date.now() - 16 * 60_000,
          },
        ],
      },
    },
    status: 200,
    capture: 200,
    screenStatus: 200,
    classification: "healthy",
  },
])(
  "diagnose-screen-state: $name",
  async (input) => {
    const directory = await mkdtemp(path.join(tmpdir(), "desktop-screen-state-"))
    const requests: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (request.headers.get("authorization") !== "Bearer diagnostic-test-token")
          return new Response(null, { status: 401 })
        const endpoint = new URL(request.url).pathname
        requests.push(endpoint)
        return Response.json(
          endpoint === "/screen-state"
            ? input.screen
            : endpoint === "/status"
              ? (input.statusData ?? { ok: true })
              : { ok: true },
          {
            status:
              endpoint === "/screen-state" ? input.screenStatus : endpoint === "/status" ? input.status : input.capture,
          },
        )
      },
    })
    try {
      await Bun.write(
        path.join(directory, "token.json"),
        JSON.stringify({ url: server.url.href.slice(0, -1), token: "diagnostic-test-token" }),
      )
      const child = Bun.spawn(
        [
          process.execPath,
          path.resolve(import.meta.dir, "../script/desktop-testing.ts"),
          "diagnose-screen-state",
          "--token-file",
          path.join(directory, "token.json"),
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5_000,
        },
      )
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(exitCode, stderr).toBe(0)
      expect(requests).toEqual(["/status", "/screenshot", "/screen-state"])
      const result = JSON.parse(stdout)
      expect(result.classification).toBe(input.classification)
      expect(result.screenState.ok).toBe(input.screenStatus === 200)
      if (input.screenStatus === 200) expect(result.screenState.data).toEqual(input.screen)
    } finally {
      await server.stop(true)
      await rm(directory, { recursive: true, force: true })
    }
  },
  10_000,
)

describe("rendererUncaughtConsoleProblem", () => {
  const now = Date.parse("2026-10-03T11:20:00.000Z")

  test("surfaces the most recent uncaught renderer error", () => {
    const problem = rendererUncaughtConsoleProblem({
      console: [
        { level: "error", message: "Uncaught TypeError: Cannot read properties of undefined (reading '1')", time: now - 60_000 },
        { level: "log", message: "boot", time: now - 1_000 },
      ],
      now,
    })
    expect(problem).toContain("Uncaught TypeError: Cannot read properties of undefined (reading '1')")
  })

  test("ignores non-error, non-uncaught, and timestamp-less entries", () => {
    expect(
      rendererUncaughtConsoleProblem({
        console: [
          { level: "error", message: "Failed to load sessions", time: now - 1_000 },
          { level: "log", message: "Uncaught looking message", time: now - 1_000 },
          { level: "error", message: "Uncaught TypeError: boom" },
        ],
        now,
      }),
    ).toBeUndefined()
  })

  test("ignores uncaught errors older than the recency window", () => {
    expect(
      rendererUncaughtConsoleProblem({
        console: [{ level: "error", message: "Uncaught TypeError: boom", time: now - 16 * 60_000 }],
        now,
      }),
    ).toBeUndefined()
  })

  test("ignores a missing or malformed console capture", () => {
    expect(rendererUncaughtConsoleProblem({ console: undefined, now })).toBeUndefined()
    expect(rendererUncaughtConsoleProblem({ console: "nope", now })).toBeUndefined()
  })
})
