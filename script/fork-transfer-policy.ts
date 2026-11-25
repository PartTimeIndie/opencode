// A fork transfer copies a source tree, never the source branch's history.
// Keep local evidence and private runtime state out even when they were tracked.
export function forkTransferExclusion(file: string, ignored = false): string | undefined {
  if (!file || file.includes("\\") || file.startsWith("/") || /^[A-Za-z]:/.test(file)) return "unsafe-path"
  if (file.split("/").some((part) => !part || part === "." || part === ".." || part === ".git"))
    return "unsafe-path"
  if (ignored) return "git-ignored"
  if (/^docs\/plans\/prototype-fund(?:[./-]|$)/i.test(file)) return "personal-document"
  if (file === "packages/app/e2e/regression/question-daily-review-import.spec.ts") return "local-agent-workflow"
  if (file === "packages/core/script/fixtures/pu-skill-groups.json") return "local-config"
  if (/^docs\/visual-qa-smoke-[^/]+\.md$/.test(file)) return "local-evidence"
  if (/^packages\/app\/src\/context\/global-sync\/_patch_[^/]+\.py$/.test(file)) return "local-scratch"
  if (/^packages\/core\/test\/(?:clean_fixture|dedupe_tests|final_close|find_dup|fix_fixture)\.py$/.test(file))
    return "local-scratch"
  if (file === "packages/app/e2e/run-with-vite-server.local.ts") return "local-scratch"
  if (/^skills\//.test(file)) return "personal-skill"
  // Only the two repository-development skills are portable project sources.
  // Installed user workflows remain on disk, but are not publication inputs.
  if (/^\.opencode\/skills\//.test(file) && !/^\.opencode\/skills\/(?:composer-toolbar-plugin|effect)\//.test(file))
    return "local-skill"
  if (/^\.opencode\/(?:scripts|tools?|agents?)\//.test(file)) return "local-agent-workflow"
  if (/^\.opencode\/(?:opencode\.jsonc?|app\.jsonc|tui\.json|prompts\/|themes\/)/.test(file)) return "local-config"
  if (/^(?:\.agents\/checkpoints|\.cursor\/hooks\/state)\//.test(file)) return "local-agent-state"
  if (/^\.opencode\/(?:plugin-sources|plugins)\/pu-agent-mirror-app\//.test(file) || file === "packages/app/e2e/regression/pu-agent-mirror.spec.ts")
    return "external-project-plugin"
  if (/^docs\/(?:plans\/daily-review[^/]*|workitems\/daily-(?:agent-)?review[^/]*|qa\/(?:night-review[^/]*|pu-mirror-status))(\/|$)/.test(file))
    return "local-review"
  if (/^docs\/workitems\//.test(file) && !/^docs\/workitems\/(?:config-reload-session-interrupt-runbook\.md|desktop-prod-deploy-checklist\.md|desktop-testing\/instructions\.md)$/.test(file))
    return "local-review"
  if (/^docs\/(?:qa|visual-qa)\//.test(file) || /^docs\/reviewer-all-current\.json$/.test(file)) return "local-evidence"
  if (/^(?:design-qa\.md|subagent-loop-prevention-plan\.md)$/.test(file)) return "local-review"
  if (/^Install-Codex-Server2016\.(?:cmd|ps1)$/.test(file)) return "personal-tool"
  if (/^packages\/core\/test\/(?:core-review-closeout|normalAdmission-evidence|persisted-chain-evidence)\.md$/.test(file) || file === "packages/opencode/src/server/routes/instance/httpapi/diagnosis-loading-gate.md")
    return "local-review"
  if (/(^|\/)\.opencode\/(?:cache\/|opencode\.jsonc?$)/.test(file)) return "local-config"
  if (/(^|\/)(?:\.tmp[^/]*|\.llm-hash\.tmp|\.opencode-review-handoff\.txt|smoke-results)(\/|$)/.test(file)) return "local-scratch"
  if (/^packages\/app\/(?:_patch_tabs\.py|head-dump\.txt|head-raw\.tsx|prompt-input\.head\.tsx)$/.test(file)) return "local-scratch"
  if (/^packages\/core\/(?:fix-test-close\.py|reapply-cas\.mjs|restore-bytes\.mjs|verify_ps_native\.ps1|typecheck_output\.txt|x)$/.test(file)) return "local-scratch"
  if (/^packages\/opencode\/(?:git|hook-disposed\.txt|matches\.txt|service-disposed\.txt|typecheck-output\.txt|patch-asar\.ts|verify-asar\.js|tsconfig\.daily-review\.json)$/.test(file)) return "local-scratch"
  if (/(^|\/)(?:\.agent-tmp(?:[^/]*)?|\.analysis|\.codex-remote-attachments|test-results[^/]*|playwright-report[^/]*)(\/|$)/.test(file))
    return "local-evidence"
  if (/^\.opencode\/plugins\/\.opencode-release-[^/]+(\/|$)/.test(file)) return "plugin-release-backup"
  if (/^(?:output|reports)\//.test(file)) return "local-output"
  if (/^docs\/(?:workitems|qa|plugin-audit)\/.*\.(?:jsonl?|txt|log|har|zip|png|jpe?g|webp|webm|mp4|wav|aac|pdf|tap|diff)$/i.test(file))
    return "qa-capture"
  if (/(^|\/)\.env(?:\.[^/]+)?$/.test(file) && !/\.env\.(?:example|template)$/.test(file))
    return "environment-secrets"
  if (/(^|\/)(?:id_rsa|id_ed25519|credentials\.json|auth\.json)$/.test(file) && !/(^|\/)fixtures?\//.test(file))
    return "private-runtime-state"
  if (/^\.storage-quarantine-approval\.json$/.test(file)) return "private-runtime-state"
  if (/^(?:\.tmp[^/]*|tmp-[^/]*|target-diff\.patch|test-results\.txt|screenshot-[^/]+\.(?:png|jpg))$/.test(file))
    return "root-scratch"
  if (/^(?:_sessions?_[^/]+\.ts|cdp-eval\.mjs|search-calendar\.mjs|check_(?:blocked|scheduler)_jobs\.py|fix_(?:test_)?guard\.py|verify_(?:catchtags|mappings)\.py)$/.test(file))
    return "root-scratch"
}
