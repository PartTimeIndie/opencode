import { describe, expect, test } from "bun:test"
import { toggleTitlebarDock } from "./titlebar-dock"

function setup() {
  const visible = { top: false, left: true, right: false, bottom: false }
  const state = { review: false, terminal: false, terminalArea: "bottom" }
  return {
    visible, state,
    dock: {
      area: (area: keyof typeof visible) => ({ visible: () => visible[area] }),
      setVisible: (area: keyof typeof visible, value: boolean) => { visible[area] = value },
      item: () => ({ area: () => state.terminalArea }),
    },
    session: {
      reviewPanel: { opened: () => state.review, open: () => { state.review = true } },
      terminal: { open: () => { state.terminal = true }, close: () => { state.terminal = false } },
    },
  }
}

describe("global titlebar dock behavior", () => {
  test("drafts and plugins toggle every dock without a session", () => {
    const input = setup()
    for (const area of ["top", "left", "right", "bottom"] as const) {
      const previous = input.visible[area]
      toggleTitlebarDock({ area, dock: input.dock, fileTreeOpened: false })
      expect(input.visible[area]).toBe(!previous)
    }
    expect(input.state.review).toBe(false)
    expect(input.state.terminal).toBe(false)
  })
  test("opening the right dock retains the active session review fallback", () => {
    const input = setup()
    toggleTitlebarDock({ ...input, area: "right", fileTreeOpened: false })
    expect(input.state.review).toBe(true)
  })
  test("the file tree suppresses the review fallback", () => {
    const input = setup()
    toggleTitlebarDock({ ...input, area: "right", fileTreeOpened: true })
    expect(input.state.review).toBe(false)
  })
  test("bottom toggles the active session terminal only when placed there", () => {
    const input = setup()
    toggleTitlebarDock({ ...input, area: "bottom", fileTreeOpened: false })
    expect(input.state.terminal).toBe(true)
    toggleTitlebarDock({ ...input, area: "bottom", fileTreeOpened: false })
    expect(input.state.terminal).toBe(false)
    input.state.terminalArea = "left"
    toggleTitlebarDock({ ...input, area: "bottom", fileTreeOpened: false })
    expect(input.state.terminal).toBe(false)
  })
})
