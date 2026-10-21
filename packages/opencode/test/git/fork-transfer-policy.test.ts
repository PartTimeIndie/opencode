import { describe, expect, test } from "bun:test"
import { forkTransferExclusion } from "../../../../script/fork-transfer-policy"

describe("clean fork tree transfer", () => {
  test.each([
    ".agent-tmp/capture/session.json",
    ".agent-tmp-todos-20261007.md",
    "packages/app/.agent-tmp/video.webm",
    "packages/opencode/.analysis/request.json",
    "packages/app/e2e/test-results-rollback/video.webm",
    "packages/app/playwright-report/index.html",
    ".codex-remote-attachments/session/photo.jpg",
    ".opencode/plugins/.opencode-release-example-7.old/index.js",
    "output/personal-document.pdf",
    "reports/local-probe.md",
    "docs/workitems/desktop-testing/session-list.json",
    "docs/qa/session-rollback/source-manifest.json",
    "docs/plugin-audit/screenshots/session.png",
    ".env",
    ".env.production",
    "packages/app/.env.local",
    "credentials.json",
    "auth.json",
    ".storage-quarantine-approval.json",
    ".tmp-inspect.mjs",
    "tmp-question-payload.json",
    "_sessions_list.ts",
    "cdp-eval.mjs",
    "search-calendar.mjs",
    "check_scheduler_jobs.py",
    "fix_guard.py",
    "verify_mappings.py",
    "target-diff.patch",
    "test-results.txt",
    "docs/plans/prototype-fund-antrag-2026.md",
    "docs/plans/prototype-fund-render.test.ts",
    "docs/plans/prototype-fund-qa-2026/page-01.png",
    "docs/plans/daily-review-nachtrag-2026-10-21.md",
    "docs/workitems/daily-agent-review-runbook.md",
    "docs/workitems/daily-review-morning/outcome.md",
    "docs/workitems/desktop-testing/nightly-real-app-qa-2026-09-21.md",
    "docs/visual-qa/prompt-improve/evidence.json",
    "docs/qa/pu-mirror-status/report.md",
    "skills/gmx-email-writer/SKILL.md",
    ".opencode/skills/email-manager/SKILL.md",
    ".opencode/scripts/pu-card-tweaker-action.ts",
    ".opencode/tools/manifest.json",
    ".opencode/agents/scheduler-watchdog.md",
    ".opencode/opencode.jsonc",
    ".agents/checkpoints/post-user-stop-2026-10-08.json",
    ".cursor/hooks/state/continual-learning.json",
    ".opencode/plugin-sources/pu-agent-mirror-app/index.js",
    ".opencode/plugins/pu-agent-mirror-app/index.js",
    "packages/app/e2e/regression/pu-agent-mirror.spec.ts",
    "packages/app/head-dump.txt",
    "packages/app/.opencode-review-handoff.txt",
    "packages/core/reapply-cas.mjs",
    "packages/core/.tmp-patch-test.py",
    "packages/opencode/patch-asar.ts",
    "packages/opencode/tsconfig.daily-review.json",
    "packages/opencode/.opencode/cache/cursor/cursor-models.json",
    "docs/workitems/2026-08-20-opencode-repair-tracker.md",
    "docs/qa/native-file-protection-2026-10-21.md",
    "packages/core/test/core-review-closeout.md",
    "packages/core/test/normalAdmission-evidence.md",
    "packages/core/test/persisted-chain-evidence.md",
    "packages/opencode/src/server/routes/instance/httpapi/diagnosis-loading-gate.md",
    "Install-Codex-Server2016.ps1",
    "Install-Codex-Server2016.cmd",
  ])("excludes local evidence and private state: %s", (file) => {
    expect(forkTransferExclusion(file)).toBeDefined()
  })

  test.each([
    "packages/core/src/session.ts",
    "packages/opencode/src/project/vcs.ts",
    "packages/app/e2e/regression/session-rollback.spec.ts",
    "packages/app/e2e/fixtures/example.json",
    "packages/opencode/test/fixture/auth.json",
    "packages/ui/src/assets/icon.svg",
    ".opencode/plugin-sources/git-workbench-app/index.js",
    ".opencode/plugins/git-workbench-app/index.js",
    "docs/plans/session-rollback.md",
    "docs/workitems/desktop-testing/instructions.md",
    "docs/workitems/config-reload-session-interrupt-runbook.md",
    "docs/workitems/desktop-prod-deploy-checklist.md",
    "script/fork-transfer-policy.ts",
    ".env.example",
    "packages/app/.env.template",
    "bun.lock",
    "AGENTS.md",
    ".opencode/skills/composer-toolbar-plugin/SKILL.md",
    ".opencode/skills/effect/SKILL.md",
    "packages/core/src/mail/gmail-client.ts",
    "packages/core/test/mail/manager-gmail.test.ts",
    "packages/app/e2e/regression/question-daily-review.spec.ts",
    "packages/opencode/deploy-asar.ts",
  ])("preserves maintained code, tests and documentation: %s", (file) => {
    expect(forkTransferExclusion(file)).toBeUndefined()
  })

  test("honors Git ignore rules even for accidentally tracked files", () => {
    expect(forkTransferExclusion("packages/web/dist/index.js", true)).toBe("git-ignored")
    expect(forkTransferExclusion("packages/app/test-results/video.webm", true)).toBe("git-ignored")
  })

  test.each(["", "/outside", "C:/outside", "../outside", "a/../outside", "a/./b", "a//b", ".git/config", "a/.git/config", "a\\b"])(
    "rejects paths outside the portable worktree boundary: %s",
    (file) => {
      expect(forkTransferExclusion(file)).toBe("unsafe-path")
    },
  )
})
