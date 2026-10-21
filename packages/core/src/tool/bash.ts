export * as BashTool from "./bash"

import path from "path"
import { open, mkdir, readFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createHash } from "crypto"
import { ToolFailure } from "@opencode-ai/llm"
import { Duration, Effect, Layer, Option, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Config } from "../config"
import { ContentStore } from "../content-store"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { ShellCommandAccess } from "../permission/shell-command-access"
import { AppProcess } from "../process"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { Shell } from "../shell"
import { executablePath } from "../util/windows-path"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "bash"
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
export const MAX_TIMEOUT_MS = 10 * 60 * 1_000
export const MAX_CAPTURE_BYTES = 1024 * 1024
/** Combined stdout+stderr spool ceiling for the durable original capture. */
export const MAX_SPOOL_CAPTURE_BYTES = 128 * 1024 * 1024
/** Above this size the spooled original cannot be published as a session attachment. */
const MAX_SPOOL_STORE_BYTES = ContentStore.MAX_ATTACHMENT_BYTES

export const Input = Schema.Struct({
  command: Schema.String.annotate({ description: "Shell command string to execute" }),
  workdir: Schema.String.pipe(Schema.optional).annotate({
    description: "Working directory. Defaults to the active Location; relative paths resolve from that Location.",
  }),
  timeout: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS))
    .pipe(Schema.optional)
    .annotate({
      description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS} and may not exceed ${MAX_TIMEOUT_MS}.`,
    }),
  description: Schema.String.pipe(Schema.optional).annotate({
    description: "Concise description of the command's purpose",
  }),
})

export const Output = Schema.Struct({
  command: Schema.String,
  cwd: Schema.String,
  exitCode: Schema.Number.pipe(Schema.optional),
  /** Bounded compact equivalent of stdout/stderr: stderr is labeled when present. */
  output: Schema.String,
  truncated: Schema.Boolean,
  stdoutTruncated: Schema.Boolean.pipe(Schema.optional),
  stderrTruncated: Schema.Boolean.pipe(Schema.optional),
  timedOut: Schema.Boolean.pipe(Schema.optional),
  warnings: Schema.Array(Schema.String).pipe(Schema.optional),
  /** Durable original capture: session-owned artifact reference and honest completeness. */
  capture: Schema.Struct({
    uri: Schema.String.pipe(Schema.optional),
    bytes: Schema.Number,
    stdoutBytes: Schema.Number,
    stderrBytes: Schema.Number,
    sha256: Schema.String,
    complete: Schema.Boolean,
    reason: Schema.String.pipe(Schema.optional),
  }).pipe(Schema.optional),
})

export type Output = typeof Output.Type

const compactOutput = (stdout: string, stderr: string) => {
  const output = stdout && stderr ? `${stdout}\n\nstderr:\n${stderr}` : stderr ? `stderr:\n${stderr}` : stdout
  return output || "(no output)"
}

const captureNotice = (
  streams: {
    name: "stdout" | "stderr"
    truncated: boolean
    truncatedReason?: "byte-limit"
    eofTimeout?: boolean
  }[],
) => {
  const notices: string[] = []
  const limit = streams.filter((stream) => stream.truncated && stream.truncatedReason === "byte-limit")
  if (limit.length === 2) notices.push("[stdout and stderr capture truncated at the in-memory safety limit]")
  else if (limit.length === 1) notices.push(`[${limit[0].name} capture truncated at the in-memory safety limit]`)
  // EOF that never arrived inside the bounded drain window is a different
  // fact: the capture itself may be missing output after the cutoff.
  const eof = streams.filter((stream) => stream.eofTimeout)
  if (eof.length === 2)
    notices.push(
      "[stdout and stderr capture may be incomplete: the streams did not close within the bounded drain window after exit; a detached descendant process can still hold the pipes]",
    )
  else if (eof.length === 1)
    notices.push(
      `[${eof[0].name} capture may be incomplete: the stream did not close within the bounded drain window after exit; a detached descendant process can still hold the pipe]`,
    )
  return notices.length > 0 ? notices.join("\n") : undefined
}

export const toModelOutput = (output: Output) => {
  const warnings = output.warnings?.length
    ? `\n\nWarnings:\n${output.warnings.map((warning) => `- ${warning}`).join("\n")}`
    : ""
  if (output.timedOut) return `${output.output}${warnings}\n\nCommand timed out before completion.`
  return `${output.output}${warnings}\n\nCommand exited with code ${output.exitCode}.`
}

const isTimeout = (error: AppProcess.AppProcessError) =>
  error.cause instanceof Error && error.cause.message === "Timed out"

// The generic "Unable to execute command" settlement must keep its cause visible
// (spawn failures are otherwise indistinguishable from timeouts in the transcript).
const describeExecutionFailure = (error: { readonly cause?: unknown }) => {
  const cause = error.cause instanceof Error ? error.cause : undefined
  if (cause === undefined) return ""
  if (cause.message === "Timed out") return " (command timed out)"
  return ` (${cause.message.slice(0, 300)})`
}

// Permission decisions (allow/deny/ask pipeline outcomes) are not spawn
// failures. They travel as typed defects so the runner can render each class
// distinctly instead of masking them behind the generic execution failure.
const isPermissionDecision = (error: unknown): error is PermissionV2.Error =>
  error instanceof PermissionV2.CorrectedError ||
  error instanceof PermissionV2.DeclinedError ||
  error instanceof PermissionV2.DeniedError ||
  error instanceof PermissionV2.RejectedError

export function budgetCategory(input: unknown): Tool.BudgetCategory {
  if (typeof input !== "object" || input === null || !("command" in input)) return "poll"
  const command = (input as { readonly command?: unknown }).command
  if (typeof command !== "string") return "poll"
  return ShellCommandAccess.classify(command) === "read" ? "read" : "poll"
}

/**
 * Minimal V2 core shell boundary. Keep parity debt visible without pulling the
 * legacy shell runtime into core.
 */
// TODO: Port tree-sitter bash / PowerShell parser-based approval reduction.
// TODO: Port BashArity reusable command-prefix approvals.
// TODO: Replace token-based command-argument external-directory advisories with parser-based detection.
// TODO: Restore cmd-specific invocation/path handling on Windows.
// TODO: Add plugin shell.env environment augmentation once V2 plugin hooks exist.
// TODO: Add durable/live progress metadata streaming for long-running commands once V2 tool invocation progress context is wired.
// TODO: Persist background job status and define restart recovery before exposing remote observation.
// TODO: Re-add model-facing background launch only with owner-bound get/wait/cancel tools and completion delivery.
// TODO: Add HTTP background-job observation only after durable status, restart recovery, and authorization are defined.
// TODO: Revisit process-group cleanup and platform coverage with shell-specific tests if current AppProcess semantics do not fully cover it.
// TODO: Revisit binary output handling if stdout/stderr decoding is text-only.
// TODO: Stream full shell output into managed storage while retaining only a bounded in-memory preview.

const shellTokens = (command: string) => command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/, "$2")
const commandPath = (value: string) => FSUtil.windowsPath(value)
export const externalCommandDirectories = (command: string, cwd: string) => {
  const directories = new Set<string>()
  for (const token of shellTokens(command)) {
    const value = commandPath(unquote(token).replace(/[;,|&]+$/, ""))
    if (!path.isAbsolute(value)) continue
    // This advisory scan must never touch the filesystem: resolving an offline
    // UNC argument synchronously can block the entire desktop sidecar.
    const resolved = path.resolve(value)
    if (FSUtil.contains(cwd, resolved)) continue
    directories.add(path.dirname(resolved))
  }
  return [...directories]
}

const makeCommand = (shell: string, command: string, cwd: string) => {
  const environment =
    process.platform === "win32" ? { env: { Path: executablePath() }, extendEnv: true as const } : {}
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      ...environment,
      cwd,
      stdin: "ignore",
      detached: false,
      forceKillAfter: Duration.seconds(3),
    })
  }
  return ChildProcess.make(command, [], {
    ...environment,
    cwd,
    shell,
    stdin: "ignore",
    detached: process.platform !== "win32",
    forceKillAfter: Duration.seconds(3),
  })
}

export const modelDescription = (shell: string) => {
  const selected = `The selected shell for this tool registration is ${Shell.name(shell)} (${shell}); write commands in that shell's syntax.`
  const base = `Execute one shell command string with the host user's filesystem, process, and network authority. The active Location is the default working directory. Relative workdir values resolve from that Location. External workdir values require external_directory approval; best-effort command-argument path warnings are advisory only. Timeout values are milliseconds (default: ${DEFAULT_TIMEOUT_MS}; maximum: ${MAX_TIMEOUT_MS}). ${selected}`
  if (process.platform !== "win32" || Shell.name(shell) !== "powershell") return base
  return `${base} Windows PowerShell 5 syntax is active: use the workdir field instead of a leading cd, separate commands with semicolons (;) instead of &&, and use Select-Object -First instead of head.`
}

