import { describe, expect, mock, spyOn, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserWindow } from "electron"

let respond: (event: unknown, id: string, response: { ok: true; result: unknown }) => boolean

mock.module("electron", () => ({
  BrowserWindow: class {},
  desktopCapturer: {},
  nativeImage: {},
  ipcMain: {
    handle: (_channel: string, handler: typeof respond) => {
      respond = handler
    },
  },
}))
mock.module("./browser-automation", () => ({ getBrowserAutomationEnabled: () => true }))
mock.module("./server", () => ({ checkHealth: async () => true }))

const { startDesktopTestingServer } = await import("./desktop-testing")

describe("desktop testing renderer request deadlines", () => {
  for (const type of ["session.prompt", "question.reply"]) {
    test(`${type} accepts one late durable reply after thirty seconds without replay`, async () => {
      await withBridge(async (bridge) => {
        const response = bridge.request(type)
        const dispatched = await bridge.dispatched.promise
        bridge.advance(30_000)
        expect(respond(undefined, dispatched.id, { ok: true, result: { accepted: true } })).toBe(true)
        const result = await response
        expect(result.status).toBe(200)
        expect(await result.json()).toEqual({ accepted: true })
        expect(bridge.dispatches).toHaveLength(1)
      })
    })
  }

  test("a missing durable reply still times out at its fixed admission deadline without replay", async () => {
    await withBridge(async (bridge) => {
      const response = bridge.request("session.prompt")
      const dispatched = await bridge.dispatched.promise
      bridge.advance(60_000)
      const result = await response
      expect(result.status).toBe(500)
      expect(await result.json()).toEqual({ ok: false, error: "Desktop testing renderer request timed out: action" })
      expect(respond(undefined, dispatched.id, { ok: true, result: { accepted: true } })).toBe(false)
      expect(bridge.dispatches).toHaveLength(1)
    })
  })
})

async function withBridge(
  run: (bridge: {
    request(type: string): Promise<Response>
    dispatched: ReturnType<typeof Promise.withResolvers<{ id: string }>>
    advance(milliseconds: number): void
    dispatches: unknown[]
  }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "opencode-renderer-deadline-"))
  const dispatched = Promise.withResolvers<{ id: string }>()
  const dispatches: unknown[] = []
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (_channel: string, request: { id: string }) => {
        dispatches.push(request)
        dispatched.resolve(request)
      },
    },
  }
  const server = await startDesktopTestingServer({
    app: { version: "test", channel: "test", packaged: false, userDataPath: directory },
    getWindow: () => window as unknown as BrowserWindow,
    getSidecar: () => null,
    quit: () => {},
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  })
  if (!server) throw new Error("Fixture bridge did not start")
  const token = JSON.parse(await readFile(server.tokenPath, "utf8")) as { token: string }
  const schedule = globalThis.setTimeout
  const cancel = globalThis.clearTimeout
  const timers = new Map<ReturnType<typeof setTimeout>, { milliseconds: number; run(): void }>()
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation((callback, milliseconds, ...args) => {
    const handle = schedule(() => {}, 600_000)
    timers.set(handle, { milliseconds: milliseconds ?? 0, run: () => callback(...args) })
    return handle
  })
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
    if (handle !== undefined) timers.delete(handle)
    cancel(handle)
  })
  try {
    await run({
      dispatched,
      dispatches,
      request: (type) =>
        fetch(`${server.url}/action`, {
          method: "POST",
          headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
          body: JSON.stringify({ action: { type, sessionID: "fixture-session", requestID: "fixture-question" } }),
        }),
      advance: (milliseconds) => {
        for (const [handle, timer] of timers) {
          if (timer.milliseconds > milliseconds) continue
          timers.delete(handle)
          cancel(handle)
          timer.run()
        }
      },
    })
  } finally {
    timeout.mockRestore()
    clear.mockRestore()
    for (const handle of timers.keys()) cancel(handle)
    await server.stop()
    await rm(directory, { recursive: true, force: true })
  }
}
