import { describe, expect, test } from "bun:test"
import { stripLauncherExecArgs } from "../../src/cli/launcher-args"

describe("cli.launcherArgs", () => {
  test("strips the desktop launcher exec prefix before the separator", () => {
    const argv = [
      "--user-agent=opencode/0.0.0-prod-202611141033",
      "--use-system-ca",
      "--",
      "--pure",
      "--log-level",
      "ERROR",
      "run",
      "--format",
      "json",
      "--agent",
      "build",
      "hello",
    ]
    expect(stripLauncherExecArgs(argv)).toEqual([
      "--pure",
      "--log-level",
      "ERROR",
      "run",
      "--format",
      "json",
      "--agent",
      "build",
      "hello",
    ])
  })

  test("strips launcher flags without values before the separator", () => {
    expect(stripLauncherExecArgs(["--user-agent", "--use-system-ca", "--", "run"])).toEqual(["run"])
  })

  test("leaves a normal invocation without the launcher prefix unchanged", () => {
    const argv = ["--pure", "run", "--format", "json", "--", "echo", "hi"]
    expect(stripLauncherExecArgs(argv)).toBe(argv)
  })

  test("leaves a user-typed bare separator intact", () => {
    const argv = ["run", "--", "echo", "hi"]
    expect(stripLauncherExecArgs(argv)).toBe(argv)
    const leading = ["--", "run"]
    expect(stripLauncherExecArgs(leading)).toBe(leading)
  })

  test("leaves launcher flags without the terminating separator unchanged", () => {
    const argv = ["--use-system-ca", "run"]
    expect(stripLauncherExecArgs(argv)).toBe(argv)
  })

  test("strips a prefix that consists only of launcher flags and the separator", () => {
    expect(stripLauncherExecArgs(["--user-agent=opencode/x", "--use-system-ca", "--"])).toEqual([])
  })

  test("handles an empty argument list", () => {
    expect(stripLauncherExecArgs([])).toEqual([])
  })
})
