import { describe, expect, test } from "bun:test"
import { createPluginModuleLoader } from "./plugin-module-loader"

async function waitForStarted(started: number[], count: number) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (started.length >= count) return
    await Bun.sleep(1)
  }
  throw new Error(`Only ${started.length} of ${count} module imports started`)
}

describe("createPluginModuleLoader", () => {
  test("loads modules FIFO with bounded concurrency", async () => {
    const loader = createPluginModuleLoader(2)
    const started: number[] = []
    const release = new Map<number, () => void>()
    const loads = [1, 2, 3, 4].map((plugin) =>
      loader.load(new AbortController().signal, () => {
        started.push(plugin)
        return new Promise<number>((resolve) => release.set(plugin, () => resolve(plugin * 10)))
      }),
    )

    await waitForStarted(started, 2)
    expect(started).toEqual([1, 2])

    release.get(1)?.()
    await waitForStarted(started, 3)
    expect(started).toEqual([1, 2, 3])

    release.get(2)?.()
    await waitForStarted(started, 4)
    expect(started).toEqual([1, 2, 3, 4])

    release.get(3)?.()
    release.get(4)?.()
    await expect(Promise.all(loads)).resolves.toEqual([10, 20, 30, 40])
  })

  test("removes an aborted queued module before it starts", async () => {
    const loader = createPluginModuleLoader(1)
    const queued = new AbortController()
    const started: number[] = []
    let release = () => {}
    const first = loader.load(new AbortController().signal, () => {
      started.push(1)
      return new Promise<number>((resolve) => {
        release = () => resolve(1)
      })
    })
    const second = loader.load(queued.signal, async () => {
      started.push(2)
      return 2
    })

    queued.abort()
    await expect(second).resolves.toBeUndefined()
    await waitForStarted(started, 1)
    release()
    await expect(first).resolves.toBe(1)
    expect(started).toEqual([1])
  })

  test("releases a slot after an import fails", async () => {
    const loader = createPluginModuleLoader(1)
    const started: number[] = []
    let fail = () => {}
    const first = loader.load(new AbortController().signal, () => {
      started.push(1)
      return new Promise<number>((_resolve, reject) => {
        fail = () => reject(new Error("broken module"))
      })
    })
    const second = loader.load(new AbortController().signal, async () => {
      started.push(2)
      return 2
    })
    await waitForStarted(started, 1)
    fail()
    const error = await first.then(
      () => undefined,
      (error) => error,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("broken module")
    await waitForStarted(started, 2)
    await expect(second).resolves.toBe(2)
    expect(started).toEqual([1, 2])
  })
})
