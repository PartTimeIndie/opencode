import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CodexImageGeneration } from "@opencode-ai/core/image-generation/codex"

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
const OWN_ID = "01a10138-94a6-7c52-83e5-aa7d8686e0cb"
const FOREIGN_ID = "01a10999-1111-7c52-83e5-aa7d8686e0ff"
const EVENTS = `{"type":"thread.started","thread_id":"${OWN_ID}"}\n{"type":"turn.started"}\n`

// Explicit capability probes: file symlinks usually need privileges on
// Windows, while directory junctions normally do not. Each fixture class is
// skipped independently when this account cannot create it, so a missing
// privilege is reported as a skip, never as a security pass.
const FILE_LINKS_OK = await (async () => {
  const probe = await fs.mkdtemp(path.join(os.tmpdir(), "codex-probe-f-"))
  try {
    const target = path.join(probe, "t.txt")
    await fs.writeFile(target, "x")
    await fs.symlink(target, path.join(probe, "l.txt"), "file")
    return true
  } catch {
    return false
  } finally {
    await fs.rm(probe, { recursive: true, force: true })
  }
})()

const JUNCTIONS_OK = await (async () => {
  const probe = await fs.mkdtemp(path.join(os.tmpdir(), "codex-probe-j-"))
  try {
    const dir = path.join(probe, "jd")
    await fs.mkdir(dir, { recursive: true })
    await fs.symlink(dir, path.join(probe, "jl"), "junction")
    return true
  } catch {
    return false
  } finally {
    await fs.rm(probe, { recursive: true, force: true })
  }
})()

async function freshImage(home: string, threadID: string, name: string, bytes = PNG_MAGIC) {
  const dir = path.join(home, "generated_images", threadID)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await fs.writeFile(file, bytes)
  return file
}

describe("codex resolver host-runtime selection", () => {
  const npmShim = "C:/Users/x/AppData/Roaming/npm/codex.cmd"
  const nativeExe = "C:/Users/x/AppData/Local/OpenAI/Codex/bin/abc/codex.exe"

  test("native exe wins first and needs no JS runtime", () => {
    const entry = CodexImageGeneration.codexEntryFor(nativeExe, { hasCodexJs: false, execPath: "C:/app/OpenCode.exe" })
    expect(entry).toEqual({ command: nativeExe, prefixArgs: [] })
  })

  test("npm shim with codex.js uses bun/node runtimes but never an Electron host binary", () => {
    expect(CodexImageGeneration.jsRuntimeFor("C:/app/OpenCode.exe")).toBeUndefined()
    expect(CodexImageGeneration.jsRuntimeFor("C:/Program Files/nodejs/node.exe")).toBe("C:/Program Files/nodejs/node.exe")
    expect(CodexImageGeneration.jsRuntimeFor("C:/app/OpenCode.exe", "C:/Program Files/nodejs/node.exe")).toBe("C:/Program Files/nodejs/node.exe")
    const bun = CodexImageGeneration.codexEntryFor(npmShim, { hasCodexJs: true, execPath: "C:/bun/bun.exe" })
    expect(bun.command).toBe("C:/bun/bun.exe")
    expect(bun.prefixArgs).toHaveLength(1)
    const node = CodexImageGeneration.codexEntryFor(npmShim, { hasCodexJs: true, execPath: "C:/app/OpenCode.exe", nodePath: "C:/Program Files/nodejs/node.exe" })
    expect(node.command).toBe("C:/Program Files/nodejs/node.exe")
  })

  test("shim without any real runtime fails with an honest error instead of spawning the host", () => {
    expect(() => CodexImageGeneration.codexEntryFor(npmShim, { hasCodexJs: true, execPath: "C:/app/OpenCode.exe" }))
      .toThrow(/not a JS runtime/)
  })

  test("candidate order prefers the native exe over the npm shim on Windows", () => {
    expect(CodexImageGeneration.codexCandidates("win32")).toEqual(["codex.exe", "codex.cmd", "codex"])
    expect(CodexImageGeneration.codexCandidates("linux")).toEqual(["codex"])
  })

  test("cmd shims route through ComSpec when no codex.js exists", () => {
    const entry = CodexImageGeneration.codexEntryFor(npmShim, { hasCodexJs: false, execPath: "C:/app/OpenCode.exe" })
    expect(entry.prefixArgs).toEqual(["/d", "/s", "/c", npmShim])
  })
})

