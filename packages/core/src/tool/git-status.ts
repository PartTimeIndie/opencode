export * as GitStatusTool from "./git-status"

import { ToolFailure } from "@opencode-ai/llm"
import { Duration, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Location } from "../location"
import { AppProcess } from "../process"
import { PermissionV2 } from "../permission"
import { executablePath } from "../util/windows-path"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "git_status"
export const DEFAULT_TIMEOUT_MS = 15_000
export const MAX_SUMMARY_BYTES = 64 * 1024
export const MAX_PATCH_BYTES = 32 * 1024

export const Input = Schema.Struct({
  scope: Schema.Literals(["summary", "patch"]).pipe(Schema.optional).annotate({
    description:
      '"summary" (default) returns the branch-aware short status plus diff --stat for unstaged and staged changes. "patch" additionally returns the full diffs, capped at 32 KB per section.',
  }),
})

export const Output = Schema.Struct({
  scope: Schema.Literals(["summary", "patch"]),
  output: Schema.String,
  truncated: Schema.Boolean,
})

export type Output = typeof Output.Type

export const toModelOutput = (output: Output) => {
  const marker = output.truncated ? "\n\n[git_status output truncated at the bounded capture limit]" : ""
  return `${output.output}${marker}`
}

// Fixed argument vectors only: reviewers can never turn this tool into a
// general shell, and every section is byte-capped so a huge worktree cannot
// flood the reviewer context.
const SECTIONS = {
  summary: [
    { args: ["status", "--short", "--branch", "--untracked-files=all"], maxOutputBytes: MAX_SUMMARY_BYTES },
    { args: ["--no-pager", "diff", "--stat"], maxOutputBytes: MAX_SUMMARY_BYTES },
    { args: ["--no-pager", "diff", "--cached", "--stat"], maxOutputBytes: MAX_SUMMARY_BYTES },
  ],
  patch: [
    { args: ["status", "--short", "--branch", "--untracked-files=all"], maxOutputBytes: MAX_SUMMARY_BYTES },
    { args: ["--no-pager", "diff", "--stat"], maxOutputBytes: MAX_SUMMARY_BYTES },
    { args: ["--no-pager", "diff"], maxOutputBytes: MAX_PATCH_BYTES },
    { args: ["--no-pager", "diff", "--cached", "--stat"], maxOutputBytes: MAX_SUMMARY_BYTES },
    { args: ["--no-pager", "diff", "--cached"], maxOutputBytes: MAX_PATCH_BYTES },
  ],
} as const

const describeSpawnFailure = (error: AppProcess.AppProcessError) => {
  const cause = error.cause instanceof Error ? error.cause : undefined
  return `Unable to run git: ${cause?.message ?? "unknown error"}`
}

const describeGitFailure = (args: readonly string[], result: AppProcess.RunResult) => {
  const stderr = result.stderr.toString("utf8").trim()
  return `git ${args.join(" ")} failed: ${stderr || `git exited with code ${result.exitCode}`}`
}

/** Read-only working-tree verification leaf for review workflows. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service
    const appProcess = yield* AppProcess.Service

    const runGit = (args: readonly string[], maxOutputBytes: number) =>
      appProcess.run(
        ChildProcess.make(
          "git",
          [
            "--no-pager",
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "color.status=false",
            ...args,
            ...(args.includes("diff") ? ["--no-ext-diff", "--no-textconv", "--no-color"] : []),
          ],
          {
            // An inherited GIT_DIR/WORK_TREE or config override must not redirect
            // reviewers or turn read-only inspection into repository callbacks.
            env: {
              ...Object.fromEntries(
                Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
              ),
              ...(process.platform === "win32" ? { Path: executablePath() } : {}),
              GIT_OPTIONAL_LOCKS: "0",
              GIT_TERMINAL_PROMPT: "0",
              GIT_NO_LAZY_FETCH: "1",
            },
            extendEnv: false,
            cwd: location.directory,
            stdin: "ignore",
            detached: false,
          },
        ),
        { timeout: Duration.millis(DEFAULT_TIMEOUT_MS), maxOutputBytes, maxErrorBytes: 8 * 1024 },
      )

    const runSection = (args: readonly string[], maxOutputBytes: number) =>
      Effect.gen(function* () {
        const result = yield* Effect.mapError(
          runGit(args, maxOutputBytes),
          (error) => new Error(describeSpawnFailure(error)),
        )
        if (result.exitCode !== 0) return yield* Effect.fail(new Error(describeGitFailure(args, result)))
        return { text: result.stdout.toString("utf8"), truncated: result.stdoutTruncated }
      })

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            'Inspect Git status and diffs for a code review without shell access. The default scope "summary" returns branch, untracked file names and staged/unstaged diff statistics. Use scope "patch" to read the actual staged and unstaged changes. Patches are byte-capped; truncated output is not a complete diff. Untracked file contents require read. This read-only tool disables repository callbacks and optional index writes.',
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const scope = input.scope ?? "summary"
              yield* permission.assert({
                action: name,
                resources: [scope],
                save: ["*"],
                metadata: { scope },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const parts: string[] = []
              let truncated = false
              for (const section of SECTIONS[scope]) {
                const result = yield* runSection(section.args, section.maxOutputBytes)
                truncated ||= result.truncated
                parts.push(`$ git ${section.args.join(" ")}\n${result.text.trimEnd() || "(no output)"}`)
              }
              return { scope, output: parts.join("\n\n"), truncated }
            }).pipe(
              Effect.mapError(
                (error) =>
                  new ToolFailure({
                    message: error instanceof Error ? error.message : "Unable to inspect the git working tree state",
                  }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
