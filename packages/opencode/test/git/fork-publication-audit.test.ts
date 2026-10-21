import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { auditForkPublication } from "../../../../script/fork-publication-audit"

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-C", cwd, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "Publication Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Publication Test", GIT_COMMITTER_EMAIL: "test@example.test" },
    stdout: "pipe", stderr: "pipe",
  })
  if (result.exitCode) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

describe("fork publication audit", () => {
  test("audits every indexed path and catches private ancestry even after untracking", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-publication-"))
    try {
      git(root, "init", "--initial-branch=main")
      git(root, "config", "core.autocrlf", "false")
      mkdirSync(join(root, "docs", "plans"), { recursive: true })
      const privateFile = "docs/plans/prototype-fund-antrag-2026.md"
      writeFileSync(join(root, privateFile), "private local work\n")
      writeFileSync(join(root, "product.ts"), "export const product = true\n")
      git(root, "add", ".")
      git(root, "commit", "-m", "accidental private file")
      expect(auditForkPublication({ cwd: root })).toMatchObject({ checked: 2, excluded: [{ file: privateFile, reason: "personal-document" }] })
      git(root, "rm", "--cached", "--", privateFile)
      writeFileSync(join(root, ".gitignore"), "/docs/plans/prototype-fund*\n")
      git(root, "add", ".gitignore")
      git(root, "commit", "-m", "keep private work local")
      expect(readFileSync(join(root, privateFile), "utf8")).toBe("private local work\n")
      expect(auditForkPublication({ cwd: root })).toMatchObject({ checked: 2, excluded: [] })
      expect(auditForkPublication({ cwd: root, ref: "HEAD" }).excluded).toEqual([])
      const report = auditForkPublication({ cwd: root, ref: "HEAD", history: true })
      expect(report.commitsChecked).toBe(2)
      expect(report.historical).toEqual([{ file: privateFile, reason: "personal-document", commit: git(root, "rev-parse", "HEAD^") }])
      expect(git(root, "status", "--porcelain")).toBe("")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("honors ignored tracked paths and fails closed for invalid refs", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-publication-"))
    try {
      git(root, "init", "--initial-branch=main")
      writeFileSync(join(root, ".gitignore"), "local-only.txt\n")
      writeFileSync(join(root, "local-only.txt"), "local state\n")
      git(root, "add", "--force", ".")
      expect(auditForkPublication({ cwd: root }).excluded).toEqual([{ file: "local-only.txt", reason: "git-ignored" }])
      expect(() => auditForkPublication({ cwd: root, ref: "missing" })).toThrow()
      expect(() => auditForkPublication({ cwd: root, history: true })).toThrow("requires --ref")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
