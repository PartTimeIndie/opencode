Fix `safe_join`.

Requirements:
- Return a resolved path under the provided root.
- Accept normalized safe relative paths such as `a/../b/file.txt`.
- Reject path traversal, absolute paths, Windows drive paths, UNC-style paths, mixed separators, and prefix tricks.
- Use robust path boundary checks, not string `startswith`.

Keep the patch minimal.
