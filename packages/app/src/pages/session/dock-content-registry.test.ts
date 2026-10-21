import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { JSX } from "solid-js"
import { createDockContentRegistry, type DockContentParts } from "./dock-content-registry"

const element = (value: string) => value as unknown as JSX.Element

const parts = (value: string): DockContentParts => ({
  header: element(`${value}:header`),
  review: element(`${value}:review`),
  changes: element(`${value}:changes`),
  files: element(`${value}:files`),
  bottom: () => element(`${value}:bottom`),
  mobileChanges: element(`${value}:mobileChanges`),
  mobileChangesOpen: () => false,
})

describe("createDockContentRegistry", () => {
  test("exposes registered parts and clears them when the registering scope disposes", () => {
    createRoot(() => {
      const registry = createDockContentRegistry()
      expect(registry.parts()).toBeUndefined()

      const disposeRegistration = createRoot((dispose) => {
        registry.register(parts("first"))
        return dispose
      })
      expect(registry.parts()?.review).toBe("first:review")

      disposeRegistration()
      expect(registry.parts()).toBeUndefined()
    })
  })

  test("a newer registration wins and the stale cleanup does not clear it", () => {
    createRoot(() => {
      const registry = createDockContentRegistry()
      const stale = createRoot((dispose) => {
        registry.register(parts("stale"))
        return dispose
      })
      createRoot(() => registry.register(parts("next")))
      expect(registry.parts()?.files).toBe("next:files")

      stale()
      expect(registry.parts()?.files).toBe("next:files")
    })
  })

  test("registered accessors stay reactive through the signal", () => {
    createRoot(() => {
      const registry = createDockContentRegistry()
      const [open, setOpen] = createSignal(false)
      registry.register({ ...parts("live"), mobileChangesOpen: open })

      expect(registry.parts()?.mobileChangesOpen()).toBe(false)
      setOpen(true)
      expect(registry.parts()?.mobileChangesOpen()).toBe(true)
    })
  })

  test("does not construct lazy dock content during registration", () => {
    createRoot(() => {
      const registry = createDockContentRegistry()
      let mounts = 0
      registry.register({
        ...parts("lazy"),
        bottom: () => {
          mounts++
          return element("lazy:bottom")
        },
      })

      expect(mounts).toBe(0)
      expect(registry.parts()?.bottom()).toBe("lazy:bottom")
      expect(mounts).toBe(1)
    })
  })
})
