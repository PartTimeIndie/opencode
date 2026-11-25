import fs from "fs/promises"
import { realpathSync } from "node:fs"
import path from "path"
import { describe, expect, spyOn, test } from "bun:test"
import { Cause, Deferred, Effect, Fiber, Layer } from "effect"
import { ToolFailure } from "@opencode-ai/llm"
import { adjust } from "effect/testing/TestClock"
import { ChildProcess } from "effect/unstable/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@opencode-ai/core/config"
import { ConfigExperimental } from "@opencode-ai/core/config/experimental"
import { Database } from "@opencode-ai/core/database/database"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AppProcess } from "@opencode-ai/core/process"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionOrchestratorTable } from "@opencode-ai/core/session/legacy-delegation/sql"
import { Shell } from "@opencode-ai/core/shell"
import { ShellEnvironment } from "@opencode-ai/core/shell-environment"
import { BashTool } from "@opencode-ai/core/tool/bash"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tool } from "@opencode-ai/core/tool/tool"
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
      return Effect.succeed(
        new FileAttachment({ uri: "attachment://shell-capture", mime: input.mime, name: input.name }),
      )
    },
    normalizePrompt: (input) =>
      Effect.succeed(
        new Prompt({
          ...input.prompt,
          files: input.prompt.files?.map(
            (file, index) =>
              new FileAttachment({ ...file, uri: `${ContentStore.URI_PREFIX}${input.messageID}_${index}` }),
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
let processWait: Effect.Effect<void> = Effect.void
let afterPermission: (
  input: PermissionV2.AssertInput,
) => Effect.Effect<void, PermissionV2.Error | SessionV2.NotFoundError> = () => Effect.void

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
        return processWait.pipe(Effect.andThen(runFailure ? Effect.fail(runFailure) : Effect.succeed(result)))
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
  processWait = Effect.void
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
  const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission), Layer.provide(config))
  const database = Database.layerFromPath(":memory:")
  const bash = BashTool.layer.pipe(
    Layer.provide(activeLocation),
    Layer.provide(registry),
    Layer.provide(permission),
    Layer.provide(mutation),
    Layer.provide(filesystem),
    Layer.provide(processLayer),
    Layer.provide(config),
    Layer.provide(database),
  )
  const withStore = (contentStoreLayer ? bash.pipe(Layer.provideMerge(contentStoreLayer)) : bash).pipe(
    Layer.provideMerge(ShellEnvironment.layer),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(Effect.provide(Layer.mergeAll(registry, withStore, database)))
}

const call = (input: typeof BashTool.Input.Type, id = "call-bash") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "bash", input },
})

const it = testEffect(Layer.empty)

const dieDefects = (cause: Cause.Cause<unknown>) =>
  cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect)

test("inspects UNC command arguments without filesystem canonicalization", () => {
  if (process.platform !== "win32") return
  const resolve = spyOn(FSUtil, "resolve").mockImplementation(() => {
    throw new Error("command-argument scan must not access the filesystem")
  })
  try {
    const directory = String.raw`\\BeeStation\home\PU_Recordings`
    expect(
      BashTool.externalCommandDirectories(`Test-Path -LiteralPath '${directory}'`, "C:\\GitRepros\\opencode"),
    ).toEqual([path.dirname(directory)])
  } finally {
    resolve.mockRestore()
  }
})

