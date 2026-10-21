import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createModalOpenState, createModalRemountState } from "./modal-open-state"

describe("createModalOpenState", () => {
  test("dismisses and reopens an uncontrolled overlay", () => {
    createRoot((dispose) => {
      const changes: boolean[] = []
      const state = createModalOpenState({
        open: () => undefined,
        defaultOpen: true,
        onOpenChange: (open) => changes.push(open),
      })

      state.dismiss()
      state.dismiss()
      expect(state.value()).toBe(false)
      expect(changes).toEqual([false])

      state.change(true)
      expect(state.value()).toBe(true)
      expect(changes).toEqual([false, true])
      dispose()
    })
  })

  test("suppresses a controlled overlay until its next open change", () => {
    createRoot((dispose) => {
      const [controlled, setControlled] = createSignal(true)
      const changes: boolean[] = []
      const state = createModalOpenState({
        open: controlled,
        onOpenChange(open) {
          changes.push(open)
          setControlled(open)
        },
      })

      state.dismiss()
      expect(state.value()).toBe(false)
      expect(changes).toEqual([false])

      state.change(true)
      expect(state.value()).toBe(true)
      expect(changes).toEqual([false, true])
      dispose()
    })
  })

  test("keeps a controlled overlay suppressed after a redundant close change", () => {
    createRoot((dispose) => {
      const changes: boolean[] = []
      const state = createModalOpenState({
        open: () => true,
        onOpenChange: (open) => changes.push(open),
      })

      state.dismiss()
      state.change(false)
      expect(state.value()).toBe(false)
      expect(changes).toEqual([false])

      state.change(true)
      expect(state.value()).toBe(true)
      expect(changes).toEqual([false, true])
      dispose()
    })
  })

  test("remounts uncontrolled context menus after modal dismissal", async () => {
    const state = createRoot(() => createModalRemountState())
    state.dismiss()
    expect(state.mounted()).toBe(false)
    await Promise.resolve()
    expect(state.mounted()).toBe(true)
  })
})
