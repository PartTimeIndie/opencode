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
  test("portable review fixtures contain synthetic data rather than copied private reviews or chats", () => {
    for (const [name, count, binding] of [["questions", 6, "a"], ["options", 1, "c"]] as const) {
      const source = readFileSync(new URL(`../../../app/e2e/fixtures/daily-review-${name}.json`, import.meta.url), "utf8")
      const payload = JSON.parse(source)
      expect(payload.questions).toHaveLength(count)
      expect(payload.keys).toHaveLength(count)
      expect(payload.binding).toBe(binding.repeat(64))
      expect(source).not.toMatch(/daily-agent-review-\d{4}|Material-Digest|TryCloseAndDrain|PendingPersister|\bPU\b|C:[/\\]+Users/i)
      expect(source.match(/\b[a-f0-9]{64}\b/g)).toEqual([binding.repeat(64)])
      for (const [index, question] of payload.questions.entries()) {
        expect(payload.keys[index]).toMatch(/^fixture-review-/)
        expect(question.body[0].id).toBe(payload.keys[index])
        expect(question.body[0].content).toContain("Example App")
        expect(question.body[0].content).toContain("<details>")
      }
    }
    const endings = JSON.parse(readFileSync(new URL("../session/fixtures/turn-stop-endings.json", import.meta.url), "utf8"))
    expect(endings.map((ending: { expected: string }) => ending.expected)).toEqual(["incomplete", "done", "done"])
    for (const ending of endings) {
      expect(ending.text).toMatch(/synthetisch/i)
      expect(ending.text).not.toMatch(/C:[/\\]+Users|crisc|ses_[a-z0-9]+/i)
    }
    const runner = readFileSync(new URL("../../../core/script/context-budget-model-check.ts", import.meta.url), "utf8")
    expect(runner).not.toMatch(/C:[/\\]+GitRepros|\bPU\b/)
    expect(runner).toContain("Synthetische Referenzauswahl")
  })

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