describe("codex image adapter argument contract", () => {
  test("json events, trust-check skip, workdir, response file and prompt are pinned", () => {
    const args = CodexImageGeneration.codexArguments({
      root: "C:/tmp/run",
      response: "C:/tmp/run/codex-response.txt",
      model: "gpt-x",
      prompt: "brief",
    })
    expect(args[0]).toBe("exec")
    expect(args).toContain("--ephemeral")
    expect(args).toContain("--skip-git-repo-check")
    expect(args).toContain("--json")
    const cd = args.indexOf("--cd")
    expect(args[cd + 1]).toBe("C:/tmp/run")
    const lastMessage = args.indexOf("--output-last-message")
    expect(args[lastMessage + 1]).toBe("C:/tmp/run/codex-response.txt")
    expect(args).toContain("--model")
    expect(args[args.length - 1]).toBe("brief")
  })
})

describe("thread attribution from structured events", () => {
  test("reads the own thread id and ignores noise", () => {
    expect(CodexImageGeneration.threadIDFromEvents(EVENTS)).toBe(OWN_ID)
    expect(CodexImageGeneration.threadIDFromEvents("not json\n{\"type\":\"turn.started\"}")).toBeUndefined()
    expect(CodexImageGeneration.threadIDFromEvents('{"type":"thread.started"}')).toBeUndefined()
    expect(CodexImageGeneration.threadIDFromEvents("")).toBeUndefined()
  })

  test("rejects thread ids that could escape the artifacts root", () => {
    expect(CodexImageGeneration.validThreadID("../../escalate")).toBe(false)
    expect(CodexImageGeneration.validThreadID("C:\\Users\\x\\generated_images")).toBe(false)
    expect(CodexImageGeneration.validThreadID("ses with space")).toBe(false)
    expect(CodexImageGeneration.validThreadID(OWN_ID)).toBe(true)
  })
})

