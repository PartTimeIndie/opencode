import { describe, expect, test } from "bun:test"
import { matchesKeybindSearch } from "./settings-keybinds"

describe("Settings keybind search", () => {
  const display = (value: string) =>
    value.replaceAll("mod", "Strg").replaceAll("ctrl", "Strg").replaceAll("shift", "Umschalt")

  test("matches canonical, localized, and separator-free keybind queries", () => {
    expect(matchesKeybindSearch("mod+r", "mod+r", display)).toBe(true)
    expect(matchesKeybindSearch("ctrl+r", "mod+r", display)).toBe(true)
    expect(matchesKeybindSearch("Strg R", "mod+r", display)).toBe(true)
    expect(matchesKeybindSearch("strgr", "mod+r", display)).toBe(true)
  })

  test("matches every configured alternative and rejects unrelated keys", () => {
    expect(matchesKeybindSearch("Strg Alt X", "mod+r,ctrl+alt+x", display)).toBe(true)
    expect(matchesKeybindSearch("Ctrl+Alt+X", "mod+r,ctrl+alt+x", display)).toBe(true)
    expect(matchesKeybindSearch("Ctrl+K", "mod+r,ctrl+alt+x", display)).toBe(false)
    expect(matchesKeybindSearch("Ctrl+R", "ctrl+right", display)).toBe(false)
    expect(matchesKeybindSearch("Ctrl+R", "none", display)).toBe(false)
  })
})
