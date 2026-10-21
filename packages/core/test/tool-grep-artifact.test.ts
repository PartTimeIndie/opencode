import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Config } from "@opencode-ai/core/config"
import { ContentStore } from "@opencode-ai/core/content-store"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { GrepTool } from "@opencode-ai/core/tool/grep"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { executeTool, toolIdentity } from "./lib/tool"
import { it } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const sessionID = SessionV2.ID.make("ses_grep_artifact")
const otherSession = SessionV2.ID.make("ses_grep_artifact_other")

const permissionAssertions: PermissionV2.AssertInput[] = []
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => {
        permissionAssertions.push(input)
      }),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    materializationRules: () => Effect.succeed([]),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const location = Layer.succeed(
  Location.Service,
  Location.Service.of({
    directory: AbsolutePath.make(process.cwd()),
    workspaceID: undefined,
    project: { id: "proj_grep_artifact", directory: AbsolutePath.make(process.cwd()) },
    vcs: undefined,
  } as never),
)

const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))
const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))

const corpus = () => {
  const lines = ["$ bun run build"]
  for (let index = 0; index < 400; index++) lines.push(`verbose module compile step ${index} ok`)
  lines.push("FATAL-needle-12345 cannot continue: bundled asset missing")
  for (let index = 0; index < 400; index++) lines.push(`verbose emit chunk ${index} written`)
  lines.push("error: build failed with exit code 1")
  return `${lines.join("\n")}\n`
}

// Store a large tool output and return the compressed view's original attachment URI.
// The ref must be visible in the provider-facing text channel itself; the raw original stays behind the attachment.
const storeOriginal = (outputs: ToolOutputStore.Interface, toolCallID: string) =>
  Effect.gen(function* () {
    const text = corpus()
    const bound = yield* outputs.bound({
      sessionID,
      toolCallID,
      tool: "bash",
      output: { structured: { output: text }, content: [{ type: "text" as const, text }] },
    })
    const contextView = (bound.output.structured as Record<string, any>).$opencode?.contextView
    expect(contextView).toBeDefined()
    const uri = contextView.original.ref as string
    expect(uri).toStartWith("attachment://")
    expect(contextView.original.complete).toBe(true)
    const providerText = bound.output.content.map((item) => (item.type === "text" ? item.text : "")).join("\n")
    expect(providerText).toContain(`Full original: ${uri}`)
    // the ref a model parses from the text equals the structured session-owned ref
    expect(/attachment:\/\/att_[0-9a-f]+/.exec(providerText)?.[0]).toBe(uri)
    // omitted raw lines must not leak into the compressed provider view
    expect(providerText).not.toContain("verbose module compile step 200 ok")
    return uri
  })

const harness = <A, E, R>(body: (input: { outputs: ToolOutputStore.Interface }) => Effect.Effect<A, E, R>) =>
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
      const outputs = ToolOutputStore.layer.pipe(
        Layer.provide(content),
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(global),
      )
      const grep = GrepTool.layer.pipe(
        Layer.provide(registry),
        Layer.provide(permission),
        Layer.provide(location),
        Layer.provide(Ripgrep.defaultLayer),
        Layer.provide(config),
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(content),
      )
      const layers = Layer.mergeAll(
        database,
        content,
        outputs,
        registry,
        permission,
        location,
        config,
        Ripgrep.defaultLayer,
        FSUtil.defaultLayer,
        grep,
      )
      return Effect.gen(function* () {
        return yield* body({ outputs: yield* ToolOutputStore.Service })
      }).pipe(Effect.provide(layers))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("grep artifact retrieval", () => {
  it.effect("greps a session-owned stored tool output as exact raw retrieval evidence", () =>
    harness(({ outputs }) =>
      Effect.gen(function* () {
        permissionAssertions.length = 0
        const uri = yield* storeOriginal(outputs, "call-log-1")
        const registryService = yield* ToolRegistry.Service

        const result = yield* executeTool(registryService, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-grep-artifact", name: "grep", input: { pattern: "FATAL-needle-12345", path: uri } },
        })
        expect(result.type).toBe("text")
        const modelText = result.type === "text" ? result.value : ""
        expect(modelText).toContain("raw retrieval")
        expect(modelText).toContain(uri)
        expect(modelText).toContain("FATAL-needle-12345")
        expect(modelText).toContain("Found 1 matches")
        expect(modelText).toContain("Line ")

        // the permission system saw the artifact reference, not a filesystem path
        expect(permissionAssertions.some((assertion) => assertion.resources.includes(uri))).toBe(true)

        // exact raw evidence must not be compressed again by the finalizer
        const sha256 = "a".repeat(64)
        const page = new GrepTool.ArtifactSearchPage({
          type: "artifact-search-page",
          uri,
          sha256,
          bytes: 4096,
          matches: [{ line: 403, text: "FATAL-needle-12345 cannot continue" }],
          totalMatches: 1,
          truncated: false,
        })
        const bounded = yield* outputs.bound({
          sessionID,
          toolCallID: "call-grep-artifact",
          tool: "grep",
          output: {
            structured: page,
            content: [{ type: "text" as const, text: GrepTool.toModelOutput(page) }],
          },
        })
        expect((bounded.output.structured as Record<string, any>).$opencode?.contextView).toBeUndefined()
        expect((bounded.output.content[0] as any).text).toBe(GrepTool.toModelOutput(page))
      }),
    ),
  )

  it.effect("rejects artifact references owned by another session", () =>
    harness(({ outputs }) =>
      Effect.gen(function* () {
        const uri = yield* storeOriginal(outputs, "call-log-2")
        const registryService = yield* ToolRegistry.Service
        const result = yield* executeTool(registryService, {
          sessionID: otherSession,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-grep-artifact-other", name: "grep", input: { pattern: "FATAL", path: uri } },
        })
        const message = result.value as string
        expect(
          (result.type === "text" || result.type === "error") &&
            (message.includes("does not belong to this session") ||
              message.includes("Stored tool output retrieval is unavailable")),
        ).toBe(true)
      }),
    ),
  )

  it.effect("reports capped artifact searches as potentially non-exhaustive", () =>
    harness(({ outputs }) =>
      Effect.gen(function* () {
        const lines: string[] = []
        for (let index = 0; index < 600; index++) lines.push(`repeated-line needle-3-${index} padding padding padding`)
        const text = `${lines.join("\n")}\n`
        const bound = yield* outputs.bound({
          sessionID,
          toolCallID: "call-log-3",
          tool: "bash",
          output: { structured: { output: text }, content: [{ type: "text" as const, text }] },
        })
        const uri = (bound.output.structured as Record<string, any>).$opencode?.contextView?.original?.ref as string

        const registryService = yield* ToolRegistry.Service
        const result = yield* executeTool(registryService, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-grep-artifact-cap", name: "grep", input: { pattern: "needle-3-", path: uri, limit: 5 } },
        })
        expect(result.type === "text" && result.value).toContain("Found at least 5 matches")
        expect(result.type === "text" && result.value).toContain("raise the limit")
      }),
    ),
  )
})
