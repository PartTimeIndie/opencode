import { describe, expect, test } from "bun:test"
import { SessionFailure } from "@opencode-ai/core/session/failure"
import { SessionFailureCard } from "@opencode-ai/core/session/failure-card"
import { SurfaceRenderer } from "./renderer"
import { LayoutRegions } from "./layout-regions"

describe("SurfaceRenderer", () => {
  test("error cards expose code, message and a concrete action", () => {
    const rendered = SurfaceRenderer.renderErrorCard(
      SessionFailureCard.fromFailure(SessionFailure.make("provider.transport")),
    )
    expect(rendered.kind).toBe("error-card")
    expect(rendered.widgets[0]).toMatchObject({
      type: "error_card",
      title: "provider.transport",
      action: "Retry",
    })
  })

  test("observed typed failures use the canonical error-card surface", () => {
    const rendered = SurfaceRenderer.renderObservedFailure({
      code: "provider.transport",
      message: "Connection failed.",
      remediation: "retry",
    })
    expect(rendered?.widgets[0]).toEqual({
      type: "error_card",
      title: "provider.transport",
      text: "Connection failed.",
      action: "Retry",
    })
    expect(SurfaceRenderer.renderObservedFailure({ code: "legacy", message: "Legacy failure." })).toBeUndefined()
  })
})

describe("LayoutRegions", () => {
  test("popup-layer may cover timeline/docks but never composer", () => {
    expect(LayoutRegions.canOverlay("popup-layer", "timeline")).toBe(true)
    expect(LayoutRegions.canOverlay("popup-layer", "docks")).toBe(true)
    expect(LayoutRegions.canOverlay("popup-layer", "composer")).toBe(false)
    expect(LayoutRegions.canOverlay("docks", "composer")).toBe(false)
  })

  test("surfaces default to popup-layer unless a dock is requested", () => {
    expect(LayoutRegions.popupFirst(false)).toBe("popup-layer")
    expect(LayoutRegions.popupFirst(true)).toBe("docks")
  })

  test("illegal overlays throw instead of rendering", () => {
    expect(() => LayoutRegions.assertPlacement({ region: "composer", overlay: "popup-layer" })).toThrow(
      "overlay popup-layer cannot cover composer",
    )
  })
})
