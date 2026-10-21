import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isManualInstructionPath, readManualInstructionFile } from "@/agent/agent"
import { supportsSymlinks } from "../lib/symlink"

const roots: string[] = []
const symlinksSupported = await supportsSymlinks()
afterAll(async () => Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))))

describe("manual agent instructions", () => {
  test("loads only canonical Markdown files inside the project", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-agent-instructions-"))
    roots.push(root)
    await fs.writeFile(path.join(root, "AGENTS.md"), "safe instructions")
    await fs.writeFile(path.join(root, "system.prompt"), "safe prompt")
    await fs.writeFile(path.join(root, "completion.txt"), "safe completion")
    await fs.writeFile(path.join(root, ".env"), "SECRET=value")

    expect(await readManualInstructionFile(root, "AGENTS.md")).toMatchObject({ content: "safe instructions" })
    expect(await readManualInstructionFile(root, "system.prompt")).toMatchObject({ content: "safe prompt" })
    expect(await readManualInstructionFile(root, "completion.txt")).toMatchObject({ content: "safe completion" })
    expect(await readManualInstructionFile(root, ".env")).toBeUndefined()
    expect(await readManualInstructionFile(root, "../outside.md")).toBeUndefined()
    expect(isManualInstructionPath(root, path.join(root, "instructions.md"), path.join(root, ".env"))).toBe(false)
  })

  test("allows an explicitly configured absolute shared prompt path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-agent-project-"))
    const shared = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-agent-shared-"))
    roots.push(root, shared)
    const prompt = path.join(shared, "live-bot.md")
    await fs.writeFile(prompt, "shared live bot prompt")

    expect(await readManualInstructionFile(root, prompt)).toMatchObject({
      canonical: await fs.realpath(prompt),
      content: "shared live bot prompt",
    })
  })

  test.skipIf(!symlinksSupported)("rejects a Markdown-named symlink to a non-Markdown file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-agent-instruction-link-"))
    roots.push(root)
    await fs.writeFile(path.join(root, ".env"), "SECRET=value")
    await fs.symlink(path.join(root, ".env"), path.join(root, "instructions.md"), "file")

    expect(await readManualInstructionFile(root, "instructions.md")).toBeUndefined()
  })
})
