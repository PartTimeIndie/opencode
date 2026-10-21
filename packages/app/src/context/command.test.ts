import { describe, expect, test } from "bun:test"
import { createRoot, onCleanup } from "solid-js"
import { createCommandRegistrar, type CommandRegistration, upsertCommandRegistration } from "./command"

describe("upsertCommandRegistration", () => {
  test("replaces keyed registrations", () => {
    const one = () => [{ id: "one", title: "One" }]
    const two = () => [{ id: "two", title: "Two" }]

    const next = upsertCommandRegistration([{ key: "layout", options: one }], { key: "layout", options: two })

    expect(next).toHaveLength(1)
    expect(next[0]?.options).toBe(two)
  })

  test("keeps unkeyed registrations additive", () => {
    const one = () => [{ id: "one", title: "One" }]
    const two = () => [{ id: "two", title: "Two" }]

    const next = upsertCommandRegistration([{ options: one }], { options: two })

    expect(next).toHaveLength(2)
    expect(next[0]?.options).toBe(two)
    expect(next[1]?.options).toBe(one)
  })
})

describe("createCommandRegistrar", () => {
  test("owns registrations created after the provider call stack", () => {
    const registrations: CommandRegistration[] = []
    const warnings: unknown[][] = []
    const warn = console.warn
    let register!: ReturnType<typeof createCommandRegistrar>
    let dispose!: () => void

    console.warn = (...args) => warnings.push(args)
    try {
      createRoot((cleanup) => {
        dispose = cleanup
        register = createCommandRegistrar({
          registrations: () => registrations,
          update(update) {
            registrations.splice(0, registrations.length, ...update(registrations))
          },
        })
      })

      register("plugin", () => [{ id: "plugin.command", title: "Plugin command" }])

      expect(registrations).toHaveLength(1)
      expect(registrations[0]?.options()).toEqual([{ id: "plugin.command", title: "Plugin command" }])
      expect(warnings.some((args) => String(args[0]).includes("outside a `createRoot` or `render`"))).toBe(false)

      dispose()
      expect(registrations).toHaveLength(0)

      register("late", () => [{ id: "late.command", title: "Late command" }])
      expect(registrations).toHaveLength(0)
    } finally {
      console.warn = warn
      dispose?.()
    }
  })

  test("disposes replaced keyed registrations", () => {
    const registrations: CommandRegistration[] = []
    let register!: ReturnType<typeof createCommandRegistrar>
    let dispose!: () => void
    let firstDisposed = 0

    createRoot((cleanup) => {
      dispose = cleanup
      register = createCommandRegistrar({
        registrations: () => registrations,
        update(update) {
          registrations.splice(0, registrations.length, ...update(registrations))
        },
      })
    })

    register("plugin", () => {
      onCleanup(() => firstDisposed++)
      return [{ id: "plugin.first", title: "First" }]
    })
    register("plugin", () => [{ id: "plugin.second", title: "Second" }])

    expect(firstDisposed).toBe(1)
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.options()[0]?.id).toBe("plugin.second")
    dispose()
  })

  test("uses a calling owner when registration happens in a mounted scope", () => {
    const registrations: CommandRegistration[] = []
    let register!: ReturnType<typeof createCommandRegistrar>
    let disposeProvider!: () => void
    let disposeConsumer!: () => void

    createRoot((cleanup) => {
      disposeProvider = cleanup
      register = createCommandRegistrar({
        registrations: () => registrations,
        update(update) {
          registrations.splice(0, registrations.length, ...update(registrations))
        },
      })
    })
    createRoot((cleanup) => {
      disposeConsumer = cleanup
      register(() => [{ id: "consumer.command", title: "Consumer" }])
    })

    expect(registrations[0]?.options()).toHaveLength(1)
    disposeConsumer()
    expect(registrations).toHaveLength(0)
    disposeProvider()
  })
})
