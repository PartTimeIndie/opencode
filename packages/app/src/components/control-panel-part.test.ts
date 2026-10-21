import { describe, expect, test } from "bun:test"
import {
  controlPanelExpectation,
  controlPanelTitle,
  shouldDockControlPanel,
  splitControlPanelControls,
} from "@/utils/control-panel-presentation"

describe("ControlPanelPart", () => {
  test("preserves a host-provided purpose title for confirmed agent handoffs", () => {
    expect(controlPanelTitle("Daily Review: all accepted items", true)).toBe("Daily Review: all accepted items")
    expect(controlPanelTitle(undefined, true)).toBe("Agent switch request")
    expect(controlPanelTitle("Informational surface", false)).toBe("Informational surface")
  })

  test("marks pure review content as requiring no action", () => {
    const controls = [{ id: "review", type: "review_section", label: "Review", content: "Current status" }]

    expect(controlPanelExpectation(controls)).toBe("Erwartet: Keine Aktion nötig")
    expect(splitControlPanelControls(controls).information).toHaveLength(1)
    expect(splitControlPanelControls(controls).actions).toHaveLength(0)
  })

  test("separates decisions from information and removes identical duplicate blocks", () => {
    const controls = [
      { id: "review", type: "review_section", label: "Review", content: "Current status" },
      { id: "review-copy", type: "review_section", label: "Review", content: "Current status" },
      { id: "decision", type: "pick_one", label: "Freigabe wählen", options: [{ label: "Ja" }] },
    ]

    expect(controlPanelExpectation(controls)).toBe("Erwartet: Freigabe wählen")
    expect(splitControlPanelControls(controls).information).toHaveLength(1)
    expect(splitControlPanelControls(controls).actions).toHaveLength(1)
  })

  test("keeps distinct interactive controls with the same type and label", () => {
    const controls = [
      { id: "music", type: "slider", label: "Volume", min: 0, max: 100, value: 40 },
      { id: "effects", type: "slider", label: "Volume", min: 0, max: 100, value: 70 },
    ]

    expect(splitControlPanelControls(controls).information).toHaveLength(0)
    expect(splitControlPanelControls(controls).actions).toEqual(controls)
    expect(controlPanelExpectation(controls)).toBe("Erwartet: Volume · Volume")
  })

  test("opens control panels as popups unless docking is explicit or already pinned", () => {
    expect(shouldDockControlPanel({})).toBe(false)
    expect(shouldDockControlPanel({ dock: false })).toBe(false)
    expect(shouldDockControlPanel({ dock: true })).toBe(true)
    expect(shouldDockControlPanel({ pinned: true })).toBe(true)
  })
})
