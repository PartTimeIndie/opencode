import { expect, mock, test } from "bun:test"

mock.module("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ close() {} }),
}))

test("model-chain management does not require a Local provider", async () => {
  const { DialogManageModelChains } = await import("./dialog-manage-model-chains")
  const previous = Object.getOwnPropertyDescriptor(globalThis, "React")
  const model = {
    current: () => undefined,
    recent: () => [],
    list: () => [],
    set() {},
    visible: () => true,
    chain: {
      list: () => [],
      current: () => undefined,
      selected: () => undefined,
      set() {},
      default: () => undefined,
      setDefault() {},
      save: () => true,
      remove() {},
      move() {},
    },
  }

  Object.defineProperty(globalThis, "React", { configurable: true, value: { createElement: () => ({}) } })
  try {
    expect(() => DialogManageModelChains({ model })).not.toThrow()
  } finally {
    if (previous) Object.defineProperty(globalThis, "React", previous)
    else Reflect.deleteProperty(globalThis, "React")
  }
})
