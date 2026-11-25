# Fork publication boundaries

Read before cleaning the Git index, transferring a tree or preparing a public fork.

## Keep product source, not the author's workspace

- Keep portable application/library code, tests, SDKs, build tools, architectural
  documentation and reusable plugin sources/runtime copies.
- Only `composer-toolbar-plugin` and `effect` under `.opencode/skills` are
  repository-development skills. Other installed skills, root `skills/`, custom
  agent/tool/script directories and machine-specific config remain local.
- Keep personal grant applications (including generators, tests, mail and rendered
  assets), Daily Review coordinator adapters/receipts/notes, local scheduler agents,
  captured QA media/reports, workspace ledgers, debug dumps, personal installers
  and one-off patch scripts out of the public tree. Architectural plans and the
  maintained deployment/config-reload runbooks remain included.
- The PU mirror plugin and its E2E test depended on another private project and are
  decommissioned; their local installations were deleted, but their ignore and
  transfer-policy exclusions and tests deliberately REMAIN in force so restored
  copies from older transfer bases can never publish. The independent general
  `mirror-app`, its skill source and generic tests are portable; do not exclude
  them with the legacy PU adapter. Other portable plugins stay included. Do not
  remove product mail,
  scheduler, Surface or skill-loader implementations merely because local
  workflows use them.
- `.gitignore` and `script/fork-transfer-policy.ts` express the same boundary.
  Extend their behavior tests whenever that boundary changes. An exclusion must
  not be undone by restoring an older copy from a transfer base.

## Agent rules for local-only files

Apply these rules before creating files, staging changes or preparing a commit:

- Put personal Daily Review adapters, watchdog helpers and their tests in the
  ignored local workflow directories: `.opencode/scripts/`, `.opencode/tool/`,
  `.opencode/tools/`, `.opencode/agent/` and `.opencode/agents/`. Their presence
  on disk is not permission to publish them or make product tests import them.
- Keep installed personal skills, `.opencode/prompts/`, `.opencode/themes/` and
  machine-specific OpenCode config local. The two approved project skills and
  portable plugin source/runtime directories remain publishable; do not ignore
  all of `.opencode/` or exclude product code merely because its name mentions
  Daily Review, scheduling, mail or Surface.
- Keep applications, personal documents, review receipts, screenshots, recordings
  and repair scratch files in the existing ignored locations. For a new category,
  update `.gitignore`, `script/fork-transfer-policy.ts` and their contract tests
  together before staging. Check actual paths with `git check-ignore -v --no-index`.
- Never use `git add -f` to bypass these exclusions. Inspect staged paths and the
  publication audit; do not stage unrelated concurrent work with a blanket add.
- `.gitignore` does not untrack a file or hide a staged deletion. A `D` entry can
  mean the local file is preserved but removed from the index relative to the old
  HEAD. Check the file on disk, `git ls-files` and `git diff --cached` separately.
  Never restore excluded files to the index, delete the local originals, or use
  `assume-unchanged`/`skip-worktree` just to make the change list disappear.
- Finishing a removal commit or migrating a working branch is a separate Git
  action, not an ignore-rule fix. Preserve the existing staging and worktree;
  never reset, switch branches or publish the old ancestry as implicit cleanup.

## Preserve local work

Make and verify an external backup first. Recheck HEAD, index and file hashes for
concurrent changes. Remove excluded paths only from Git's index (`git rm --cached`
with an exact inspected path list); never delete the local originals or rewrite
user skill files. Check that retained code/tests do not import excluded helpers.
Local integration tests belong beside their local adapters, not in the portable
package suite. Use synthetic filenames in product tests, not actual applications.

## Inspect contents and dependencies, not just ignore coverage

A passing path audit proves only the declared path exclusions. Before calling a
snapshot clean, inspect the proposed tree's contents and dependency boundaries:

