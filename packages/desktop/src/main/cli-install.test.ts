import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { access, copyFile, mkdir } from "node:fs/promises"
import {
  buildPowerShellScript,
  installCli,
  refreshManagedCli,
  runPowerShell,
  toPowerShellLiteral,
  type CliInstallDependencies,
} from "./cli-install"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("installCli", () => {
  test("rejects a missing packaged resource clearly", async () => {
    const fixture = await createFixture(false)
    expect(installCli(fixture.deps)).rejects.toThrow("packaged resource is missing")
  })

  test("atomically replaces the managed executable", async () => {
    const fixture = await createFixture()
    const target = join(fixture.localAppData, "OpenCode", "bin", "opencode.exe")
    await mkdir(join(fixture.localAppData, "OpenCode", "bin"), { recursive: true })
    await writeFile(target, "old")
    let observedExistingTarget = false
    fixture.deps.rename = async (from, to) => {
      observedExistingTarget = (await readFile(to, "utf8")) === "old"
      return rename(from, to)
    }

    expect(await installCli(fixture.deps)).toBe(target)
    expect(observedExistingTarget).toBe(true)
    expect(await readFile(target, "utf8")).toBe("packaged")
  })

  test("preserves PATH entries and does not duplicate an existing bin directory", async () => {
    const fixture = await createFixture()
    const directory = join(fixture.localAppData, "OpenCode", "bin")
    fixture.userPath.value = `C:\\Tools;${directory.toUpperCase()};C:\\Windows`
    fixture.deps.env.Path = `C:\\Process;${directory}`

    await installCli(fixture.deps)

    expect(fixture.userPath.value).toBe(`C:\\Tools;${directory.toUpperCase()};C:\\Windows`)
    expect(fixture.userPath.writes).toBe(0)
    expect(fixture.deps.env.Path).toBe(`C:\\Process;${directory}`)
  })

  test("prepends the managed bin without mutating unrelated commands", async () => {
    const fixture = await createFixture()
    const directory = join(fixture.localAppData, "OpenCode", "bin")
    const unrelated = join(fixture.localAppData, "npm", "opencode.cmd")
    await mkdir(join(fixture.localAppData, "npm"), { recursive: true })
    await writeFile(unrelated, "npm shim")
    fixture.userPath.value = "C:\\Tools;C:\\Windows"
    fixture.deps.env.Path = "C:\\Process"

    await installCli(fixture.deps)

    expect(fixture.userPath.value).toBe(`${directory};C:\\Tools;C:\\Windows`)
    expect(fixture.deps.env.Path).toBe(`${directory};C:\\Process`)
    expect(await readFile(unrelated, "utf8")).toBe("npm shim")
  })
})

describe("refreshManagedCli", () => {
  test("updates an already installed managed executable without changing PATH", async () => {
    const fixture = await createFixture()
    const directory = join(fixture.localAppData, "OpenCode", "bin")
    const target = join(directory, "opencode.exe")
    await mkdir(directory, { recursive: true })
    await writeFile(target, "old")
    fixture.deps.env.Path = "C:\\Process"

    expect(await refreshManagedCli(fixture.deps)).toBe(target)
    expect(await readFile(target, "utf8")).toBe("packaged")
    expect(fixture.userPath.writes).toBe(0)
    expect(fixture.deps.env.Path).toBe("C:\\Process")
  })

  test("leaves a missing managed executable and PATH untouched", async () => {
    const fixture = await createFixture()
    fixture.deps.env.Path = "C:\\Process"

    expect(await refreshManagedCli(fixture.deps)).toBeUndefined()
    expect(fixture.userPath.writes).toBe(0)
    expect(fixture.deps.env.Path).toBe("C:\\Process")
    await expect(access(join(fixture.localAppData, "OpenCode", "bin", "opencode.exe"))).rejects.toThrow()
  })

  test("propagates copy errors and removes the temporary file", async () => {
    const fixture = await createFixture()
    const directory = join(fixture.localAppData, "OpenCode", "bin")
    const target = join(directory, "opencode.exe")
    const temporary = join(directory, ".opencode-fixture.tmp")
    await mkdir(directory, { recursive: true })
    await writeFile(target, "old")
    fixture.deps.copyFile = async () => {
      await writeFile(temporary, "partial")
      throw new Error("copy failed")
    }

    await expect(refreshManagedCli(fixture.deps)).rejects.toThrow("copy failed")
    await expect(access(temporary)).rejects.toThrow()
    expect(await readFile(target, "utf8")).toBe("old")
  })
})

