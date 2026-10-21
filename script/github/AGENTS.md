# GitHub maintenance scripts

- Cleanup must target the repository running the workflow, using `GITHUB_REPOSITORY`. Never fall back to the upstream repository. Require an explicit repository for local runs; PR cleanup also supports `--repo owner/name`.
- Validate the repository before authentication or network requests. Keep the PR cleanup dry-run default and the existing workflow token permissions.
- For fork failures, inspect the failed step before changing runner warnings. Public run metadata and annotations are readable without signing in; full job logs can require authentication.
- Verify cleanup changes from `packages/opencode` with `bun test test/script/github-cleanup.test.ts`. The tests intercept GitHub requests; never run live cleanup merely to test a fix.
