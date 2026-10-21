import { describe, expect, test } from "bun:test"
import { dockItemIsRendered, repairedActiveAfterClose } from "./layout-dock"

describe("dockItemIsRendered", () => {
  test("requires a visible active pane and an open area on desktop", () => {
    const pane = {
      id: "handoff-pane",
      area: "right" as const,
      itemVisible: true,
      mobile: false,
      mobileOpened: false,
      areaVisible: true,
      areaActiveItem: "handoff-pane",
    }

    expect(dockItemIsRendered(pane)).toBe(true)
    expect(dockItemIsRendered({ ...pane, areaActiveItem: "review" })).toBe(false)
    expect(dockItemIsRendered({ ...pane, areaVisible: false })).toBe(false)
    expect(dockItemIsRendered({ ...pane, itemVisible: false })).toBe(false)
    expect(dockItemIsRendered({ ...pane, area: "middle", areaVisible: false })).toBe(true)
  })

  test("requires the mobile dock to be open on the active pane", () => {
    const pane = {
      id: "handoff-pane",
      area: "right" as const,
      itemVisible: true,
      mobile: true,
      mobileOpened: true,
      mobileActiveItem: "handoff-pane",
      areaVisible: false,
    }

    expect(dockItemIsRendered(pane)).toBe(true)
    expect(dockItemIsRendered({ ...pane, mobileOpened: false })).toBe(false)
    expect(dockItemIsRendered({ ...pane, mobileActiveItem: "review" })).toBe(false)
  })
})

describe("repairedActiveAfterClose", () => {
  test("repairs a closed active tab to the next visible pane", () => {
    const visible = (id: string) => id !== "closed-helper"
    expect(repairedActiveAfterClose(["handoff-pane", "review"], "review", "review", visible)).toBe("handoff-pane")
    expect(repairedActiveAfterClose(["handoff-pane", "review"], "handoff-pane", "review", visible)).toBe("handoff-pane")
    expect(repairedActiveAfterClose(["review", "closed-helper"], "review", "review", visible)).toBe("closed-helper")
    expect(repairedActiveAfterClose(["review"], "review", "review", () => false)).toBeUndefined()
  })

  test("prefers a renderable live pane over a visible orphan and skips passive panes", () => {
    const tabs = ["orphan-handoff", "live-handoff", "review"]
    const visible = () => true
    const renderable = (id: string) => id !== "orphan-handoff"
    expect(
      repairedActiveAfterClose(tabs, "review", "review", visible, { isRenderable: renderable }),
    ).toBe("live-handoff")
    expect(
      repairedActiveAfterClose(["review", "browser"], "review", "review", visible, { passive: ["browser"] }),
    ).toBe("browser")
    expect(
      repairedActiveAfterClose(["review", "browser", "live-handoff"], "review", "review", visible, {
        passive: ["browser"],
      }),
    ).toBe("live-handoff")
  })
})