- Search tracked files outside `.opencode/` too: one-off `_patch_*.py` helpers,
  machine-bound `.local.ts` runners, dated QA reports and foreign-project tests
  have previously survived a directory-only check. Add exact reviewed exclusions,
  not blanket rules for Python, fixtures, all tests or all plugin sources.
- The external Coordinator import test and PU skill-group snapshot are local-only.
  Portable tests must not require another checkout or read live coordinator state.
  Preserve local integration originals and distinguish them from product tests.
- Test fixtures are not automatically public-safe. Never copy real review answers,
  dated review IDs, material digests, chat transcripts or personal installation
  paths into product tests. Use synthetic examples and keep the same assertions
  for rendering, answer handling and completion classification. Back up originals
  before replacing copied content; run the affected unit and browser tests.
- Generic application names such as Notepad, reusable scheduler plugins and the
  product's session run coordinator are not private data merely because a search
  finds their names. Inspect why they exist before excluding them.
- Compare the index, working files and exact remote commit separately. Report
  confirmed local-only files, sanitized product fixtures, retained product code,
  and limitations. Never present a path-only audit as a complete content audit.
- A local correction does not repair an already published commit. Do not push or
  rewrite history implicitly; state explicitly when GitHub still has the previous
  contents. Keep inspection evidence and private backups outside publication.

## Check both the tree and its ancestry

From the repository root:

```sh
bun script/fork-publication-audit.ts
bun script/fork-publication-audit.ts --ref <proposed-commit> --history
```

The first command checks every indexed path, including accidentally tracked
ignored files. The second checks the proposed commit and every reachable tree;
removing a file today does not remove it from earlier commits. Both fail on
excluded paths. This is a path-boundary check, not proof that the content is
secret-free: inspect content and dependencies separately. Review all newly added
paths and the exact staged diff before committing.

Never push local ancestry containing private files, even if the tip passes. When
needed, prepare a new tree-only snapshot in a separate clean worktree on a verified
safe base; do not merge the old local ancestry. A snapshot does not clean the old
repository or remove data already exposed on GitHub. Rewriting published history,
creating/renaming/deleting GitHub repositories and pushing require their own
current authorization. Keep the fork migration paused until publication checks pass.

## Verify GitHub fork migration and publication

Changing a Git remote does not create GitHub fork membership. For an authorized
migration, record repository IDs, back up the old published history as a verified
external Git bundle, and verify the new repository's `fork`, `parent` and `source`
fields before publication. Keep the renamed old repository until the new one is
verified; respect any later decision to retain it instead of deleting it.

Publish only the pinned audited commit to an explicit destination ref. Inspect
remote refs first, use an exact lease for creation or replacement, and never push
all branches or tags. Verify the remote commit, tree, parents, default branch and
remaining refs. Remove an initial copied branch only after the intended branch is
verified and made default, using the copied branch's exact SHA as a lease.

The local `fork-sync` and `dev` ancestry is not a publication source. The audited
`public-clean` branch is used for audited transfers onto the user's `origin/main`; repository-local
`push.default=nothing` requires an explicit push refspec and prevents an accidental
bare push from the dirty development branch. An independent root has no shared
ancestry with the upstream: do not turn a future update into an implicit merge,
pull or rebase. Future transfers still require the same tree and history audits.

If Git Workbench refuses a pull because the branches have no common commit,
verify the remote and `git merge-base HEAD origin/main`. Pull on local `main`
in the primary checkout, not on `fork-sync` or `dev`. Transfer any work left on
those branches as an audited tree without connecting the histories.
The Workbench reports known pull refusals without exposing raw remote output.
Sync stops if its pull fails; use Pull, not Sync, to bring in remote changes
without attempting a push.

For saved GitHub credentials, select the intended account explicitly and verify
`/user`; an unauthenticated `gh` CLI alone does not prove Git Credential Manager
has no usable login. Never log or persist tokens. Repository admin rights do not
supply the OAuth `delete_repo` scope. If deletion is denied, preserve the old
repository and report the missing capability; do not repeat login flows or expand
permissions without a new decision.
