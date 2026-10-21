import { describe, expect, test } from "bun:test"
import { normalizeWheelDelta, shouldMarkBoundaryGesture, shouldRequestStartHistory } from "./message-gesture"

describe("normalizeWheelDelta", () => {
  test("converts line mode to px", () => {
    expect(normalizeWheelDelta({ deltaY: 3, deltaMode: 1, rootHeight: 500 })).toBe(120)
  })

  test("converts page mode to container height", () => {
    expect(normalizeWheelDelta({ deltaY: -1, deltaMode: 2, rootHeight: 600 })).toBe(-600)
  })

  test("keeps pixel mode unchanged", () => {
    expect(normalizeWheelDelta({ deltaY: 16, deltaMode: 0, rootHeight: 600 })).toBe(16)
  })
})

describe("shouldMarkBoundaryGesture", () => {
  test("marks when nested scroller cannot scroll", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: 20,
        scrollTop: 0,
        scrollHeight: 300,
        clientHeight: 300,
      }),
    ).toBe(true)
  })

  test("marks when scrolling beyond top boundary", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: -40,
        scrollTop: 10,
        scrollHeight: 1000,
        clientHeight: 400,
      }),
    ).toBe(true)
  })

  test("marks when scrolling beyond bottom boundary", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: 50,
        scrollTop: 580,
        scrollHeight: 1000,
        clientHeight: 400,
      }),
    ).toBe(true)
  })

  test("does not mark when nested scroller can consume movement", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: 20,
        scrollTop: 200,
        scrollHeight: 1000,
        clientHeight: 400,
      }),
    ).toBe(false)
  })
})

describe("shouldRequestStartHistory", () => {
  test("requests older history when scrolling up near the timeline start", () => {
    expect(shouldRequestStartHistory({ delta: -40, rootScrollTop: 120 })).toBe(true)
  })

  test("does not request history away from the timeline start", () => {
    expect(shouldRequestStartHistory({ delta: -40, rootScrollTop: 240 })).toBe(false)
  })

  test("does not request history when scrolling down", () => {
    expect(shouldRequestStartHistory({ delta: 40, rootScrollTop: 0 })).toBe(false)
  })

  test("waits for nested scrollables to hit their own top boundary", () => {
    expect(
      shouldRequestStartHistory({
        delta: -40,
        rootScrollTop: 0,
        nested: { scrollTop: 120, scrollHeight: 1000, clientHeight: 400 },
      }),
    ).toBe(false)
    expect(
      shouldRequestStartHistory({
        delta: -40,
        rootScrollTop: 0,
        nested: { scrollTop: 10, scrollHeight: 1000, clientHeight: 400 },
      }),
    ).toBe(true)
  })
})
