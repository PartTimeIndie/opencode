import fs from "fs/promises"
import { realpathSync } from "node:fs"
import path from "path"
import { describe, expect, spyOn, test } from "bun:test"
import { Cause, Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@opencode-ai/core/config"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AppProcess } from "@opencode-ai/core/process"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { Shell } from "@opencode-ai/core/shell"
import { BashTool } from "@opencode-ai/core/tool/bash"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ContentStore } from "@opencode-ai/core/content-store"
import { FileAttachment, Prompt } from "@opencode-ai/core/session/prompt"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_bash_tool_test")
const storedAttachments: Array<{ key?: string; text: string }> = []
const contentStore = Layer.succeed(
  ContentStore.Service,
  ContentStore.Service.of({
    putBlob: (input) =>
      Effect.succeed({ sha256: "0".repeat(64), mime: input.mime, path: "content", sizeBytes: input.bytes.byteLength }),
    locateBlob: () => Effect.succeed(undefined),
    readBlob: () => Effect.succeed(undefined),
    storeAttachment: (input) =>
      Effect.succeed(new FileAttachment({ uri: `attachment://${input.name}`, mime: input.mime, name: input.name })),
    storeTextAttachment: (input) => {
      storedAttachments.push(input)
      return Effect.succeed(new FileAttachment({ uri: "attachment://shell-capture", mime: input.mime, name: input.name }))
    },
    normalizePrompt: (input) =>
      Effect.succeed(
        new Prompt({
          ...input.prompt,
          files: input.prompt.files?.map(
            (file, index) => new FileAttachment({ ...file, uri: `${ContentStore.URI_PREFIX}${input.messageID}_${index}` }),
          ),
        }),
      ),
    normalizeFiles: (input) => Effect.succeed(input.files),
    locate: () => Effect.succeed(undefined),
    resolve: () => Effect.succeed(undefined),
    materialize: (input) => Effect.succeed(input.file),
  }),
)
const assertions: PermissionV2.AssertInput[] = []
const runs: Array<{
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly shell?: string | boolean
  readonly env?: NodeJS.ProcessEnv
  readonly extendEnv?: boolean
  readonly options?: AppProcess.RunOptions
}> = []
let denyAction: string | undefined
let configEntries: Config.Entry[] = []
let result: AppProcess.RunResult = {
  command: "mock",
  exitCode: 0,
  stdout: Buffer.from("hello\n"),
  stderr: Buffer.alloc(0),
  stdoutTruncated: false,
  stderrTruncated: false,
}
let runFailure: AppProcess.AppProcessError | undefined
let spoolFeed: Uint8Array[] = []
let afterPermission: (input: PermissionV2.AssertInput) => Effect.Effect<void, PermissionV2.Error | SessionV2.NotFoundError> = () => Effect.void

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(Effect.suspend(() => afterPermission(input))),
        Effect.andThen(
          input.action === denyAction ? Effect.fail(new PermissionV2.DeniedError({ rules: [] })) : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    materializationRules: () => Effect.succeed([]),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const appProcess = Layer.succeed(
  AppProcess.Service,
  AppProcess.Service.of({
    run: (command: ChildProcess.Command, options?: AppProcess.RunOptions) =>
      Effect.suspend(() => {
        if (command._tag !== "StandardCommand") throw new Error("expected standard command")
        runs.push({
          command: command.command,
          args: command.args,
          cwd: command.options.cwd,
          shell: command.options.shell,
          env: command.options.env,
          extendEnv: command.options.extendEnv,
          options,
        })
        for (const chunk of spoolFeed) {
          options?.spoolStdout?.(chunk)
          options?.spoolStderr?.(chunk)
        }
        return runFailure ? Effect.fail(runFailure) : Effect.succeed(result)
      }),
  } as unknown as AppProcess.Interface),
)
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed(configEntries),
  }),
)

