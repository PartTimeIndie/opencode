import { describe, expect, test } from "bun:test"
import {
  CUSTOM_PART_FALLBACK_MAX,
  CUSTOM_PART_TITLE_MAX,
  sanitizeCustomPart,
  type CustomPart,
} from "./custom-part"
import { createPluginCommandOption, scopePluginCommand } from "./commands"
import { ServerConnection } from "@/context/server"
import { isPluginServerActive } from "./server-ownership"

const basePart: CustomPart = {
  id: "part-1",
  sessionID: "session-1",
  messageID: "msg-1",
  type: "custom",
  kind: "demo.kind",
  data: { label: "hello" },
}

describe("sanitizeCustomPart", () => {
  test("bounds title and fallback to documented limits", () => {
    const longTitle = "x".repeat(CUSTOM_PART_TITLE_MAX + 50)
    const longFallback = "y".repeat(CUSTOM_PART_FALLBACK_MAX + 50)

    const sanitized = sanitizeCustomPart({
      ...basePart,
      title: longTitle,
      fallback: longFallback,
    })

    expect(sanitized.title).toHaveLength(CUSTOM_PART_TITLE_MAX)
    expect(sanitized.fallback).toHaveLength(CUSTOM_PART_FALLBACK_MAX)
  })

  test("drops non-string title and fallback rather than coercing", () => {
    const sanitized = sanitizeCustomPart({
      ...basePart,
      // @ts-expect-error — exercise untrusted runtime input
      title: 123,
      // @ts-expect-error — exercise untrusted runtime input
      fallback: { unsafe: "object" },
    })

    expect(sanitized.title).toBeUndefined()
    expect(sanitized.fallback).toBeUndefined()
  })

  test("preserves data, kind, and time verbatim", () => {
    const time = { start: 1, end: 2 }
    const sanitized = sanitizeCustomPart({
      ...basePart,
      title: "ok",
      fallback: "ok",
      metadata: { a: 1 },
      time,
    })

    expect(sanitized.data).toEqual(basePart.data)
    expect(sanitized.kind).toBe(basePart.kind)
    expect(sanitized.metadata).toEqual({ a: 1 })
    expect(sanitized.time).toBe(time)
  })
})

describe("createPluginCommandOption", () => {
  test("preserves shortcut metadata for Settings shortcuts", () => {
    const runs: string[] = []
    const option = createPluginCommandOption({
      id: "shortcutDemo.open",
      title: "Open shortcut demo",
      description: "Opens the shortcut demo panel.",
      category: "Shortcut Demo",
      keybind: "ctrl+alt+x",
      run() {
        runs.push("ran")
      },
    })

    expect(option.id).toBe("shortcutDemo.open")
    expect(option.title).toBe("Open shortcut demo")
    expect(option.description).toBe("Opens the shortcut demo panel.")
    expect(option.category).toBe("Shortcut Demo")
    expect(option.keybind).toBe("ctrl+alt+x")

    option.onSelect?.("keybind")
    expect(runs).toEqual(["ran"])
  })

  test("defaults plugin command category", () => {
    const option = createPluginCommandOption({
      id: "shortcutDemo.default",
      title: "Default category",
      run() {},
    })

    expect(option.category).toBe("Plugins")
  })

  test("preserves press and release callbacks for push-to-talk shortcuts", () => {
    const phases: string[] = []
    const option = createPluginCommandOption({
      id: "speech.record",
      title: "Record speech",
      keybind: "mod+shift+m",
      run() {
        phases.push("run")
      },
      onKeyDown() {
        phases.push("down")
      },
      onKeyUp() {
        phases.push("up")
      },
    })

    option.onKeyDown?.()
    option.onKeyUp?.()
    option.onSelect?.("palette")
    expect(phases).toEqual(["down", "up", "run"])
  })

  test("reports async plugin command failures", async () => {
    const errors: unknown[][] = []
    const original = console.error
    console.error = (...args) => errors.push(args)
    try {
      createPluginCommandOption({
        id: "shortcutDemo.fail",
        title: "Failing command",
        async run() {
          throw new Error("command failed")
        },
      }).onSelect?.("palette")
      await Promise.resolve()
      await Promise.resolve()
    } finally {
      console.error = original
    }

    expect(errors[0]?.[0]).toBe("[plugin-command] shortcutDemo.fail failed")
    expect(errors[0]?.[1]).toBeInstanceOf(Error)
  })

  test("keeps metadata when plugin commands are scoped", () => {
    const option = createPluginCommandOption(
      scopePluginCommand(
        {
          id: "open",
          title: "Open scoped shortcut",
          description: "Opens a scoped shortcut command.",
          category: "Shortcut Demo",
          keybind: "ctrl+alt+o",
          run() {},
        },
        "shortcut-demo.open",
      ),
    )

    expect(option.id).toBe("shortcut-demo.open")
    expect(option.title).toBe("Open scoped shortcut")
    expect(option.description).toBe("Opens a scoped shortcut command.")
    expect(option.category).toBe("Shortcut Demo")
    expect(option.keybind).toBe("ctrl+alt+o")
  })
})

describe("plugin server ownership", () => {
  test("allows host navigation only for the plugin activation's current server", () => {
    const serverA = ServerConnection.Key.make("server-a")
    const serverB = ServerConnection.Key.make("server-b")

    expect(isPluginServerActive(serverA, serverA)).toBe(true)
    expect(isPluginServerActive(serverA, serverB)).toBe(false)
  })
})
