import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@opencode-ai/core/config"
import { ContentStore } from "@opencode-ai/core/content-store"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AppProcess } from "@opencode-ai/core/process"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { BashTool } from "@opencode-ai/core/tool/bash"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { toolIdentity, settleTool } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_bash_spool")

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    materializationRules: () => Effect.succeed([]),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))

// Mock process: emits oversized stdout through the spool sink while the in-memory
// capture keeps only the head. The command is never re-run.
const oversized = (total: number) => {
  const line = "x".repeat(120) + "\n"
  const chunks: Buffer[] = []
  let remaining = total
  while (remaining > 0) {
    const size = Math.min(64 * 1024, remaining)
    chunks.push(Buffer.from(line.repeat(Math.ceil(size / line.length)).slice(0, size)))
    remaining -= size
  }
  return chunks
}

const streamingProcess = (chunks: Buffer[], spoolTarget: "spoolStdout" | "spoolStderr") =>
  Layer.succeed(
    AppProcess.Service,
    AppProcess.Service.of({
      run: (command: ChildProcess.Command, options?: AppProcess.RunOptions) =>
        Effect.sync(() => {
          for (const chunk of chunks) options?.[spoolTarget]?.(chunk)
          return {
            command: "mock",
            exitCode: 0,
            stdout: spoolTarget === "spoolStdout" ? Buffer.from(chunks[0]!) : Buffer.alloc(0),
            stderr: spoolTarget === "spoolStderr" ? Buffer.from(chunks[0]!) : Buffer.alloc(0),
            stdoutTruncated: spoolTarget === "spoolStdout",
            stderrTruncated: spoolTarget === "spoolStderr",
          }
        }),
      runStream: (() => {
        throw new Error("unused")
      }) as never,
    } as unknown as AppProcess.Interface),
  )

const harness = <A, E, R>(
  processLayer: Layer.Layer<AppProcess.Service>,
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const database = Database.layerFromPath(path.join(tmp.path, "content.db")).pipe(Layer.fresh)
      const global = Global.layerWith({ data: tmp.path })
      const content = ContentStore.layer.pipe(
        Layer.provide(database),
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(global),
      )
      const filesystem = FSUtil.defaultLayer
      const activeLocation = Layer.succeed(
        Location.Service,
        Location.Service.of({
          directory: AbsolutePath.make(tmp.path),
          workspaceID: undefined,
          project: { id: "proj_bash_spool", directory: AbsolutePath.make(tmp.path) },
          vcs: undefined,
        } as never),
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
        Layer.provide(content),
      )
      const layers = Layer.mergeAll(database, content, registry, permission, activeLocation, config, filesystem, bash)
      return Effect.gen(function* () {
        return yield* body(yield* ToolRegistry.Service)
      }).pipe(Effect.provide(layers))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("bash spool capture", () => {
  it.live("spools oversized stdout once, stores the session-owned original and marks retrieval", () =>
    harness(streamingProcess(oversized(2 * 1024 * 1024), "spoolStdout"), (registry) =>
      Effect.gen(function* () {
        const settled = yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-spool-out", name: "bash", input: { command: "emit-noise" } },
        })
        const structured = settled.output?.structured as Record<string, any>
        expect(structured.capture).toBeDefined()
        expect(structured.capture.complete).toBe(true)
        expect(structured.capture.bytes).toBe(2 * 1024 * 1024)
        expect(structured.capture.stdoutBytes).toBe(2 * 1024 * 1024)
        expect(structured.capture.stderrBytes).toBe(0)
        expect(structured.capture.uri).toStartWith("attachment://")
        const result = settled.result
        expect(result.type === "text" && result.value).toContain("full original output stored at")
        expect(result.type === "text" && result.value).toContain(structured.capture.uri)
        const content = yield* ContentStore.Service
        const stored = yield* content.resolve({ uri: structured.capture.uri, sessionID })
        expect(stored).toBeDefined()
        const text = new TextDecoder().decode(stored!.bytes)
        expect(text.startsWith("$ opencode shell capture: emit-noise\n$ cwd:")).toBe(true)
        expect(text).toContain(`[stdout]\n${"x".repeat(120)}\n`)
        expect(text).toEndWith("[stderr]\n")
        // The stored original is the complete spool, not the truncated in-memory capture.
        expect(text.length).toBe(
          text.indexOf("\n[stdout]\n") + "\n[stdout]\n".length + 2 * 1024 * 1024 + "\n[stderr]\n".length,
        )
      }),
    ),
  )

  it.live("spools oversized stderr with the same contract", () =>
    harness(streamingProcess(oversized(1_500_000), "spoolStderr"), (registry) =>
      Effect.gen(function* () {
        const settled = yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-spool-err", name: "bash", input: { command: "emit-noise" } },
        })
        const structured = settled.output?.structured as Record<string, any>
        expect(structured.capture.complete).toBe(true)
        expect(structured.capture.stderrBytes).toBe(1_500_000)
        expect(structured.capture.stdoutBytes).toBe(0)
        expect(structured.capture.uri).toStartWith("attachment://")
        const content = yield* ContentStore.Service
        const stored = yield* content.resolve({ uri: structured.capture.uri, sessionID })
        expect(stored).toBeDefined()
        const text = new TextDecoder().decode(stored!.bytes)
        expect(text).toContain(`[stderr]\n${"x".repeat(120)}\n`)
        // The stored original is the complete spool, not the truncated in-memory capture.
        expect(text.length).toBe(
          text.indexOf("\n[stdout]\n") + "\n[stdout]\n".length + "\n[stderr]\n".length + 1_500_000,
        )
      }),
    ),
  )
})
