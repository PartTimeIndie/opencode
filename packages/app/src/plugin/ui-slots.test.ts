import { describe, expect, test } from "bun:test"
import { isUISlotID, listUISlotIDs, UI_SLOT_IDS } from "./ui-slots"

describe("ui slots", () => {
  test("lists known app extension slots", () => {
    expect(listUISlotIDs()).toEqual([
      "composer.actions",
      "header.actions",
      "toolbar.actions",
      "session.tab.menu",
    ])
  })

  test("rejects unknown slot names", () => {
    expect(isUISlotID(UI_SLOT_IDS.sessionTabMenu)).toBe(true)
    expect(isUISlotID("session.tab.typo")).toBe(false)
  })
})
