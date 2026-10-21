import { describe, expect, test } from "bun:test"
import { resolveSessionRename } from "./session-rename"

describe("resolveSessionRename", () => {
  test("trims a changed title", () => {
    expect(resolveSessionRename("Old title", "  New title  ")).toEqual({ status: "changed", title: "New title" })
  })

  test("treats the displayed title as unchanged after trimming", () => {
    expect(resolveSessionRename(" Old title ", "  Old title  ")).toEqual({ status: "unchanged" })
  })

  test("rejects a blank title", () => {
    expect(resolveSessionRename("Old title", " \n\t ")).toEqual({ status: "empty" })
  })

  test("release rename paths do not depend on global prompt", async () => {
    const sources = await Promise.all(
      [
        new URL("./titlebar.tsx", import.meta.url),
        new URL("../pages/session/session-dock-shell.tsx", import.meta.url),
        new URL("../../../../.opencode/plugin-sources/session-navigator-app/index.js", import.meta.url),
      ].map((url) => Bun.file(url).text()),
    )
    expect(sources.every((source) => !source.includes("window.prompt"))).toBe(true)
  })
})
