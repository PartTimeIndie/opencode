import { expect, test } from "bun:test"
import { createDoubleTapMatcher } from "./double-tap-matcher"

test("matches two released, genuine taps within 450ms without overlapping pairs", () => {
  const match = createDoubleTapMatcher()
  expect(match({ type: "tap", time: 0, window: "10" })).toBe(false)
  expect(match({ type: "tap", time: 450, window: "10" })).toBe(true)
  expect(match({ type: "tap", time: 451, window: "10" })).toBe(false)
  expect(match({ type: "tap", time: 500, window: "10" })).toBe(true)
})

test("resets on foreign keys, foreground transitions, timeout, and clock regression", () => {
  const match = createDoubleTapMatcher()
  expect(match({ type: "tap", time: 1, window: "10" })).toBe(false)
  expect(match({ type: "reset" })).toBe(false)
  expect(match({ type: "tap", time: 2, window: "10" })).toBe(false)
  expect(match({ type: "tap", time: 3, window: "11" })).toBe(false)
  expect(match({ type: "tap", time: 454, window: "11" })).toBe(false)
  expect(match({ type: "tap", time: 453, window: "11" })).toBe(false)
  expect(match({ type: "tap", time: 460, window: "11" })).toBe(true)
})
