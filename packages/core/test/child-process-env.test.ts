import { describe, expect, test } from "bun:test"
import { ChildProcessEnv } from "@opencode-ai/core/child-process-env"
import { AppProcess } from "@opencode-ai/core/process"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

describe("ChildProcessEnv.external", () => {
  test("removes internal startup controls without changing user environment", () => {
    expect(
      ChildProcessEnv.external({
        OPENCODE_DEFER_DB_STARTUP_REPAIRS: "1",
        OPENCODE_DEFER_BACKGROUND_STARTUP: "1",
        OPENCODE_DEFER_USER_SETTING: "keep",
        USER_SETTING: "also-keep",
      }),
    ).toEqual({
      OPENCODE_DEFER_USER_SETTING: "keep",
      USER_SETTING: "also-keep",
    })
  })

  test("does not mutate the runtime environment", () => {
    const environment = { OPENCODE_DEFER_DB_STARTUP_REPAIRS: "1" }
    ChildProcessEnv.external(environment)
    expect(environment).toEqual({ OPENCODE_DEFER_DB_STARTUP_REPAIRS: "1" })
  })

  test("removes an incomplete GIT_CONFIG_* family inherited from a parent process", () => {
    expect(
      ChildProcessEnv.external({
        PATH: "keep",
        GIT_SSH_COMMAND: "ssh -i key",
        USER_SETTING: "keep",
        GIT_CONFIG_COUNT: "10",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_KEY_1: "credential.helper",
        GIT_CONFIG_VALUE_1: "helper-command",
        GIT_CONFIG_KEY_5: "credential.helper",
        GIT_CONFIG_KEY_6: "credential.helper",
        GIT_CONFIG_VALUE_6: "helper-command",
      }),
    ).toEqual({
      PATH: "keep",
      GIT_SSH_COMMAND: "ssh -i key",
      USER_SETTING: "keep",
    })
  })

  test("keeps a complete GIT_CONFIG_* family unchanged, including an empty value", () => {
    const environment = {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "core.editor",
      GIT_CONFIG_VALUE_1: "code --wait",
      GIT_CONFIG_GLOBAL: "keep",
    }
    expect(ChildProcessEnv.external(environment)).toEqual(environment)
  })

  test("removes the GIT_CONFIG_* family when the count is not a number", () => {
    expect(
      ChildProcessEnv.external({
        GIT_CONFIG_COUNT: "many",
        GIT_CONFIG_KEY_0: "core.bare",
        GIT_CONFIG_VALUE_0: "true",
        USER_SETTING: "keep",
      }),
    ).toEqual({ USER_SETTING: "keep" })
  })

  test("removes the GIT_CONFIG_* family when the count exceeds the family", () => {
    expect(
      ChildProcessEnv.external({
        GIT_CONFIG_COUNT: "100000000",
        GIT_CONFIG_KEY_0: "core.bare",
        GIT_CONFIG_VALUE_0: "true",
        USER_SETTING: "keep",
      }),
    ).toEqual({ USER_SETTING: "keep" })
  })

  test("treats lower-case GIT_CONFIG_* spellings the same", () => {
    expect(
      ChildProcessEnv.external({
        git_config_count: "1",
        git_config_key_0: "core.bare",
        USER_SETTING: "keep",
      }),
    ).toEqual({ USER_SETTING: "keep" })
  })

  test("keeps GIT_CONFIG_KEY_* and GIT_CONFIG_VALUE_* variables that have no count", () => {
    const environment = {
      GIT_CONFIG_KEY_0: "core.bare",
      GIT_CONFIG_VALUE_0: "true",
      GIT_CONFIG_GLOBAL: "keep",
    }
    expect(ChildProcessEnv.external(environment)).toEqual(environment)
  })

  test("does not mutate the input for a broken GIT_CONFIG_* family", () => {
    const environment = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", USER_SETTING: "keep" }
    ChildProcessEnv.external(environment)
    expect(environment).toEqual({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", USER_SETTING: "keep" })
  })

  test("sanitizes the environment of a real external child process", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const processService = yield* AppProcess.Service
        return yield* processService.run(
          ChildProcess.make(
            process.execPath,
            [
              "-e",
              `process.stdout.write(JSON.stringify({ defer: Object.keys(process.env).filter((key) => key.startsWith("OPENCODE_DEFER_")).sort(), user: process.env.USER_SETTING }))`,
            ],
            {
              env: {
                ...process.env,
                OPENCODE_DEFER_DB_STARTUP_REPAIRS: "1",
                OPENCODE_DEFER_BACKGROUND_STARTUP: "1",
                OPENCODE_DEFER_USER_SETTING: "keep",
                USER_SETTING: "also-keep",
              },
              extendEnv: false,
            },
          ),
        )
      }).pipe(Effect.provide(AppProcess.defaultLayer)),
    )

    expect(JSON.parse(result.stdout.toString("utf8"))).toEqual({
      defer: ["OPENCODE_DEFER_USER_SETTING"],
      user: "also-keep",
    })
  })

  test("repairs the environment of a real git child process", async () => {
    const { cwd, env, cleanup } = await brokenGit()
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const processService = yield* AppProcess.Service
          return yield* processService.run(ChildProcess.make("git", ["config", "--list"], { cwd, env, extendEnv: true }))
        }).pipe(Effect.provide(AppProcess.defaultLayer)),
      )

      expect(result.exitCode).toBe(0)
      expect(result.stderr.toString("utf8")).not.toContain("unable to parse command-line config")
    } finally {
      await cleanup()
    }
  })

  test("git itself rejects the broken family without the repair", async () => {
    const { cwd, env, cleanup } = await brokenGit()
    try {
      const result = spawnSync("git", ["config", "--list"], { cwd, env: { ...process.env, ...env }, timeout: 10_000 })

      expect(result.status).toBe(128)
      expect(result.stderr.toString()).toContain("unable to parse command-line config")
    } finally {
      await cleanup()
    }
  })
})

// The hermetic config keeps system and user settings out, so only the broken command-line set decides the outcome.
async function brokenGit() {
  const cwd = await mkdtemp(path.join(tmpdir(), "opencode-child-process-env-"))
  const config = path.join(cwd, "gitconfig")
  await writeFile(config, "")
  return {
    cwd,
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.bare",
    },
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  }
}