describe("BashTool", () => {
  it.live("delivers invocation-local plugin environment to real concurrent shells without changing process.env", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const before = process.env.OPENCODE_TEST_BINDING
        return withTool(tmp.path, (registry) => Effect.gen(function* () {
          const environment = yield* ShellEnvironment.Service
          const observed: ShellEnvironment.Request[] = []
          yield* environment.register(tmp.path, (input) => Effect.sync(() => {
            observed.push(input)
            return { OPENCODE_TEST_BINDING: `${input.sessionID}:${input.callID}` }
          }))
          const command = process.platform === "win32" ? "Write-Output $env:OPENCODE_TEST_BINDING" : 'printf "%s" "$OPENCODE_TEST_BINDING"'
          const outputs = yield* Effect.all(["ses_environment_parent", "ses_environment_child"].map((id) =>
            settleTool(registry, { ...call({ command }, id), sessionID: SessionV2.ID.make(id) }),
          ), { concurrency: 2 })
          for (const [index, id] of ["ses_environment_parent", "ses_environment_child"].entries()) {
            expect(outputs[index]?.output?.structured).toMatchObject({ exitCode: 0, output: expect.stringContaining(`${id}:${id}`) })
          }
          expect(observed.map((input) => String(input.sessionID)).sort()).toEqual(["ses_environment_child", "ses_environment_parent"])
          expect(observed.every((input) => input.directory === tmp.path && input.cwd === realpathSync(tmp.path))).toBe(true)
          expect(process.env.OPENCODE_TEST_BINDING).toBe(before)
        }), AppProcess.defaultLayer)
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("lets a differently-cased hook path value replace the whole path variable in a real shell", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        if (process.platform !== "win32") return Effect.succeed(undefined as never)
        reset()
        return withTool(tmp.path, (registry) => Effect.gen(function* () {
          const environment = yield* ShellEnvironment.Service
          const marker = "C:\\__opencode_hook_path_case_marker__"
          yield* environment.register(tmp.path, () => Effect.succeed({ path: marker }))
          const output = yield* settleTool(registry, call({ command: "Write-Output $env:Path" }))
          expect(output.output?.structured).toMatchObject({ exitCode: 0 })
          // Exactly the hook value survives: neither the inherited PATH nor the
          // executable-path fallback may leak into the real shell.
          const structured = output.output?.structured as { output?: string } | undefined
          expect(structured?.output?.trim()).toBe(marker)
        }), AppProcess.defaultLayer)
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("replaces an inherited variable through a differently-cased hook value in parallel real shells", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        if (process.platform !== "win32") return Effect.succeed(undefined as never)
        reset()
        const inheritedName = "OPENCODE_CASE_INHERITED"
        const before = process.env[inheritedName]
        process.env[inheritedName] = "inherited-value"
        return withTool(tmp.path, (registry) => Effect.gen(function* () {
          const environment = yield* ShellEnvironment.Service
          yield* environment.register(tmp.path, () => Effect.succeed({ opencode_case_inherited: "hook-value" }))
          const command = "Write-Output $env:OPENCODE_CASE_INHERITED"
          const outputs = yield* Effect.all(["ses_case_parent", "ses_case_child"].map((id) =>
            settleTool(registry, { ...call({ command }, id), sessionID: SessionV2.ID.make(id) }),
          ), { concurrency: 2 })
          for (const output of outputs) {
            expect(output.output?.structured).toMatchObject({ exitCode: 0 })
            const structured = output.output?.structured as { output?: string } | undefined
            expect(structured?.output?.trim()).toBe("hook-value")
          }
          // The tool must never touch the parent environment: the canonical key
          // keeps its value and no differently-cased sibling key appears.
          expect(process.env[inheritedName]).toBe("inherited-value")
          expect(Object.keys(process.env).filter((key) => key.toLowerCase() === inheritedName.toLowerCase())).toEqual([inheritedName])
        }), AppProcess.defaultLayer).pipe(
          Effect.ensuring(Effect.sync(() => {
            if (before === undefined) delete process.env[inheritedName]
            else process.env[inheritedName] = before
          })),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("does not invoke environment hooks after denied permission and fails closed on a hook failure", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) => Effect.gen(function* () {
          let calls = 0
          yield* (yield* ShellEnvironment.Service).register(tmp.path, () => {
            calls++
            return Effect.fail(new Error("shell.env fixture failed"))
          })
          denyAction = "bash"
          yield* settleTool(registry, call({ command: "must not run" })).pipe(Effect.exit)
          expect(calls).toBe(0)
          expect(runs).toHaveLength(0)
          denyAction = undefined
          const output = yield* settleTool(registry, call({ command: "must not run" }, "hook-failure"))
          expect(output.result).toMatchObject({ type: "error" })
          expect(calls).toBe(1)
          expect(runs).toHaveLength(0)
        }))
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("selects the host location's hook even when an approved workdir is external", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) => Effect.gen(function* () {
          const environment = yield* ShellEnvironment.Service
          const external = path.dirname(tmp.path)
          yield* environment.register(tmp.path, (input) => Effect.succeed({ HOST: input.directory, CWD: input.cwd }))
          yield* environment.register(external, () => Effect.succeed({ WRONG_PROJECT: "true" }))
          yield* settleTool(registry, call({ command: "probe", workdir: external }))
          expect(runs[0]?.env).toMatchObject({ HOST: tmp.path, CWD: realpathSync(external) })
          expect(runs[0]?.env?.WRONG_PROJECT).toBeUndefined()
          if (process.platform === "win32") {
            // Windows builds the whole effective child environment inside the tool
            // (case-insensitive merge), so the spawner must not re-extend it.
            expect(runs[0]?.extendEnv).toBe(false)
            expect(runs[0]?.env?.Path).toBeString()
          } else {
            expect(runs[0]?.extendEnv).toBe(true)
          }
        }))
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  for (const interrupt of [false, true]) {
    it.effect(`flushes an interrupted in-flight publication on ${interrupt ? "cancellation" : "completion"}`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            reset()
            const started = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const publishing = yield* Deferred.make<void>()
            const holdPublication = yield* Deferred.make<void>()
            processWait = Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
            spoolFeed = [Buffer.from("retained partial output")]
            let intercepted = false
            const delivered: unknown[] = []
            const fiber = yield* withTool(tmp.path, (registry) =>
              settleTool(registry, {
                ...call({ command: "probe" }),
                progress: (snapshot) =>
                  Effect.gen(function* () {
                    if (snapshot.structured.output && !intercepted) {
                      intercepted = true
                      yield* Deferred.succeed(publishing, undefined)
                      yield* Deferred.await(holdPublication)
                    }
                    delivered.push(snapshot.structured.output)
                  }),
              }),
            ).pipe(Effect.forkChild)
            yield* Deferred.await(started)
            yield* adjust("250 millis")
            yield* Deferred.await(publishing)
            if (interrupt) yield* Fiber.interrupt(fiber)
            else {
              yield* Deferred.succeed(release, undefined)
              yield* Fiber.join(fiber)
            }
            expect(delivered.at(-1)).toContain("retained partial output")
            expect(runs).toHaveLength(1)
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  }

  it.live("retains the same timeout output and capture callback with live publication on or off", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const outputs: unknown[] = []
          for (const enabled of [true, false]) {
            reset()
            configEntries = [
              new Config.Document({
                type: "document",
                info: new Config.Info({
                  experimental: new ConfigExperimental.Experimental({ tool_live_progress: enabled }),
                }),
              }),
            ]
            spoolFeed = [Buffer.from("stdout and stderr before timeout")]
            runFailure = new AppProcess.AppProcessError({ command: "probe", cause: new Error("Timed out") })
            let emitted = 0
            const settled = yield* withTool(tmp.path, (registry) =>
              settleTool(registry, {
                ...call({ command: "probe", timeout: 10 }),
                progress: () =>
                  Effect.sync(() => {
                    emitted++
                  }),
              }),
            )
            outputs.push(settled.output?.structured)
            // Registry callbacks capture receipts even when UI emission is off.
            // The publisher owns emission; session-runner-tool-events covers it.
            expect(emitted).toBeGreaterThan(0)
          }
          expect(outputs[0]).toEqual(outputs[1])
          expect(outputs[0]).toMatchObject({
            output: expect.stringContaining("stdout and stderr before timeout"),
            timedOut: true,
          })
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
  it.effect("batches changed output at 250 ms, skips unchanged snapshots and flushes the final tail", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          reset()
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          processWait = Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
          spoolFeed = [Buffer.from("first")]
          const outputs: unknown[] = []
          const fiber = yield* withTool(tmp.path, (registry) =>
            settleTool(registry, {
              ...call({ command: "probe" }),
              progress: (snapshot) =>
                Effect.sync(() => {
                  outputs.push(snapshot.structured.output)
                }),
            }),
          ).pipe(Effect.forkChild)
          yield* Deferred.await(started)
          expect(outputs).toEqual([""])
          yield* adjust("249 millis")
          expect(outputs).toEqual([""])
          yield* adjust("1 millis")
          expect(outputs).toEqual(["", "first\n[stderr]\nfirst"])
          yield* adjust("1 second")
          expect(outputs).toHaveLength(2)
          runs[0]?.options?.spoolStdout?.(Buffer.from("last"))
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(fiber)
          expect(outputs).toHaveLength(3)
          expect(outputs.at(-1)).toContain("last")
          expect(runs).toHaveLength(1)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
  for (const enabled of [true, false]) {
    it.live(`bounds the progress callback lifetime with live progress ${enabled}`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          configEntries = [
            new Config.Document({
              type: "document",
              info: new Config.Info({
                experimental: new ConfigExperimental.Experimental({ tool_live_progress: enabled }),
              }),
            }),
          ]
          return withTool(tmp.path, (registry) =>
            Effect.gen(function* () {
              let escaped: Tool.Context["progress"]
              let count = 0
              yield* registry.register({
                probe: Tool.make({
                  description: "progress lifetime probe",
                  input: BashTool.Input,
                  output: BashTool.Output,
                  execute: (input, context) =>
                    Effect.gen(function* () {
                      escaped = context.progress
                      yield* context.progress?.({ structured: { output: "active" }, content: [] }) ?? Effect.void
                      return { command: input.command, cwd: tmp.path, output: "done", truncated: false }
                    }),
                }),
              })
              yield* settleTool(registry, {
                ...call({ command: "probe" }),
                call: { type: "tool-call", id: "probe", name: "probe", input: { command: "probe" } },
                progress: () =>
                  Effect.sync(() => {
                    count++
                  }),
              })
              yield* escaped?.({ structured: { output: "after settlement" }, content: [] }) ?? Effect.void
              expect(count).toBe(1)
              expect(escaped).toBeFunction()
            }),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  }
  it.live("publishes real stdout before process completion without re-executing the command", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const snapshots: Array<{ output?: unknown }> = []
        return withTool(
          tmp.path,
          (registry) =>
            Effect.gen(function* () {
              const input = call({
                command:
                  process.platform === "win32"
                    ? "Write-Output 'live-first'; Start-Sleep -Milliseconds 900; Write-Output 'live-last'"
                    : "printf 'live-first\\n'; sleep 0.9; printf 'live-last\\n'",
              })
              const output = yield* settleTool(registry, {
                ...input,
                progress: (snapshot) =>
                  Effect.sync(() => {
                    snapshots.push(snapshot.structured)
                  }),
              })
              expect(
                snapshots.some(
                  (snapshot) =>
                    String(snapshot.output).includes("live-first") && !String(snapshot.output).includes("live-last"),
                ),
              ).toBe(true)
              expect(snapshots.at(-1)?.output).toContain("live-last")
              expect(output.output?.structured).toMatchObject({ exitCode: 0 })
            }),
          AppProcess.defaultLayer,
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
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
              expect(runs[0]?.extendEnv).toBe(false)
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

  it.live("approves an external relative workdir before bash execution", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        return withTool(active.path, (registry) =>
          executeTool(registry, call({ command: "pwd", workdir: path.relative(active.path, outside.path) })),
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
          return withTool(active.path, (registry) =>
            settleTool(registry, call({ command: `cat ${slashTarget}` })),
          ).pipe(
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

  test("retains workspace-guard refusals instead of disguising them as launch errors", () => {
    const blocked = new ToolFailure({ message: "Target is outside this managed task's reserved resources" })
    expect(BashTool.executionFailure("Get-Location", blocked)).toBe(blocked)
    expect(BashTool.executionFailure("Get-Location", blocked).message).not.toContain("Unable to execute")
  })

  it.live("reports a real reservation guard refusal through the tool without spawning", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) => Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* db.insert(ProjectTable).values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make(tmp.path), sandboxes: [] }).run().pipe(Effect.orDie)
          yield* db.insert(SessionTable).values({
            id: sessionID, project_id: ProjectV2.ID.global, directory: tmp.path,
            slug: "guard", title: "guard", version: "test",
          }).run().pipe(Effect.orDie)
          yield* db.insert(SessionOrchestratorTable).values({
            main_session_id: sessionID, checkout_id: "unverified", workspace_mode: "shared",
          }).run().pipe(Effect.orDie)
          const settled = yield* settleTool(registry, call({ command: "Get-Location" }))
          expect(settled.result).toEqual({
            type: "error", value: "Historical delegation protection could not verify the required evidence",
          })
          expect(runs).toEqual([])
          expect(assertions).toEqual([])
        }))
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

  const captureCauseCase = (
    patch: Partial<AppProcess.RunResult>,
    storeLayer: Layer.Layer<ContentStore.Service> = contentStore,
  ) =>
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
              output: settled.output?.structured as typeof BashTool.Output.Type | undefined,
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
    ),
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
    ),
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
    ),
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
    ),
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
    ),
  )

  const permissionDecisionCase = (error: PermissionV2.Error, command: string) =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        afterPermission = () => Effect.fail(error)
        return withTool(tmp.path, (registry) =>
          settleTool(registry, call({ command })).pipe(Effect.catchCause((cause) => Effect.succeed(dieDefects(cause)))),
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
    "Persist background job status and define restart recovery before exposing remote observation.",
    "Revisit process-group cleanup and platform coverage with shell-specific tests if current AppProcess semantics do not fully cover it.",
    "Revisit binary output handling if stdout/stderr decoding is text-only.",
    "Stream full shell output into managed storage while retaining only a bounded in-memory preview.",
  ]) {
    expect(source).toContain(`TODO: ${todo}`)
  }
})
