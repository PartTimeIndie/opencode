import { describe, expect, test } from "bun:test"
import {
  globalToolbarItemVisible,
  toolbarItemOverride,
  toolbarItemVisible,
  toolbarProjectKey,
  type ToolbarVisibilityState,
} from "./toolbar-visibility"

const state = (): ToolbarVisibilityState => ({ version: 1, global: {}, projects: {} })

describe("toolbar visibility", () => {
  test("does not infer visibility from a plugin identity", () => {
    expect(toolbarItemVisible(state(), "visual-qa-app/visualQa")).toBe(false)
    expect(toolbarItemVisible(state(), "future-plugin/newIcon")).toBe(false)
  })

  test("applies global values and project overrides", () => {
    const value = state()
    const project = toolbarProjectKey("local", "C:\\Repo\\Game")
    value.global["plugin/icon"] = true
    expect(globalToolbarItemVisible(value, "plugin/icon")).toBe(true)
    expect(toolbarItemVisible(value, "plugin/icon", project)).toBe(true)
    expect(toolbarItemOverride(value, project, "plugin/icon")).toBe("inherit")

    value.projects[project] = { "plugin/icon": false }
    expect(toolbarItemVisible(value, "plugin/icon", project)).toBe(false)
    expect(toolbarItemOverride(value, project, "plugin/icon")).toBe("hide")

    value.projects[project]["plugin/icon"] = true
    expect(toolbarItemVisible(value, "plugin/icon", project)).toBe(true)
    expect(toolbarItemOverride(value, project, "plugin/icon")).toBe("show")
  })

  test("allows a plugin to opt into visibility while preserving user overrides", () => {
    const value = state()
    const project = toolbarProjectKey("local", "C:\\Repo\\Speech")
    expect(globalToolbarItemVisible(value, "speech/microphone", true)).toBe(true)
    expect(toolbarItemVisible(value, "speech/microphone", project, true)).toBe(true)
    value.global["speech/microphone"] = false
    expect(globalToolbarItemVisible(value, "speech/microphone", true)).toBe(false)
    expect(toolbarItemVisible(value, "speech/microphone", project, true)).toBe(false)
  })

  test("normalizes Windows project keys without collapsing POSIX case", () => {
    expect(toolbarProjectKey("local", "C:\\Repo\\Game\\")).toBe("local\0c:/repo/game")
    expect(toolbarProjectKey("local", "C:/")).toBe(toolbarProjectKey("local", "C:\\"))
    expect(toolbarProjectKey("local", "\\\\Server\\Share\\Game")).toBe(
      toolbarProjectKey("local", "\\\\SERVER\\SHARE\\GAME\\"),
    )
    expect(toolbarProjectKey("remote", "/Work/Game/")).toBe("remote\0/Work/Game")
    expect(toolbarProjectKey("remote", "///")).toBe(toolbarProjectKey("remote", "/"))
  })
})
