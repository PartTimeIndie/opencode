import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { transferForkTree } from "../../../../script/fork-transfer"

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-C", cwd, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "Fork Test", GIT_AUTHOR_EMAIL: "fork@example.test", GIT_COMMITTER_NAME: "Fork Test", GIT_COMMITTER_EMAIL: "fork@example.test" },
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "opencode-fork-transfer-"))
  const source = join(root, "source")
  const target = join(root, "target")
  mkdirSync(source)
  git(source, "init", "--initial-branch=main")
  git(source, "config", "core.autocrlf", "false")
  writeFileSync(join(source, "kept.txt"), "clean base\n")
  writeFileSync(join(source, "cdp-eval.mjs"), "base scratch\n")
  git(source, "add", ".")
  git(source, "commit", "-m", "clean base")
  const base = git(source, "rev-parse", "HEAD")
  git(source, "checkout", "--orphan", "dev")
  git(source, "rm", "-rf", ".")
  writeFileSync(join(source, "kept.txt"), "current development\n")
  writeFileSync(join(source, "cdp-eval.mjs"), "current scratch\n")
  writeFileSync(join(source, ".gitignore"), ".agent-tmp/\n")
  mkdirSync(join(source, ".agent-tmp"))
  writeFileSync(join(source, ".agent-tmp", "private.json"), "private evidence\n")
  mkdirSync(join(source, "e2e", "test-results-old"), { recursive: true })
  writeFileSync(join(source, "e2e", "test-results-old", "trace.json"), "old test output\n")
  git(source, "add", "--force", ".")
  git(source, "commit", "-m", "unrelated local history")
  const ref = git(source, "rev-parse", "HEAD")
  git(source, "worktree", "add", "--detach", target, "main")
  return { root, source, target, ref, base }
}

describe("fork tree transfer implementation", () => {
  test("dry run does not change the target", () => {
    const input = fixture()
    try {
      const report = transferForkTree(input)
      expect(report.included).toBe(2)
      expect(report.excluded).toHaveLength(3)
      expect(readFileSync(join(input.target, "kept.txt"), "utf8")).toBe("clean base\n")
      expect(git(input.target, "status", "--porcelain")).toBe("")
    } finally {
      rmSync(input.root, { recursive: true, force: true })
    }
  })

  test("copies current files onto the clean ancestry without old evidence or history", () => {
    const input = fixture()
    try {
      transferForkTree({ ...input, apply: true })
      expect(readFileSync(join(input.target, "kept.txt"), "utf8")).toBe("current development\n")
      expect(existsSync(join(input.target, "cdp-eval.mjs"))).toBe(false)
      expect(existsSync(join(input.target, ".agent-tmp"))).toBe(false)
      expect(existsSync(join(input.target, "e2e", "test-results-old"))).toBe(false)
      expect(git(input.source, "rev-parse", "HEAD")).toBe(input.ref)
      expect(git(input.source, "status", "--porcelain")).toBe("")
      git(input.target, "commit", "-m", "transfer source tree only")
      expect(git(input.target, "rev-parse", "HEAD^")).toBe(input.base)
      expect(git(input.target, "rev-list", "--count", "HEAD")).toBe("2")
    } finally {
      rmSync(input.root, { recursive: true, force: true })
    }
  })

  test("the publication ignore rules keep restored local artifacts off the cleaned branch", () => {
    const input = fixture()
    try {
      writeFileSync(join(input.source, ".gitignore"), readFileSync(new URL("../../../../.gitignore", import.meta.url)))
      const excluded = [
        ".agent-tmp-todos-20261007.md",
        ".codex-remote-attachments/session/photo.jpg",
        "packages/opencode/.analysis/request.json",
        "packages/app/e2e/test-results-old/trace.json",
        ".opencode/plugins/.opencode-release-test-7.old/index.js",
        "docs/workitems/desktop-testing/session-list.json",
        "docs/qa/rollback/capture.webm",
        "docs/plugin-audit/screenshots/session.png",
        ".storage-quarantine-approval.json",
        "output/personal-document.pdf",
        "reports/local-probe.md",
        "tmp-question-payload.json",
        "_sessions_probe.ts",
        ".opencode/scripts/daily-review-coordinator-reference.ts",
        ".opencode/scripts/daily-review-coordinator-reference.json",
        "docs/plans/prototype-fund-antrag-2026.layout.json",
        "docs/plans/prototype-fund-antrag-2026.pdf",
        "docs/plans/prototype-fund-qa-2026/page-01.png",
        ".opencode/skills/video-on-demand-vidmd-cut-preview/SKILL.md",
        ".opencode/tools/daily_review_review.ts",
        ".opencode/plugin-sources/pu-agent-mirror-app/index.js",
        "packages/core/.tmp-patch-test.py",
        "packages/app/head-raw.tsx",
      ]
      expect(git(input.source, "check-ignore", "--no-index", "--", ...excluded).split("\n").sort()).toEqual(excluded.sort())
      const maintained = [
        ".opencode/skills/composer-toolbar-plugin/SKILL.md",
        ".opencode/skills/effect/SKILL.md",
        ".opencode/plugin-sources/scheduled-jobs-app/index.js",
        "docs/workitems/desktop-testing/instructions.md",
        "packages/app/e2e/regression/example.spec.ts",
      ]
      const result = Bun.spawnSync(["git", "-C", input.source, "check-ignore", "--no-index", "--", ...maintained])
      expect(result.exitCode).toBe(1)
      expect(result.stdout.toString()).toBe("")
    } finally {
      rmSync(input.root, { recursive: true, force: true })
    }
  })

  test("switching the original folder preserves current edits, new files and the archived dev branch", () => {
    const input = fixture()
    try {
      transferForkTree({ ...input, apply: true })
      git(input.target, "commit", "-m", "clean transfer")
      const clean = git(input.target, "rev-parse", "HEAD")
      writeFileSync(join(input.source, "kept.txt"), "user work in progress\n")
      writeFileSync(join(input.source, "new-user-file.txt"), "new user work\n")
      git(input.source, "switch", "-c", "fork-sync", clean)
      expect(readFileSync(join(input.source, "kept.txt"), "utf8")).toBe("user work in progress\n")
      expect(readFileSync(join(input.source, "new-user-file.txt"), "utf8")).toBe("new user work\n")
      expect(git(input.source, "rev-parse", "dev")).toBe(input.ref)
      expect(git(input.source, "rev-parse", "HEAD^")).toBe(input.base)
    } finally {
      rmSync(input.root, { recursive: true, force: true })
    }
  })

  test("refuses to overwrite an edited target", () => {
    const input = fixture()
    try {
      writeFileSync(join(input.target, "kept.txt"), "user edit\n")
      expect(() => transferForkTree({ ...input, apply: true })).toThrow()
      expect(readFileSync(join(input.target, "kept.txt"), "utf8")).toBe("user edit\n")
      expect(() => transferForkTree({ ...input, target: input.source, apply: true })).toThrow("separate target")
      expect(() => transferForkTree({ ...input, ref: "dev", apply: true })).toThrow("full commit IDs")
    } finally {
      rmSync(input.root, { recursive: true, force: true })
    }
  })
})
