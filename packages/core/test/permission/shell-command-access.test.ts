import { expect, test } from "bun:test"
import { ShellCommandAccess } from "../../src/permission/shell-command-access"

test("recognizes quote-aware PowerShell, POSIX, cmd, and pipe file observations", () => {
  expect(ShellCommandAccess.classify("Get-Content -Path 'package.json'")).toBe("read")
  expect(ShellCommandAccess.classify("Select-String -Path package.json -Pattern name")).toBe("read")
  expect(ShellCommandAccess.classify("pwsh -NoProfile -Command \"Get-Content package.json\"")).toBe("read")
  expect(ShellCommandAccess.classify("rg \"a|b\" packages/core | cat")).toBe("read")
  expect(ShellCommandAccess.classify("cmd /c type package.json")).toBe("read")
  expect(ShellCommandAccess.classify("echo \"Get-Content; rg cat\" && git status")).toBe("observation")
})

test("recognizes nested PowerShell file observations in control flow blocks", () => {
  const command = `$paths = @('packages/llm/src/route/transport/index.ts','packages/llm/src/schema/events.ts'); foreach ($path in $paths) { if (Test-Path -LiteralPath $path) { Write-Output "===== $path ====="; Get-Content -LiteralPath $path } }; Write-Output '===== refs ====='; rg -n 'ai' package.json`
  expect(ShellCommandAccess.classify(command)).toBe("read")
  expect(
    ShellCommandAccess.classify(
      "foreach ($path in $paths) { if (Test-Path $path) { Select-String -Path $path -Pattern 'TODO'; Get-ChildItem -LiteralPath $path } }",
    ),
  ).toBe("read")
})

test("recognizes file observations after leading PowerShell assignments and wrappers", () => {
  expect(
    ShellCommandAccess.classify(
      "$p = 'packages/core/src/session/input.ts'; $lines = Get-Content -LiteralPath $p; $lines[90..365]",
    ),
  ).toBe("read")
  expect(ShellCommandAccess.classify("$lines=Get-Content -LiteralPath $p")).toBe("read")
  expect(ShellCommandAccess.classify('pwsh -NoProfile -Command "$p = \'input.ts\'; Get-Content $p"')).toBe("read")
})

test("classifies git file, patch, and history output as reads", () => {
  for (const command of [
    "git grep -n ToolReadBudget packages/core",
    "git show 51454351e -- packages/core/src/permission/shell-command-access.ts",
    "git log --oneline --all -- packages/core",
    "git diff -- packages/core",
    "git blame packages/core/src/permission/shell-command-access.ts",
    "git cat-file -p HEAD:packages/core/src/permission/shell-command-access.ts",
    "GIT_PAGER=cat git diff -- packages/core",
    "sudo git blame packages/core/src/permission/shell-command-access.ts",
    'pwsh -NoProfile -Command "git show HEAD -- package.json"',
    'cmd /c "git grep ToolReadBudget packages/core"',
    "bash -c 'git log -p -1 HEAD -- packages/core'",
  ])
    expect(ShellCommandAccess.classify(command)).toBe("read")
})

test("keeps harmless git, build, test, and mutation commands out of file-read classification", () => {
  expect(ShellCommandAccess.classify("git status; git rev-parse HEAD")).toBe("observation")
  expect(ShellCommandAccess.classify("bun test packages/core && bun typecheck")).toBe("other")
  expect(ShellCommandAccess.classify("git add packages/core")).toBe("other")
  expect(ShellCommandAccess.classify("git add show")).toBe("other")
  expect(ShellCommandAccess.classify("git commit -m 'git show'")).toBe("other")
  expect(ShellCommandAccess.classify("git push origin dev")).toBe("other")
  expect(ShellCommandAccess.classify("git -C show status")).toBe("observation")
  expect(ShellCommandAccess.classify("echo git show")).not.toBe("read")
  expect(ShellCommandAccess.isLowRisk("cat package.json; git status")).toBe(true)
  expect(ShellCommandAccess.isLowRisk("cat package.json; rm generated.txt")).toBe(false)
  expect(ShellCommandAccess.classify("$result = bun test packages/core")).not.toBe("read")
  expect(ShellCommandAccess.classify("$result = git status")).not.toBe("read")
  expect(ShellCommandAccess.classify("$result = Remove-Item generated.txt")).not.toBe("read")
})
