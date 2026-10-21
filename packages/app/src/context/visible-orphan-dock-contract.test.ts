import { describe, expect, test } from "bun:test"
import { repairedActiveAfterClose, dockItemIsRendered } from "./layout-dock"

describe("visible orphan dock helper contracts", () => {
  test("repairedActiveAfterClose skips visible orphan when renderable pane exists", () => {
    const tabs = ["pane-a", "pane-b", "pane-c"]
    const active = "pane-c"
    const isVisible = (id: string) => id === "pane-a" || id === "pane-b"
    const registeredPanes = new Set(["pane-b"])
    const isRenderable = (id: string) => registeredPanes.has(id)

    // Closing pane-c should repair to renderable pane-b (not visible orphan pane-a)
    const result = repairedActiveAfterClose(tabs, active, "pane-c", isVisible, {
      isRenderable,
      passive: ["browser"],
    })
    expect(result).toBe("pane-b")
  })

  test("does not reactivate a visible orphan when no registered pane remains", () => {
    const result = repairedActiveAfterClose(
      ["review", "control-panel:orphan"],
      "review",
      "review",
      () => true,
      { isRenderable: () => false },
    )

    expect(result).toBeUndefined()
  })

  test("dockItemIsRendered reports false for invisible pane", () => {
    expect(dockItemIsRendered({
      id: "pane-x",
      area: "middle",
      itemVisible: false,
      mobile: false,
      mobileOpened: false,
      areaVisible: true,
      areaActiveItem: "pane-x",
    })).toBe(false)
  })

  test("dockItemIsRendered reports true for visible active middle pane", () => {
    expect(dockItemIsRendered({
      id: "pane-x",
      area: "middle",
      itemVisible: true,
      mobile: false,
      mobileOpened: false,
      areaVisible: true,
      areaActiveItem: "pane-x",
    })).toBe(true)
  })
})
