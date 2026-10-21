import { describe, expect, test } from "bun:test"
import { ChildProcessEnv } from "@opencode-ai/core/child-process-env"
import { AppProcess } from "@opencode-ai/core/process"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"

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
})
