import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"

test("CLI fixtures ignore inherited custom configuration outside their temporary home", async () => {
  await using tmp = await tmpdir()
  const config = path.join(tmp.path, "outside.json")
  const configDirectory = path.join(tmp.path, "outside-directory")
  await mkdir(configDirectory)
  await Bun.write(config, '{ "model": 123 }')
  await Bun.write(path.join(configDirectory, "opencode.json"), '{ "model": 456 }')
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      path.join(import.meta.dir, "run-process.test.ts"),
      "--test-name-pattern",
      "exits 0 and writes the response to stdout on a successful prompt",
      "--only-failures",
    ],
    {
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: { ...process.env, OPENCODE_CONFIG: config, OPENCODE_CONFIG_DIR: configDirectory },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  try {
    const [exit, output] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect({ exit, failures: output.includes("(fail)") }).toEqual({ exit: 0, failures: false })
    expect(output).toContain("1 pass")
  } finally {
    child.kill()
  }
}, 60_000)
