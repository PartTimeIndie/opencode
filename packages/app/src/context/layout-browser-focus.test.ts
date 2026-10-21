import { describe, expect, test } from "bun:test"
import { resolveDockActiveTab } from "./layout-dock"

describe("resolveDockActiveTab browser focus", () => {
  test("does not activate the browser as a passive fallback", () => {
    expect(resolveDockActiveTab(["browser"], "plugin/git-workbench", "plugin/git-workbench", ["browser"])).toBeUndefined()
    expect(
      resolveDockActiveTab(["browser", "review"], "plugin/git-workbench", "plugin/git-workbench", ["browser"]),
    ).toBe("review")
  })

  test("keeps the browser active after an explicit activation", () => {
    expect(resolveDockActiveTab(["browser", "review"], "browser", "review")).toBe("browser")
  })
})