const reset = () => {
  assertions.length = 0
  runs.length = 0
  denyAction = undefined
  configEntries = []
  runFailure = undefined
  spoolFeed = []
  storedAttachments.length = 0
  afterPermission = () => Effect.void
  result = {
    command: "mock",
    exitCode: 0,
    stdout: Buffer.from("hello\n"),
    stderr: Buffer.alloc(0),
    stdoutTruncated: false,
    stderrTruncated: false,
  }
}

const withTool = <A, E, R>(
  directory: string,
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
  processLayer: Layer.Layer<AppProcess.Service> = appProcess,
  contentStoreLayer?: Layer.Layer<ContentStore.Service>,
) => {
  const filesystem = FSUtil.defaultLayer
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  const mutation = LocationMutation.layer.pipe(Layer.provide(filesystem), Layer.provide(activeLocation))
  const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
  const bash = BashTool.layer.pipe(
    Layer.provide(registry),
    Layer.provide(permission),
    Layer.provide(mutation),
    Layer.provide(filesystem),
    Layer.provide(processLayer),
    Layer.provide(config),
  )
  const withStore = contentStoreLayer ? bash.pipe(Layer.provideMerge(contentStoreLayer)) : bash
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(Effect.provide(Layer.mergeAll(registry, withStore)))
}

const call = (input: typeof BashTool.Input.Type, id = "call-bash") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "bash", input },
})

const it = testEffect(Layer.empty)

const dieDefects = (cause: Cause.Cause<unknown>) => cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect)

test("inspects UNC command arguments without filesystem canonicalization", () => {
  if (process.platform !== "win32") return
  const resolve = spyOn(FSUtil, "resolve").mockImplementation(() => {
    throw new Error("command-argument scan must not access the filesystem")
  })
  try {
    const directory = String.raw`\\BeeStation\home\PU_Recordings`
    expect(BashTool.externalCommandDirectories(`Test-Path -LiteralPath '${directory}'`, "C:\\GitRepros\\opencode")).toEqual([
      path.dirname(directory),
    ])
  } finally {
    resolve.mockRestore()
  }
})

