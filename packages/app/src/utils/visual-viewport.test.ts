import { describe, expect, test } from "bun:test"
import { visualViewportBounds } from "./visual-viewport"

describe("visualViewportBounds", () => {
  test("falls back to the layout viewport", () => {
    expect(visualViewportBounds({ innerWidth: 390, innerHeight: 844, visualViewport: null })).toEqual({
      left: 0,
      top: 0,
      width: 390,
      height: 844,
      right: 390,
      bottom: 844,
    })
  })

  test("includes visual viewport offsets while the keyboard is open", () => {
    expect(
      visualViewportBounds({
        innerWidth: 390,
        innerHeight: 844,
        visualViewport: {
          offsetLeft: 3,
          offsetTop: 282,
          width: 384,
          height: 350,
        },
      }),
    ).toEqual({
      left: 3,
      top: 282,
      width: 384,
      height: 350,
      right: 387,
      bottom: 632,
    })
  })
})