describe("run-scoped artifact attribution", () => {
  test("two parallel runs: only the own thread image is collected, never the foreign one", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-par-"))
    try {
      await freshImage(home, FOREIGN_ID, "foreign.png")
      // The foreign image is even newer than the own one.
      await new Promise((resolve) => setTimeout(resolve, 30))
      const ownFile = await freshImage(home, OWN_ID, "exec-own.png")
      const files = await CodexImageGeneration.runImageArtifacts({ threadID: OWN_ID, startedAt: Date.now() - 60_000, homeDir: home })
      expect(files).toEqual([ownFile])
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("foreign fresh image with own run missing stays empty", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-fn-"))
    try {
      await freshImage(home, FOREIGN_ID, "foreign.png")
      const files = await CodexImageGeneration.runImageArtifacts({ threadID: OWN_ID, startedAt: Date.now() - 60_000, homeDir: home })
      expect(files).toEqual([])
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test.skipIf(!FILE_LINKS_OK)("symlinked file entries inside the thread directory are not followed", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-sym-"))
    try {
      const external = path.join(home, "fixture-external")
      await fs.mkdir(external, { recursive: true })
      const outsideImage = path.join(external, "target.png")
      await fs.writeFile(outsideImage, PNG_MAGIC)
      await freshImage(home, OWN_ID, "real.png")
      await fs.symlink(outsideImage, path.join(home, "generated_images", OWN_ID, "link.png"), "file")
      const files = await CodexImageGeneration.runImageArtifacts({ threadID: OWN_ID, startedAt: Date.now() - 60_000, homeDir: home })
      expect(files).toEqual([path.join(home, "generated_images", OWN_ID, "real.png")])
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test.skipIf(!JUNCTIONS_OK)("a thread directory junction to an external fixture is rejected", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-junc-"))
    try {
      const external = path.join(home, "fixture-external")
      await fs.mkdir(external, { recursive: true })
      await fs.writeFile(path.join(external, "real.png"), PNG_MAGIC)
      await fs.mkdir(path.join(home, "generated_images"), { recursive: true })
      await fs.symlink(external, path.join(home, "generated_images", OWN_ID), "junction")
      const files = await CodexImageGeneration.runImageArtifacts({ threadID: OWN_ID, startedAt: Date.now() - 60_000, homeDir: home })
      expect(files).toEqual([])
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})

describe("success-only run image collection", () => {
  test("CLI exit != 0 fails closed even when a foreign fresh image exists", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-fc-"))
    try {
      await freshImage(home, FOREIGN_ID, "foreign.png")
      const image = await CodexImageGeneration.collectRunImage({
        exitCode: 1,
        stdout: EVENTS,
        output: path.join(home, "missing.png"),
        runRoot: home,
        startedAt: Date.now() - 60_000,
        homeDir: home,
      })
      expect(image).toBeUndefined()
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("own run with valid image wins; foreign image and fresh junk are ignored", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-own-"))
    try {
      await freshImage(home, OWN_ID, "exec-own.png")
      await fs.writeFile(path.join(home, "generated_images", OWN_ID, "notes.txt"), "not an image")
      await freshImage(home, FOREIGN_ID, "foreign.png")
      const image = await CodexImageGeneration.collectRunImage({
        exitCode: 0,
        stdout: EVENTS,
        output: path.join(home, "missing.png"),
        runRoot: path.join(home, "run-root"),
        startedAt: Date.now() - 60_000,
        homeDir: home,
      })
      expect(image?.mime).toBe("image/png")
      expect(Buffer.from(image?.data ?? []).subarray(0, 8)).toEqual(PNG_MAGIC.subarray(0, 8))
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("abort-shaped null exit code fails closed", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-ab-"))
    try {
      await freshImage(home, OWN_ID, "exec-own.png")
      const image = await CodexImageGeneration.collectRunImage({
        exitCode: null,
        stdout: EVENTS,
        output: path.join(home, "missing.png"),
        runRoot: home,
        startedAt: Date.now() - 60_000,
        homeDir: home,
      })
      expect(image).toBeUndefined()
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("a direct output file written by the model inside the run root is preferred", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-dir-"))
    try {
      const runRoot = path.join(home, "run-root")
      await fs.mkdir(runRoot, { recursive: true })
      const direct = path.join(runRoot, "image.png")
      await fs.writeFile(direct, PNG_MAGIC)
      const image = await CodexImageGeneration.collectRunImage({
        exitCode: 0,
        stdout: EVENTS,
        output: direct,
        runRoot,
        startedAt: Date.now() - 60_000,
        homeDir: home,
      })
      expect(image?.mime).toBe("image/png")
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test.skipIf(!FILE_LINKS_OK)("a symlinked direct output is rejected even when it points at a valid image", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-dsy-"))
    try {
      const external = path.join(home, "fixture-external")
      await fs.mkdir(external, { recursive: true })
      const outsideImage = path.join(external, "real.png")
      await fs.writeFile(outsideImage, PNG_MAGIC)
      const runRoot = path.join(home, "run-root")
      await fs.mkdir(runRoot, { recursive: true })
      const output = path.join(runRoot, "image.png")
      await fs.symlink(outsideImage, output, "file")
      const image = await CodexImageGeneration.collectRunImage({
        exitCode: 0,
        stdout: EVENTS,
        output,
        runRoot,
        startedAt: Date.now() - 60_000,
        homeDir: home,
      })
      expect(image).toBeUndefined()
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("an oversized direct output file is never read", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-big-"))
    try {
      const runRoot = path.join(home, "run-root")
      await fs.mkdir(runRoot, { recursive: true })
      const direct = path.join(runRoot, "image.png")
      const oversized = Buffer.concat([PNG_MAGIC, Buffer.alloc(9 * 1024 * 1024)])
      await fs.writeFile(direct, oversized)
      const image = await CodexImageGeneration.collectRunImage({
        exitCode: 0,
        stdout: EVENTS,
        output: direct,
        runRoot,
        startedAt: Date.now() - 60_000,
        homeDir: home,
      })
      expect(image).toBeUndefined()
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("an oversized thread artifact is skipped in favor of nothing", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bigt-"))
    try {
      const dir = path.join(home, "generated_images", OWN_ID)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, "exec-huge.png"), Buffer.concat([PNG_MAGIC, Buffer.alloc(9 * 1024 * 1024)]))
      const image = await CodexImageGeneration.collectRunImage({
        exitCode: 0,
        stdout: EVENTS,
        output: path.join(home, "missing.png"),
        runRoot: path.join(home, "run-root"),
        startedAt: Date.now() - 60_000,
        homeDir: home,
      })
      expect(image).toBeUndefined()
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})