describe("BashTool", () => {
  it.live("registers and returns structured successful output from the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const definitions = yield* toolDefinitions(registry)
            expect(definitions.map((tool) => tool.name)).toEqual(["bash"])
            expect(definitions[0]?.description).toContain(
              `selected shell for this tool registration is ${Shell.name(Shell.acceptable())} (${Shell.acceptable()})`,
            )
            expect(definitions[0]?.description).not.toContain("COMSPEC or cmd.exe")
            expect(definitions[0]?.inputSchema).not.toHaveProperty("properties.background")
            expect(yield* toolDefinitions(registry, [{ action: "bash", resource: "*", effect: "deny" }])).toEqual([])
            expect(
              yield* settleTool(registry, call({ command: "pwd", description: "Print working directory" })),
            ).toEqual({
              result: { type: "text", value: "hello\n\n\nCommand exited with code 0." },
              output: {
                structured: {
                  command: "pwd",
                  cwd: realpathSync(tmp.path),
                  exitCode: 0,
                  output: "hello\n",
                  truncated: false,
                },
                content: [{ type: "text", text: "hello\n\n\nCommand exited with code 0." }],
              },
            })
            expect(runs).toHaveLength(1)
            expect(runs[0]?.cwd).toBe(realpathSync(tmp.path))
            if (process.platform === "win32") {
              expect(runs[0]?.env?.Path).toContain(";")
              expect(runs[0]?.extendEnv).toBe(true)
            }
            expect(runs[0]?.options).toMatchObject({
              maxOutputBytes: BashTool.MAX_CAPTURE_BYTES,
              maxErrorBytes: BashTool.MAX_CAPTURE_BYTES,
            })
            expect(assertions).toMatchObject([{ sessionID, action: "bash", resources: ["pwd"], save: ["pwd"] }])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("uses the configured acceptable shell when present", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const shell = process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh"
        configEntries = [new Config.Document({ type: "document", info: new Config.Info({ shell }) })]
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const description = (yield* toolDefinitions(registry))[0]?.description
            expect(description).toContain(
              `selected shell for this tool registration is ${Shell.name(Shell.acceptable(shell))} (${Shell.acceptable(shell)})`,
            )
            expect(description).not.toContain("Windows PowerShell 5 syntax is active")
            return yield* executeTool(registry, call({ command: "echo configured" }))
          }),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              expect(runs[0]?.shell).toBe(Shell.acceptable(shell))
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  if (process.platform === "win32") {
    const powershell = Bun.which("powershell")
    if (powershell) {
      it.live("invokes configured PowerShell with explicit non-interactive arguments", () =>
        Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => {
            reset()
            configEntries = [new Config.Document({ type: "document", info: new Config.Info({ shell: powershell }) })]
            return withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                const description = (yield* toolDefinitions(registry))[0]?.description
                expect(description).toContain(
                  `selected shell for this tool registration is powershell (${Shell.acceptable(powershell)})`,
                )
                expect(description).toContain("workdir field instead of a leading cd")
                expect(description).toContain("semicolons (;) instead of &&")
                expect(description).toContain("Select-Object -First instead of head")
                return yield* executeTool(registry, call({ command: "Write-Output hello" }))
              }),
            ).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  expect(runs[0]?.command).toBe(Shell.acceptable(powershell))
                  expect(runs[0]?.args).toEqual([
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Write-Output hello",
                  ])
                  expect(runs[0]?.shell).toBeUndefined()
                }),
              ),
            )
          },
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        ),
      )
    }

    const pwsh = Bun.which("pwsh")
    if (pwsh) {
      test("does not apply Windows PowerShell 5 guidance to pwsh", () => {
        expect(BashTool.modelDescription(pwsh)).toContain(`selected shell for this tool registration is pwsh (${pwsh})`)
        expect(BashTool.modelDescription(pwsh)).not.toContain("Windows PowerShell 5 syntax is active")
      })
    }
  }

  it.live("resolves a relative workdir from the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.mkdir(path.join(tmp.path, "src"))).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) => executeTool(registry, call({ command: "pwd", workdir: "src" }))),
          ),
          Effect.andThen(
            Effect.sync(() => expect(runs).toMatchObject([{ cwd: realpathSync(path.join(tmp.path, "src")) }])),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects a workdir that stops being a directory during approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const workdir = path.join(tmp.path, "src")
        afterPermission = (input) =>
          input.action === "bash"
            ? Effect.promise(async () => {
                await fs.rm(workdir, { recursive: true })
                await fs.writeFile(workdir, "not a directory")
              }).pipe(Effect.orDie)
            : Effect.void
        return Effect.promise(() => fs.mkdir(workdir)).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) => executeTool(registry, call({ command: "pwd", workdir: "src" }))),
          ),
          Effect.andThen(
            Effect.sync(() => {
              expect(runs).toEqual([])
              expect(assertions.map((input) => input.action)).toEqual(["bash"])
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  if (process.platform !== "win32") {
    it.live("executes a real shell command through AppProcess", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withTool(
            tmp.path,
            (registry) => settleTool(registry, call({ command: "printf core-bash" })),
            AppProcess.defaultLayer,
          ).pipe(
            Effect.andThen((settled) =>
              Effect.sync(() => {
                expect(settled.result).toEqual({ type: "text", value: "core-bash\n\nCommand exited with code 0." })
                expect(settled.output?.structured).toMatchObject({
                  command: "printf core-bash",
                  cwd: realpathSync(tmp.path),
                  exitCode: 0,
                  output: "core-bash",
                })
              }),
            ),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  }

  it.live("approves an explicit external workdir before bash execution", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        return withTool(active.path, (registry) =>
          executeTool(registry, call({ command: "pwd", workdir: outside.path })),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              expect(assertions.map((item) => item.action)).toEqual(["external_directory", "bash"])
              expect(assertions[0]).toMatchObject({
                resources: [path.join(realpathSync(outside.path), "*").replaceAll("\\", "/")],
              })
              expect(runs).toHaveLength(1)
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("does not execute after external-directory or bash denial", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          reset()
          denyAction = "external_directory"
          const external = yield* withTool(active.path, (registry) =>
            executeTool(registry, call({ command: "pwd", workdir: outside.path })).pipe(
              Effect.catchCause((cause) => Effect.succeed(dieDefects(cause))),
            ),
          )
          expect(external).toEqual([expect.any(PermissionV2.DeniedError)])
          expect(assertions.map((item) => item.action)).toEqual(["external_directory"])
          expect(runs).toEqual([])

          reset()
          denyAction = "bash"
          const denied = yield* withTool(active.path, (registry) =>
            executeTool(registry, call({ command: "pwd" })).pipe(
              Effect.catchCause((cause) => Effect.succeed(dieDefects(cause))),
            ),
          )
          expect(denied).toEqual([expect.any(PermissionV2.DeniedError)])
          expect(assertions.map((item) => item.action)).toEqual(["bash"])
          expect(runs).toEqual([])
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("reports external command arguments as advisory warnings without enforcing approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        denyAction = "external_directory"
        const target = path.join(outside.path, "secret.txt")
        return withTool(active.path, (registry) => settleTool(registry, call({ command: `cat ${target}` }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(assertions.map((item) => item.action)).toEqual(["bash"])
              expect(runs).toHaveLength(1)
              expect(settled.output?.structured).toMatchObject({
                warnings: [
                  `Command argument references external directory ${path.join(realpathSync(outside.path), "*").replaceAll("\\", "/")}. Bash runs with host-user filesystem, process, and network authority; this scan is advisory only.`,
                ],
              })
              expect(settled.result).toMatchObject({ type: "text", value: expect.stringContaining("Warnings:") })
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  if (process.platform === "win32") {
    it.live("normalizes slash-style Windows command arguments before advisory warnings", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
        ([active, outside]) => {
          reset()
          const target = path.join(outside.path, "secret.txt")
          const slashTarget = `/${target[0]}${target.slice(2).replaceAll("\\", "/")}`
          return withTool(active.path, (registry) => settleTool(registry, call({ command: `cat ${slashTarget}` }))).pipe(
            Effect.andThen((settled) =>
              Effect.sync(() => {
                expect(settled.output?.structured).toMatchObject({
                  warnings: [
                    `Command argument references external directory ${path.join(realpathSync(outside.path), "*").replaceAll("\\", "/")}. Bash runs with host-user filesystem, process, and network authority; this scan is advisory only.`,
                  ],
                })
              }),
            ),
          )
        },
        ([active, outside]) =>
          Effect.promise(() =>
            Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
          ),
      ),
    )
  }

  it.live("keeps non-zero exits useful", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        result = { ...result, exitCode: 7, stdout: Buffer.from("HEAD full output TAIL") }
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "false" }, "call-overflow"))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.result).toMatchObject({
                type: "text",
                value: expect.stringContaining("Command exited with code 7"),
              })
              expect(settled.output?.structured).toMatchObject({
                command: "false",
                cwd: realpathSync(tmp.path),
                exitCode: 7,
                output: "HEAD full output TAIL",
                truncated: false,
              })
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("surfaces bounded process-capture truncation", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        result = { ...result, stdoutTruncated: true, stdoutTruncatedReason: "byte-limit" }
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "verbose" }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.output?.structured).toMatchObject({ truncated: true, stdoutTruncated: true })
              expect(settled.result).toMatchObject({
                type: "text",
                value: expect.stringContaining("stdout capture truncated"),
              })
              expect(settled.output?.structured).not.toHaveProperty("resource")
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("returns a useful timeout settlement", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        runFailure = new AppProcess.AppProcessError({ command: "sleep", cause: new Error("Timed out") })
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "sleep 60", timeout: 10 }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.result).toMatchObject({
                type: "text",
                value: expect.stringContaining("Command timed out"),
              })
              expect(settled.output?.structured).toMatchObject({
                command: "sleep 60",
                timedOut: true,
                truncated: false,
              })
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("reports the hidden execution cause on tool failure", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        runFailure = new AppProcess.AppProcessError({ command: "dir", cause: new Error("spawn EBUSY") })
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "dir" }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.result).toMatchObject({
                type: "error",
                value: expect.stringContaining("Unable to execute command: dir (spawn EBUSY)"),
              })
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  const captureCauseCase = (patch: Partial<AppProcess.RunResult>, storeLayer: Layer.Layer<ContentStore.Service> = contentStore) =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        storedAttachments.length = 0
        spoolFeed = [Buffer.from("observed before the cutoff")]
        result = {
          ...result,
          stdout: Buffer.from("observed before the cutoff"),
          stdoutTruncated: true,
          stderrTruncated: true,
          ...patch,
        }
        return withTool(
          tmp.path,
          (registry) => settleTool(registry, call({ command: "node kept-pipe.cjs" })),
          appProcess,
          storeLayer,
        ).pipe(
          Effect.andThen((settled) =>
            Effect.succeed({
              text: settled.result,
              output: settled.output?.structured as (typeof BashTool.Output.Type) | undefined,
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )

  it.live("keeps an unexplained stream EOF honest: incomplete capture, no full-output claim", () =>
    captureCauseCase({
      stdoutTruncatedReason: undefined,
      stderrTruncatedReason: undefined,
      stdoutEofTimeout: true,
      stderrEofTimeout: true,
    }).pipe(
      Effect.andThen(({ text, output }) =>
        Effect.sync(() => {
          expect(text.value).toContain("capture may be incomplete")
          expect(text.value).toContain("bounded drain window")
          expect(text.value).not.toContain("in-memory safety limit")
          expect(text.value).not.toContain("full original output")
          expect(output?.capture).toMatchObject({ complete: false })
        }),
      ),
    )
  )

  it.live("keeps the safety-limit wording and full-output retrieval for a pure byte limit", () =>
    captureCauseCase({
      stdoutTruncatedReason: "byte-limit",
      stderrTruncatedReason: "byte-limit",
      stdoutEofTimeout: undefined,
      stderrEofTimeout: undefined,
    }).pipe(
      Effect.andThen(({ text, output }) =>
        Effect.sync(() => {
          expect(text.value).toContain("capture truncated at the in-memory safety limit")
          expect(text.value).not.toContain("may be incomplete")
          expect(text.value).toContain("full original output")
          expect(output?.capture).toMatchObject({ complete: true })
        }),
      ),
    )
  )

  it.live("reports both causes separately when a byte limit and stream EOF coexist", () =>
    captureCauseCase({
      stdoutTruncatedReason: "byte-limit",
      stderrTruncatedReason: undefined,
      stdoutEofTimeout: true,
      stderrEofTimeout: true,
    }).pipe(
      Effect.andThen(({ text, output }) =>
        Effect.sync(() => {
          expect(text.value).toContain("capture truncated at the in-memory safety limit")
          expect(text.value).toContain("capture may be incomplete")
          expect(text.value).toContain("partial original output")
          expect(output?.capture).toMatchObject({ complete: false })
        }),
      ),
    )
  )

  it.live("stores the full spool capture through the real ContentStore", () =>
    captureCauseCase(
      {
        stdoutTruncatedReason: "byte-limit",
        stderrTruncatedReason: "byte-limit",
        stdoutEofTimeout: undefined,
        stderrEofTimeout: undefined,
      },
      ContentStore.defaultLayer,
    ).pipe(
      Effect.andThen(({ text, output }) =>
        Effect.sync(() => {
          const uri = output?.capture?.uri
          expect(typeof uri).toBe("string")
          expect(uri?.length).toBeGreaterThan(0)
          expect(text.value).toContain(`[full original output stored at ${uri}`)
          expect(output?.capture).toMatchObject({ complete: true })
        }),
      ),
    )
  )

  it.live("keeps a stderr-only truncation off the stdout flag", () =>
    captureCauseCase({
      stdoutTruncated: false,
      stdoutTruncatedReason: undefined,
      stdoutEofTimeout: undefined,
      stderrTruncated: true,
      stderrTruncatedReason: "byte-limit",
      stderrEofTimeout: undefined,
    }).pipe(
      Effect.andThen(({ text, output }) =>
        Effect.sync(() => {
          expect(text.value).toContain("stderr capture truncated at the in-memory safety limit")
          expect(text.value).not.toContain("stdout capture truncated")
          expect(output?.stdoutTruncated).toBeUndefined()
          expect(output?.stderrTruncated).toBe(true)
          expect(output?.capture).toMatchObject({ complete: true })
        }),
      ),
    )
  )

  const permissionDecisionCase = (error: PermissionV2.Error, command: string) =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        afterPermission = () => Effect.fail(error)
        return withTool(
          tmp.path,
          (registry) =>
            settleTool(registry, call({ command })).pipe(
              Effect.catchCause((cause) => Effect.succeed(dieDefects(cause))),
            ),
        ).pipe(
          Effect.andThen((defects) =>
            Effect.sync(() => {
              expect(defects).toEqual([error])
              expect(runs).toEqual([])
              if (error instanceof PermissionV2.CorrectedError) {
                // The model-visible no-retry feedback survives the transport.
                expect(error.feedback).toContain("Do not retry")
              }
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )

  it.live("keeps a safety-corrected decision typed and spawns nothing", () =>
    permissionDecisionCase(
      new PermissionV2.CorrectedError({
        feedback:
          "Do not retry or evade this command: the safety review rejected this start-variant because it relaunches the app outside the approved flow.",
      }),
      "cmd /c start opencode.exe",
    ),
  )

  it.live("keeps a denied decision typed and spawns nothing", () =>
    permissionDecisionCase(new PermissionV2.DeniedError({ rules: [] }), "cmd /c start opencode.exe"),
  )

  it.live("keeps a rejected decision typed and spawns nothing", () =>
    permissionDecisionCase(new PermissionV2.RejectedError(), "cmd /c start opencode.exe"),
  )

  it.live("keeps a declined decision typed and spawns nothing", () =>
    permissionDecisionCase(new PermissionV2.DeclinedError(), "cmd /c start opencode.exe"),
  )
})

test("keeps locked deferred parity TODOs visible", async () => {
  const source = await fs.readFile(new URL("../src/tool/bash.ts", import.meta.url), "utf8")
  for (const todo of [
    "Port tree-sitter bash / PowerShell parser-based approval reduction.",
    "Port BashArity reusable command-prefix approvals.",
    "Replace token-based command-argument external-directory advisories with parser-based detection.",
    "Restore cmd-specific invocation/path handling on Windows.",
    "Add plugin shell.env environment augmentation once V2 plugin hooks exist.",
    "Add durable/live progress metadata streaming for long-running commands once V2 tool invocation progress context is wired.",
    "Persist background job status and define restart recovery before exposing remote observation.",
    "Revisit process-group cleanup and platform coverage with shell-specific tests if current AppProcess semantics do not fully cover it.",
    "Revisit binary output handling if stdout/stderr decoding is text-only.",
    "Stream full shell output into managed storage while retaining only a bounded in-memory preview.",
  ]) {
    expect(source).toContain(`TODO: ${todo}`)
  }
})
