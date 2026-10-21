import { describe, expect, test } from "bun:test"
import type { Platform } from "@/context/platform"
import type { ServerConnection } from "@/context/server"
import { pickQuestionFolders, questionFolderValues } from "./session-question-folder-picker"

const server: ServerConnection.Any = { type: "sidecar", variant: "base", http: { url: "http://localhost:4096" } }
const remote: ServerConnection.Any = { type: "http", http: { url: "http://remote:4096" } }
const base = {
  openLink() {},
  restart: async () => {},
  back() {},
  forward() {},
  notify: async () => {},
}

describe("question folder path selection", () => {
  test("uses the native path dialog on local desktop, single folder by default", async () => {
    const calls: unknown[] = []
    const platform: Platform = {
      ...base,
      platform: "desktop",
      openDirectoryPickerDialog: async (options) => {
        calls.push(options)
        return "C:\\Projects\\Cringebot"
      },
    }
    expect(
      await pickQuestionFolders({
        platform,
        server,
        title: "Project folder",
        pickServer: async () => {
          throw new Error("unexpected server picker")
        },
      }),
    ).toEqual(["C:\\Projects\\Cringebot"])
    expect(calls).toEqual([{ title: "Project folder", multiple: false }])
  })

  test("web and remote desktop use server paths instead of a browser upload", async () => {
    const desktop: Platform = {
      ...base,
      platform: "desktop",
      openDirectoryPickerDialog: async () => {
        throw new Error("unexpected local picker")
      },
    }
    const web: Platform = { ...base, platform: "web" }
    for (const [platform, connection] of [
      [web, server],
      [desktop, remote],
    ] as const) {
      expect(
        await pickQuestionFolders({
          platform,
          server: connection,
          title: "Folder",
          pickServer: async () => "/srv/empty-folder",
        }),
      ).toEqual(["/srv/empty-folder"])
    }
  })

  test("keeps the previous value on cancel or empty selection", () => {
    expect(questionFolderValues(["/previous"], null)).toEqual(["/previous"])
    expect(questionFolderValues(["/previous"], [])).toEqual(["/previous"])
    expect(questionFolderValues(["/previous"], ["", "  "])).toEqual(["/previous"])
  })

  test("replaces a single folder but merges and deduplicates explicitly multiple folders", () => {
    expect(questionFolderValues(["/old"], ["/new", "/extra"])).toEqual(["/new"])
    expect(questionFolderValues(["/old"], ["/new", "/extra"], false)).toEqual(["/new"])
    expect(questionFolderValues(["/old"], ["/old", "/new"], true)).toEqual(["/old", "/new"])
  })

  test("preserves full paths including punctuation, UNC roots and empty directories", () => {
    expect(questionFolderValues([], "C:\\Projects\\name, with; punctuation")).toEqual([
      "C:\\Projects\\name, with; punctuation",
    ])
    expect(questionFolderValues([], "\\\\nas\\share\\empty")).toEqual(["\\\\nas\\share\\empty"])
  })

  test("supports native multiple selection and propagates errors without inventing paths", async () => {
    const platform: Platform = {
      ...base,
      platform: "desktop",
      openDirectoryPickerDialog: async (options) => {
        expect(options?.multiple).toBe(true)
        return ["/one", "/two"]
      },
    }
    expect(
      await pickQuestionFolders({ platform, server, title: "Folders", multiple: true, pickServer: async () => null }),
    ).toEqual(["/one", "/two"])
    await expect(
      pickQuestionFolders({
        platform: {
          ...platform,
          openDirectoryPickerDialog: async () => {
            throw new Error("picker failed")
          },
        },
        server,
        title: "Folder",
        pickServer: async () => null,
      }),
    ).rejects.toThrow("picker failed")
  })
})
