import { describe, expect, test } from "bun:test"
import { mountPluginElement } from "./mount-lifecycle"

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

describe("mountPluginElement", () => {
  test("releases DOM and the callback even when plugin cleanup throws", () => {
    const root = document.createElement("div")
    let signal!: AbortSignal
    let calls = 0
    const failure = new Error("cleanup failed")
    const dispose = mountPluginElement({
      element: root,
      mount(current) {
        signal = current
        root.textContent = "mounted"
        return () => {
          calls++
          throw failure
        }
      },
    })

    expect(dispose).toThrow(failure)
    expect(signal.aborted).toBe(true)
    expect(root.textContent).toBe("")
    expect(dispose).not.toThrow()
    expect(calls).toBe(1)
  })

  test("retained abort signals do not capture the unmounting UI stack", () => {
    const signals: AbortSignal[] = []
    const dispose = () =>
      mountPluginElement({
        element: document.createElement("div"),
        mount(signal) {
          signals.push(signal)
        },
      })()

    dispose()
    dispose()

    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(signals[0].reason).toBeInstanceOf(DOMException)
    expect(signals[0].reason.name).toBe("AbortError")
    expect(signals[0].reason.stack).toBe("")
    expect(signals[1].reason).toBe(signals[0].reason)
  })

  test("aborts, removes DOM, runs disposer, and stops plugin timers on dispose", async () => {
    let aborted = false
    let disposed = false
    let ticks = 0
    let timer: ReturnType<typeof setInterval> | undefined
    const root = document.createElement("div")
    document.body.appendChild(root)

    const dispose = mountPluginElement({
      element: root,
      mount(signal) {
        root.textContent = "mounted"
        timer = setInterval(() => {
          ticks += 1
        }, 1)
        signal.addEventListener("abort", () => {
          aborted = true
          if (timer) clearInterval(timer)
        })
        return () => {
          disposed = true
          if (timer) clearInterval(timer)
        }
      },
    })

    await wait(5)
    expect(root.textContent).toBe("mounted")
    expect(ticks).toBeGreaterThan(0)

    dispose()
    const afterDispose = ticks
    await wait(5)

    expect(aborted).toBe(true)
    expect(disposed).toBe(true)
    expect(root.textContent).toBe("")
    expect(ticks).toBe(afterDispose)
    root.remove()
  })

  test("runs async disposer immediately when mount resolves after abort", async () => {
    let disposed = false
    const root = document.createElement("div")
    document.body.appendChild(root)

    const dispose = mountPluginElement({
      element: root,
      mount: async (signal) => {
        root.textContent = signal.aborted ? "aborted" : "pending"
        await wait()
        return () => {
          disposed = true
        }
      },
    })

    dispose()
    await wait(5)

    expect(disposed).toBe(true)
    expect(root.textContent).toBe("")
    root.remove()
  })

  test("reports sync mount errors and clears the element", () => {
    const onError = (error: unknown) => {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe("boom")
    }
    const root = document.createElement("div")
    root.textContent = "stale"
    document.body.appendChild(root)

    const dispose = mountPluginElement({
      element: root,
      onError,
      mount() {
        throw new Error("boom")
      },
    })

    expect(root.textContent).toBe("")
    dispose()
    expect(root.textContent).toBe("")
    root.remove()
  })

  test("reports rejected async mount errors and clears the element", async () => {
    let reported: unknown
    const root = document.createElement("div")
    root.textContent = "stale"
    document.body.appendChild(root)

    const dispose = mountPluginElement({
      element: root,
      onError: (error) => {
        reported = error
      },
      mount: async () => {
        await wait()
        throw new Error("async boom")
      },
    })

    await wait(5)
    expect(reported).toBeInstanceOf(Error)
    expect((reported as Error).message).toBe("async boom")
    expect(root.textContent).toBe("")
    dispose()
    root.remove()
  })

  test("ignores a stale rejection after the same element remounts", async () => {
    const stale = Promise.withResolvers<void>()
    let reported: unknown
    const root = document.createElement("div")
    document.body.appendChild(root)

    const disposeOld = mountPluginElement({
      element: root,
      onError: (error) => {
        reported = error
      },
      mount() {
        root.textContent = "old"
        return stale.promise
      },
    })
    disposeOld()
    const disposeCurrent = mountPluginElement({
      element: root,
      mount() {
        root.textContent = "current"
      },
    })

    stale.reject(new Error("stale rejection"))
    await wait()

    expect(reported).toBeUndefined()
    expect(root.textContent).toBe("current")
    disposeCurrent()
    root.remove()
  })
})
