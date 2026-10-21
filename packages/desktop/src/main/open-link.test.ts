import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { localDocumentPath, openDesktopLink } from "./open-link"

describe("desktop document opening", () => {
  test("opens a local PDF with the OS default app, not as an external URL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-link-"))
    try {
      const path = join(directory, "Prüfung #100%.pdf")
      await writeFile(path, "%PDF-1.4\n")
      const opened: string[] = []
      const external: string[] = []
      await openDesktopLink(`${pathToFileURL(path).href}#page=2`, {
        openPath: async (path) => {
          opened.push(path)
          return ""
        },
        openExternal: async (url) => {
          external.push(url)
        },
      })
      expect(opened).toEqual([path])
      expect(external).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("keeps HTTP and Obsidian on the existing external-link path", async () => {
    const external: string[] = []
    const opener = {
      openPath: async () => {
        throw new Error("Unexpected file open")
      },
      openExternal: async (url: string) => {
        external.push(url)
      },
    }
    await openDesktopLink("https://opencode.ai", opener)
    await openDesktopLink("obsidian://open?vault=Notes", opener)
    await openDesktopLink("javascript:alert(1)", opener)
    expect(external).toEqual(["https://opencode.ai", "obsidian://open?vault=Notes"])
  })

  test("decodes Windows and POSIX document paths without treating URL fragments as filenames", () => {
    expect(localDocumentPath("file:///C:/Meine%20Dateien/Pr%C3%BCfung%23%25.PDF#page=3", true)).toBe(
      "C:\\Meine Dateien\\Prüfung#%.PDF",
    )
    expect(localDocumentPath("file:///tmp/Pr%C3%BCfung%20%23.pdf", false)).toBe("/tmp/Prüfung #.pdf")
    expect(localDocumentPath("file://localhost/C:/report.pdf", true)).toBe("C:\\report.pdf")
  })

  test("validates executable, shortcut, remote, device and alternate-stream targets without I/O", () => {
    for (const [url, message] of [
      ["file:///C:/run.exe", "This file type cannot be opened"],
      ["file:///C:/run.cmd", "This file type cannot be opened"],
      ["file:///C:/run.ps1", "This file type cannot be opened"],
      ["file:///C:/run.lnk", "This file type cannot be opened"],
      ["file:///C:/run.url", "This file type cannot be opened"],
      ["file:///C:/run.app", "This file type cannot be opened"],
      ["file:///C:/script.svg", "This file type cannot be opened"],
      ["file://server/share/report.pdf", "Only local document files"],
      ["file:////server/share/report.pdf", "Only local document files"],
      ["file:///C:/report.exe:stream.pdf", "Network, device and alternate-stream"],
      ["file:///C:/report%00.pdf", "Invalid document filename"],
      ["file:///C:/report%2fother.pdf", "File URL path must not include encoded"],
      ["file:///C:/report%5cother.pdf", "File URL path must not include encoded"],
    ]) {
      expect(() => localDocumentPath(url, true)).toThrow(message)
    }
  })

  test("rejects existing executable and active SVG files before the OS opening boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-link-"))
    try {
      const opened: string[] = []
      for (const filename of ["run.exe", "run.cmd", "run.lnk", "script.svg"]) {
        const path = join(directory, filename)
        await writeFile(path, "unsafe file fixture")
        await expect(
          openDesktopLink(pathToFileURL(path).href, {
            openPath: async (path) => {
              opened.push(path)
              return ""
            },
            openExternal: async (url) => {
              opened.push(url)
            },
          }),
        ).rejects.toThrow("This file type cannot be opened")
      }
      expect(opened).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("reports missing files, directories and OS association failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-link-"))
    try {
      const opened: string[] = []
      const opener = {
        openPath: async (path: string) => {
          opened.push(path)
          return "No application associated"
        },
        openExternal: async () => {},
      }
      const missing = join(directory, "missing.pdf")
      await expect(openDesktopLink(pathToFileURL(missing).href, opener)).rejects.toThrow("ENOENT")
      expect(opened).toEqual([])
      const folder = join(directory, "folder.pdf")
      await mkdir(folder)
      await expect(openDesktopLink(pathToFileURL(folder).href, opener)).rejects.toThrow("regular document file")
      expect(opened).toEqual([])
      const path = join(directory, "report.pdf")
      await writeFile(path, "%PDF-1.4\n")
      await expect(openDesktopLink(pathToFileURL(path).href, opener)).rejects.toThrow("No application associated")
      expect(opened).toEqual([path])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("rejects encoded separators even when the decoded PDF target exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-link-"))
    try {
      await mkdir(join(directory, "nested"))
      const path = join(directory, "nested", "report.pdf")
      await writeFile(path, "%PDF-1.4\n")
      const opened: string[] = []
      const encoded = pathToFileURL(path).href.replace("/report.pdf", "%2freport.pdf")
      await expect(
        openDesktopLink(encoded, {
          openPath: async (path) => {
            opened.push(path)
            return ""
          },
          openExternal: async (url) => {
            opened.push(url)
          },
        }),
      ).rejects.toThrow("File URL path must not include encoded")
      expect(opened).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
