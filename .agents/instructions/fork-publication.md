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
- The PU mirror plugin and its E2E test depend on another private project and stay
  local. Other portable plugins stay included. Do not remove product mail,
  scheduler, Surface or skill-loader implementations merely because local
  workflows use them.
- `.gitignore` and `script/fork-transfer-policy.ts` express the same boundary.
  Extend their behavior tests whenever that boundary changes. An exclusion must
  not be undone by restoring an older copy from a transfer base.

## Preserve local work

Make and verify an external backup first. Recheck HEAD, index and file hashes for
concurrent changes. Remove excluded paths only from Git's index (`git rm --cached`
with an exact inspected path list); never delete the local originals or rewrite
user skill files. Check that retained code/tests do not import excluded helpers.
Local integration tests belong beside their local adapters, not in the portable
package suite. Use synthetic filenames in product tests, not actual applications.

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
