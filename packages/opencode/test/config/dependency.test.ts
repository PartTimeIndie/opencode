import { describe, expect, test } from "bun:test"
import { pluginDependency } from "@/config/dependency"

describe("pluginDependency", () => {
  test("uses the matching plugin package for published releases", () => {
    expect(pluginDependency("1.17.8", false)).toEqual({
      add: [{ name: "@opencode-ai/plugin", version: "1.17.8" }],
    })
  })

  test("keeps the project-declared plugin package for timestamped internal builds", () => {
    expect(pluginDependency("0.0.0-prod-202608301043", false)).toEqual({
      add: [],
    })
  })

  test("uses the workspace plugin contract for local runtimes", () => {
    expect(pluginDependency("local", true)).toEqual({
      add: [],
      provided: ["@opencode-ai/plugin"],
    })
  })
})