describe("buildPowerShellScript", () => {
  test("wraps each placeholder in a single-quoted literal", () => {
    const script = buildPowerShellScript("[Environment]::SetEnvironmentVariable('Path', {0}, 'User')", [
      "C:\\Tools;C:\\Program Files\\My App\\bin",
    ])
    expect(script).toBe("[Environment]::SetEnvironmentVariable('Path', 'C:\\Tools;C:\\Program Files\\My App\\bin', 'User')")
  })

  test("substitutes multiple placeholders and defaults missing args to empty", () => {
    expect(buildPowerShellScript("f({0},{1},{2})", ["a", "b"])).toBe("f('a','b','')")
  })
})

describe("toPowerShellLiteral", () => {
  test("wraps values in single quotes so PowerShell never re-parses them", () => {
    expect(toPowerShellLiteral("C:\\Tools;C:\\Windows")).toBe("'C:\\Tools;C:\\Windows'")
  })

  test("doubles embedded apostrophes as the only escaping (injection-safe)", () => {
    expect(toPowerShellLiteral("It's a 'path'")).toBe("'It''s a ''path'''")
  })

  test("preserves expansion-prone tokens verbatim inside the literal", () => {
    const value = "C:\\$(NOT_EXPANDED);C:\\`NOT_EVALUATED;C:\\Quote\"Dir"
    // `$`, backtick, `;`, and `"` survive verbatim; single-quoting is what stops
    // PowerShell from interpreting them.
    expect(toPowerShellLiteral(value)).toBe("'" + value + "'")
  })

  test("round-trips a trailing backslash without escaping it", () => {
    expect(toPowerShellLiteral("C:\\Trail\\")).toBe("'C:\\Trail\\'")
  })

  test("produces an empty quoted literal for an empty string", () => {
    expect(toPowerShellLiteral("")).toBe("''")
  })
})

const isWindows = process.platform === "win32"

describe("runPowerShell", () => {
  test.skipIf(!isWindows)("sets and reads back a semicolon-delimited PATH (regression: Unexpected token)", async () => {
    const value = "C:\\Tools;C:\\Program Files\\My App\\bin;C:\\Windows"
    const out = await runPowerShell(
      "[Environment]::SetEnvironmentVariable('OPENCODE_CLI_FIXTURE', {0}, 'Process'); [Environment]::GetEnvironmentVariable('OPENCODE_CLI_FIXTURE', 'Process')",
      value,
    )
    expect(out).toBe(value)
  })

  test.skipIf(!isWindows)("passes arguments verbatim through real PowerShell across edge cases", async () => {
    const cases = [
      "C:\\Program Files\\My App\\bin;C:\\Other",
      "C:\\Quote\"Dir\";C:\\Two",
      "C:\\Apost'B;C:\\X",
      "C:\\Trail\\",
      "C:\\$(NOT_EXPANDED);C:\\`NOT_EVALUATED",
      "",
    ]
    for (const value of cases) {
      const out = await runPowerShell("Write-Output ({0})", value)
      expect(out).toBe(value)
    }
  })
})

async function createFixture(withResource = true) {
  const root = await mkdtemp(join(tmpdir(), "opencode-cli-install-"))
  roots.push(root)
  const resourcesPath = join(root, "resources")
  const localAppData = join(root, "local")
  await mkdir(resourcesPath, { recursive: true })
  if (withResource) await writeFile(join(resourcesPath, "opencode-cli.exe"), "packaged")
  const userPath = { value: "", writes: 0 }
  const deps: CliInstallDependencies = {
    platform: "win32",
    resourcesPath,
    localAppData,
    env: {},
    access,
    mkdir,
    copyFile,
    rename,
    rm,
    randomUUID: () => "fixture",
    readUserPath: async () => userPath.value,
    writeUserPath: async (value) => {
      userPath.value = value
      userPath.writes++
    },
  }
  return { deps, localAppData, userPath }
}
