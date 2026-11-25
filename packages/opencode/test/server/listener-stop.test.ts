import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Server } from "../../src/server/server"

test("listener Promise boundary preserves successful cleanup and explicit close mode", async () => {
  const modes: Array<boolean | undefined> = []
  const listener = Server.promiseListener({ hostname: "127.0.0.1", port: 1234, url: new URL("http://127.0.0.1:1234"),
    stop: (close) => Effect.sync(() => { modes.push(close) }),
  })
  await listener.stop()
  await listener.stop(true)
  expect(modes).toEqual([undefined, true])
  expect(listener.port).toBe(1234)
})

test("listener cleanup defects reject instead of becoming a successful sidecar stop", async () => {
  const listener = Server.promiseListener({ hostname: "127.0.0.1", port: 1234, url: new URL("http://127.0.0.1:1234"),
    stop: () => Effect.die(new Error("fixture cleanup did not complete")),
  })
  await expect(listener.stop()).rejects.toThrow("fixture cleanup did not complete")
})