/**
 * Spools one stream to a temp file exactly once while the process drains, before the
 * in-memory capture ceiling applies. Streaming SHA-256; never re-runs the command.
 */
const spoolFile = async (label: string) => {
  const directory = path.join(tmpdir(), "opencode-shell-spool")
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, `${process.pid}-${label}-${Math.random().toString(36).slice(2)}`)
  const handle = await open(file, "w")
  const hash = createHash("sha256")
  let bytes = 0
  let overflowed = false
  let pending = Promise.resolve()
  return {
    file,
    write(chunk: Uint8Array) {
      if (overflowed) return
      if (bytes + chunk.byteLength > MAX_SPOOL_CAPTURE_BYTES) {
        overflowed = true
        return
      }
      bytes += chunk.byteLength
      hash.update(chunk)
      const data = chunk
      pending = pending.then(async () => {
        await handle.write(data)
      })
    },
    async finish() {
      await pending
      await handle.close()
      return { file, bytes, sha256: hash.digest("hex"), overflowed }
    },
    async dispose() {
      await pending.catch(() => undefined)
      await handle.close().catch(() => undefined)
      await unlink(file).catch(() => undefined)
    },
  }
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const appProcess = yield* AppProcess.Service
    const config = yield* Config.Service
    const permission = yield* PermissionV2.Service
    const shell = Shell.acceptable(Config.latest(yield* config.entries(), "shell"))
    const contentStore = Option.getOrUndefined(yield* Effect.serviceOption(ContentStore.Service))

    yield* tools
      .register({
        [name]: Tool.make({
          description: modelDescription(shell),
          input: Input,
          output: Output,
          budgetCategory,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const source = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
              const target = yield* mutation.resolve({ path: input.workdir ?? ".", kind: "directory" })
              const external = target.externalDirectory
              if (external)
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(external),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
              const warnings = externalCommandDirectories(input.command, target.canonical).map(
                (directory) =>
                  `Command argument references external directory ${path.join(directory, "*").replaceAll("\\", "/")}. Bash runs with host-user filesystem, process, and network authority; this scan is advisory only.`,
              )
              yield* permission.assert({
                action: name,
                resources: [input.command],
                save: [input.command],
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })

              if ((yield* fs.stat(target.canonical)).type !== "Directory")
                return yield* Effect.fail(new Error(`Working directory is not a directory: ${target.canonical}`))

              const command = makeCommand(shell, input.command, target.canonical)
              const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS
              // Spool both streams exactly once while draining; publish the original
              // before the release hook unlinks the temp files.
              return yield* Effect.acquireUseRelease(
                Effect.promise(() => Promise.all([spoolFile("stdout"), spoolFile("stderr")])),
                ([stdoutSpool, stderrSpool]) =>
                  Effect.gen(function* () {
                    const result = yield* appProcess
                      .run(command, {
                        timeout: Duration.millis(timeout),
                        maxOutputBytes: MAX_CAPTURE_BYTES,
                        maxErrorBytes: MAX_CAPTURE_BYTES,
                        spoolStdout: (chunk) => stdoutSpool.write(chunk),
                        spoolStderr: (chunk) => stderrSpool.write(chunk),
                      })
                      .pipe(
                        Effect.catchTag("AppProcessError", (error) =>
                          isTimeout(error) ? Effect.succeed(undefined) : Effect.fail(error),
                        ),
                      )
                    const stdoutSpooled = yield* Effect.promise(() => stdoutSpool.finish())
                    const stderrSpooled = yield* Effect.promise(() => stderrSpool.finish())
                    if (!result) {
                      return {
                        command: input.command,
                        cwd: target.canonical,
                        output: `Command exceeded timeout of ${timeout} ms. Retry with a larger timeout if the command is expected to take longer.`,
                        truncated: false,
                        timedOut: true,
                        ...(warnings.length ? { warnings } : {}),
                      }
                    }

                    const spooledBytes = stdoutSpooled.bytes + stderrSpooled.bytes
                    const spoolOverflowed = stdoutSpooled.overflowed || stderrSpooled.overflowed
                    const modelViewTruncated = result.stdoutTruncated || result.stderrTruncated
                    const captureSha = createHash("sha256")
                      .update(stdoutSpooled.sha256)
                      .update(stderrSpooled.sha256)
                      .digest("hex")
                    const publishable =
                      stdoutSpooled.bytes <= MAX_SPOOL_STORE_BYTES && stderrSpooled.bytes <= MAX_SPOOL_STORE_BYTES
                    const stored =
                      contentStore && (spoolOverflowed || modelViewTruncated) && publishable && spooledBytes > 0
                        ? yield* Effect.gen(function* () {
                            const stdoutText = yield* Effect.promise(() => readFile(stdoutSpooled.file, "utf8"))
                            const stderrText = yield* Effect.promise(() => readFile(stderrSpooled.file, "utf8"))
                            return yield* contentStore
                              .storeTextAttachment({
                                sessionID: context.sessionID,
                                messageID: context.assistantMessageID,
                                key: `${context.assistantMessageID ?? context.toolCallID}:${context.toolCallID}:shell-original`,
                                text: `$ opencode shell capture: ${input.command}\n$ cwd: ${target.canonical}\n\n[stdout]\n${stdoutText}\n[stderr]\n${stderrText}`,
                                mime: "text/plain",
                                name: `${context.toolCallID}-shell-output.txt`,
                              })
                              .pipe(Effect.catch(() => Effect.succeed(undefined)))
                          })
                        : undefined
                    const compact = compactOutput(result.stdout.toString("utf8"), result.stderr.toString("utf8"))
                    const notice = captureNotice([
                      {
                        name: "stdout",
                        truncated: result.stdoutTruncated,
                        truncatedReason: result.stdoutTruncatedReason,
                        eofTimeout: result.stdoutEofTimeout,
                      },
                      {
                        name: "stderr",
                        truncated: result.stderrTruncated,
                        truncatedReason: result.stderrTruncatedReason,
                        eofTimeout: result.stderrEofTimeout,
                      },
                    ])
                    // Any stream whose EOF never arrived leaves part of the
                    // capture unobserved, no matter which stream hit the
                    // in-memory limit.
                    const captureComplete = !spoolOverflowed && !result.stdoutEofTimeout && !result.stderrEofTimeout
                    const retrieval =
                      stored !== undefined
                        ? `\n\n[${captureComplete ? "full" : "partial"} original output stored at ${stored.uri}; page through it with read using this attachment path]`
                        : ""
                    return {
                      command: input.command,
                      cwd: target.canonical,
                      exitCode: result.exitCode,
                      output: `${notice ? `${compact}\n\n${notice}` : compact}${retrieval}`,
                      truncated: modelViewTruncated,
                      ...(warnings.length ? { warnings } : {}),
                      // Per-stream flags: a stderr-only truncation must not
                      // claim stdout truncation.
                      ...(result.stdoutTruncated ? { stdoutTruncated: true } : {}),
                      ...(result.stderrTruncated ? { stderrTruncated: true } : {}),
                      ...((spoolOverflowed || modelViewTruncated) && spooledBytes > 0
                        ? {
                            capture: {
                              ...(stored !== undefined ? { uri: stored.uri } : {}),
                              bytes: spooledBytes,
                              stdoutBytes: stdoutSpooled.bytes,
                              stderrBytes: stderrSpooled.bytes,
                              sha256: captureSha,
                              complete: captureComplete,
                              ...(spoolOverflowed ? { reason: "spool capture ceiling reached" } : {}),
                            },
                          }
                        : {}),
                    }
                  }),
                ([stdoutSpool, stderrSpool]) =>
                  Effect.promise(() => Promise.all([stdoutSpool.dispose(), stderrSpool.dispose()]).then(() => undefined)),
              )
            }).pipe(
              // Permission decisions keep their typed identity as defects: the
              // runner renders CorrectedError.feedback as the tool result and
              // never retries it, and decline aborts the turn. Collapsing them
              // into "Unable to execute" made safety redirects look like spawn
              // failures and invited bypass retries with StartProcess/cmd
              // start variants.
              Effect.catchIf(isPermissionDecision, (error) => Effect.die(error)),
              Effect.mapError((error) =>
                new ToolFailure({
                  message: `Unable to execute command: ${input.command}${describeExecutionFailure(error)}`,
                }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
