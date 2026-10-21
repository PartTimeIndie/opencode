import { describe, expect, test } from "bun:test"
import { createShutdownCoordinator } from "./shutdown"

describe("desktop shutdown", () => {
  test("runs cleanup once and completes only after cleanup", async () => {
    let cleanupCalls = 0
    let completeCalls = 0
    let releaseCleanup!: () => void
    const cleanupFinished = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    const shutdown = createShutdownCoordinator({
      cleanup: async () => {
        cleanupCalls += 1
        await cleanupFinished
      },
      onCleanupError: () => undefined,
    })

    const first = shutdown.request(() => {
      completeCalls += 1
    })
    const second = shutdown.request(() => {
      completeCalls += 10
    })

    expect(first).toBe(second)
    await Promise.resolve()
    expect(cleanupCalls).toBe(1)
    expect(completeCalls).toBe(0)

    releaseCleanup()
    await first
    expect(completeCalls).toBe(1)
  })

  test("reports cleanup failures and still completes shutdown", async () => {
    const error = new Error("sidecar already stopped")
    const errors: unknown[] = []
    let completeCalls = 0
    const shutdown = createShutdownCoordinator({
      cleanup: async () => {
        throw error
      },
      onCleanupError: (value) => errors.push(value),
    })

    await shutdown.request(() => {
      completeCalls += 1
    })

    expect(errors).toEqual([error])
    expect(completeCalls).toBe(1)
  })
})
