import { expect, spyOn, test } from "bun:test"
import { createRoot } from "solid-js"
import { PresentationWatchdog } from "../src/components/presentation-watchdog"

test("unmount cancels the current frame and remount starts only one chain", () => {
  const frames = new Map<number, FrameRequestCallback>()
  let nextID = 0
  const request = spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextID, callback)
    return nextID
  })
  const cancel = spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id)
  })
  const api = Object.getOwnPropertyDescriptor(window, "api")
  Object.defineProperty(window, "api", { configurable: true, value: { reportFrameStall: () => {} } })
  const disposals: (() => void)[] = []
  try {
    for (let mount = 0; mount < 2; mount++) {
      const dispose = createRoot((dispose) => {
        PresentationWatchdog()
        return dispose
      })
      disposals.push(dispose)
      expect(frames.size).toBe(1)
      const frame = [...frames.entries()][0]!
      frames.delete(frame[0])
      frame[1](performance.now())
      expect(frames.size).toBe(1)
      dispose()
      expect(frames.size).toBe(0)
    }
  } finally {
    disposals.forEach((dispose) => dispose())
    request.mockRestore()
    cancel.mockRestore()
    if (api) Object.defineProperty(window, "api", api)
    else Reflect.deleteProperty(window, "api")
  }
})
