import { describe, expect, test } from "bun:test"
import { execFile, spawnSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { archiveEntryPath, extractArchiveAttachment } from "@opencode-ai/core/session/archive-attachment"
import { tmpdir } from "./fixture/tmpdir"

const run = promisify(execFile)
const libarchive = String(spawnSync("tar", ["--version"], { windowsHide: true }).stdout).includes("bsdtar")

describe("archive attachments", () => {
  for (const format of ["zip", "7zip", "ustar"]) {
    test.skipIf(format !== "ustar" && !libarchive)(`extracts real ${format} bytes without changing the source`, async () => {
      await using tmp = await tmpdir()
      const source = path.join(tmp.path, "source")
      await mkdir(path.join(source, "Save"), { recursive: true })
      await writeFile(path.join(source, "Save", "savefile"), '{"cards":[1,2]}')
      const archive = path.join(tmp.path, "input.archive")
      await run("tar", ["--format", format, "-cf", archive, "-C", source, "Save"], { windowsHide: true })
      const bytes = await readFile(archive)
      const result = await extractArchiveAttachment({
        bytes,
        root: path.join(tmp.path, "extracted"),
        name: "savegame.7z",
      })
      expect(await readFile(path.join(result.directory, "Save", "savefile"), "utf8")).toBe('{"cards":[1,2]}')
      expect(result.files).toEqual([{ name: "Save/savefile", bytes: 15 }])
      expect(result.text).toContain(result.directory)
      expect(result.text).toContain("untrusted user-supplied files")
      expect(await readFile(archive)).toEqual(bytes)
    })
  }

  for (const name of [
    "../escape",
    "/absolute",
    "C:/escape",
    "a/../../escape",
    "a\\escape",
    "a/CON.txt",
    "a/file:stream",
    "a/name.",
    "a/*",
  ]) {
    test(`rejects unsafe path ${name}`, () => {
      expect(() => archiveEntryPath(name)).toThrow()
    })
  }

  for (const fixture of [
    "H4sIAAAAAAAC/+3NMQoCMRQE0BzFE8QsRu+zSPrFfMHj+7ESewXZ95oZpplaj2Ne123UeET5jpYuvb8yfWbqbz33pS3nUzm08gP3Gest78s+xZhRAAAAAAAAAAAA+DtPZ57H8wAoAAA=",
    "H4sIAAAAAAAC/+3OOw5AQAAE0D2KE/hluY+EQgiJz/1tlNQKyXvNTDczj8sUPlYmbYx3Js9896qMdROyOs+L9Tz2sR++O3fuR7el+QAAAAAAAAAAAAD/cQFrinWuACgAAA==",
  ]) {
    test("rejects real traversal or symlink archive without creating an outside file", async () => {
      await using tmp = await tmpdir()
      await expect(
        extractArchiveAttachment({
          bytes: Buffer.from(fixture, "base64"),
          root: path.join(tmp.path, "extracted"),
          name: "unsafe.tgz",
        }),
      ).rejects.toThrow()
      expect(await Bun.file(path.join(tmp.path, "escape.txt")).exists()).toBe(false)
    })
  }

  test.skipIf(!libarchive)("bounds decompression output", async () => {
    await using tmp = await tmpdir()
    await writeFile(path.join(tmp.path, "large"), Buffer.alloc(17 * 1024 * 1024))
    const archive = path.join(tmp.path, "large.zip")
    await run("tar", ["--format", "zip", "-cf", archive, "-C", tmp.path, "large"], { windowsHide: true })
    await expect(
      extractArchiveAttachment({
        bytes: await readFile(archive),
        root: path.join(tmp.path, "extracted"),
        name: "large.zip",
      }),
    ).rejects.toThrow()
  })
})
