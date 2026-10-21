import { expect, test } from "bun:test"
import { goalDockSpacing } from "./session-goal-dock"

test("goal tray does not overlap the running model row", () => {
  expect(goalDockSpacing(true)).toEqual({ marginBottom: "0", paddingBottom: "0.5rem" })
  expect(goalDockSpacing(false)).toEqual({ marginBottom: "-0.875rem", paddingBottom: "1.75rem" })
})
