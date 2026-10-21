import { base64Encode } from "@opencode-ai/core/util/encode"
import { describe, expect, test } from "bun:test"
import type { Tab } from "@/context/tabs-domain"
import { ServerConnection } from "@/context/server"
import { resolveActivePluginDirectories } from "./app-directories"

const serverKey = ServerConnection.Key.make

const sessionTab = (directory: string, sessionId: string, server = serverKey("local")): Tab => ({
  type: "session",
  server,
  dirBase64: base64Encode(directory),
  sessionId,
})

const draftTab = (directory: string, draftID: string, server = serverKey("local")): Tab => ({
  type: "draft",
  server,
  directory,
  draftID,
})

describe("resolveActivePluginDirectories", () => {
  test("keeps the route directory first and caps inactive tab directories", () => {
    expect(
      resolveActivePluginDirectories({
        routeDirectory: "C:/repo/current",
        maxTabDirectories: 2,
        tabs: [
          sessionTab("C:/repo/a", "a"),
          sessionTab("C:/repo/b", "b"),
          sessionTab("C:/repo/c", "c"),
          sessionTab("C:/repo/d", "d"),
        ],
      }),
    ).toEqual(["C:/repo/current", "C:/repo/d", "C:/repo/c"])
  })

  test("deduplicates route and tab directories without consuming the cap", () => {
    expect(
      resolveActivePluginDirectories({
        routeDirectory: "C:/repo/current",
        maxTabDirectories: 2,
        tabs: [
          sessionTab("C:/repo/old", "old"),
          sessionTab("C:/repo/current", "current"),
          draftTab("C:/repo/recent", "recent"),
        ],
      }),
    ).toEqual(["C:/repo/current", "C:/repo/recent", "C:/repo/old"])
  })

  test("ignores tabs from inactive servers", () => {
    expect(
      resolveActivePluginDirectories({
        server: serverKey("current"),
        tabs: [
          sessionTab("C:/repo/other-server", "other", serverKey("other")),
          draftTab("C:/repo/current-server", "current", serverKey("current")),
        ],
      }),
    ).toEqual(["C:/repo/current-server"])
  })
})
