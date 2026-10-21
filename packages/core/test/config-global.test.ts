import { describe, expect, test } from "bun:test"
import { Config } from "@opencode-ai/core/config"
import { AbsolutePath } from "@opencode-ai/core/schema"

describe("Config.globalLatest", () => {
  test("reads the global value before project configuration", () => {
    const entries = [
      new Config.Document({
        type: "document",
        path: "/config/opencode.json",
        info: new Config.Info({ access_control: { safety_review: { model: "test/global" } } }),
      }),
      new Config.Directory({ type: "directory", path: AbsolutePath.make("/config") }),
      new Config.Document({
        type: "document",
        path: "/project/opencode.json",
        info: new Config.Info({
          access_control: { mode: "approve_for_me", safety_review: { model: "test/project" } },
        }),
      }),
    ]

    expect(Config.latest(entries, "access_control")?.safety_review?.model).toBe("test/project")
    expect(Config.globalLatest(entries, "access_control")?.safety_review?.model).toBe("test/global")
  })

  test("treats marker-free injected entries as global test configuration", () => {
    const entries = [
      new Config.Document({
        type: "document",
        info: new Config.Info({ access_control: { mode: "ask", safety_review: { model: "test/injected" } } }),
      }),
    ]

    expect(Config.globalLatest(entries, "access_control")?.safety_review?.model).toBe("test/injected")
  })
})
