## Windows PowerShell Diagnostic Safety

- New Windows Read-only diagnostic commands must be smoked against a known-good path before running them broadly. Run the command once on a small scope, verify exit code 0 and expected output shape, then expand.
- Always use `-LiteralPath` for file paths in `Get-ChildItem`, `Test-Path`, `Remove-Item`, etc. Never rely on wildcard expansion via `-Include` with broad patterns — filter by `Where-Object { $_.Extension -eq '.ext' }` instead.
- For pipeline scans (`Get-ChildItem ... | Where-Object ...`), verify the pipeline syntax on a single file first.
- If a diagnostic command fails, record the corrected command and its exit code in the report. Do not silently retry without fixing the root syntax issue.
- Prefer `Get-ChildItem -LiteralPath <dir> -Recurse -File | Where-Object { ... }` over `Get-ChildItem -Path <dir> -Include *.ext -Recurse` which can match too broadly or miss files in PowerShell on Windows.
