import { expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { createRoot } from "solid-js"
import { persisted, PersistTesting } from "../src/utils/persist"

test("persist serializes raw Solid state when a control-panel proxy has an invalid descriptor", () => {
  const id = "control-panel:fixture"
  const [store, setStore] = createStore({ [id]: { area: "middle", visible: true } })
  const invalidProxy = new Proxy(store, {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
      if (key !== id || !descriptor) return descriptor
      return { ...descriptor, configurable: false }
    },
  })

  expect(() => JSON.stringify(invalidProxy)).toThrow()
  expect(PersistTesting.serializeStore(invalidProxy)).toBe(JSON.stringify({ [id]: { area: "middle", visible: true } }))

  createRoot((dispose) => {
    const [, setPersisted] = persisted(
      { key: "persist-proxy-fixture" },
      [invalidProxy, setStore],
      { platform: "web" } as NonNullable<Parameters<typeof persisted>[2]>,
    )
    // The production path serializes after every setter call.
    expect(() => setPersisted(id, "visible", false)).not.toThrow()
    expect(JSON.parse(localStorage.getItem("persist-proxy-fixture") ?? "null")).toEqual({ [id]: { area: "middle", visible: false } })
    dispose()
  })
})
