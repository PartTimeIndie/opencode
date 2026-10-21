import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CodeIntelligence } from "@opencode-ai/core/code-intelligence"
import { Config } from "@opencode-ai/core/config"
import { ConfigCapabilities } from "@opencode-ai/core/config/capabilities"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { LSPTool } from "@opencode-ai/core/tool/lsp"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_lsp_tool_test")
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

const provider: CodeIntelligence.Provider = {
  status: () => Effect.succeed([{ id: "typescript", status: "connected" }]),
  workspaceSymbols: () =>
    Effect.succeed(
      ["Alpha", "Beta", "Gamma"].map((name, index) => ({
        name,
        kind: 12,
        file: `/project/${name}.ts`,
        range: { start: { line: index, character: 0 }, end: { line: index, character: 4 } },
        depth: 0,
      })),
    ),
  documentSymbols: (file) =>
    Effect.succeed([
      {
        name: "Parent",
        kind: 5,
        file,
        range: { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } },
        depth: 0,
      },
      {
        name: "child",
        kind: 6,
        file,
        range: { start: { line: 1, character: 2 }, end: { line: 3, character: 3 } },
        depth: 1,
        container: "Parent",
      },
    ]),
  hover: () => Effect.succeed(["hover"]),
  definition: () => Effect.succeed([]),
  references: () => Effect.succeed([]),
  implementation: () => Effect.succeed([]),
  diagnostics: () => Effect.succeed([]),
  incomingCalls: () => Effect.succeed([]),
  outgoingCalls: () => Effect.succeed([]),
}

const it = testEffect(Layer.empty)

describe("LSPTool", () => {
  it.live("registers bounded LSP queries and LSP-first structural outlines when enabled", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        const activeLocation = Layer.succeed(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
        )
        const config = Layer.succeed(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  info: new Config.Info({
                    capabilities: new ConfigCapabilities.Info({ lsp_tools: true, structural_outline: true }),
                  }),
                }),
              ]),
          }),
        )
        const intelligence = Layer.succeed(
          CodeIntelligence.Service,
          CodeIntelligence.Service.of({ register: () => Effect.void, get: () => Effect.succeed(provider) }),
        )
        const mutation = LocationMutation.layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(activeLocation))
        const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
        const tools = LSPTool.layer.pipe(
          Layer.provide(registry),
          Layer.provide(config),
          Layer.provide(intelligence),
          Layer.provide(activeLocation),
          Layer.provide(mutation),
          Layer.provide(permission),
        )
        return Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(path.join(tmp.path, "source.ts"), "class Parent {}"))
          const service = yield* ToolRegistry.Service
          expect((yield* toolDefinitions(service)).map((tool) => tool.name).toSorted()).toEqual(["lsp", "outline"])
          expect(
            yield* executeTool(service, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-lsp-symbols",
                name: "lsp",
                input: { operation: "symbols", query: "a", limit: 2 },
              },
            }),
          ).toMatchObject({ type: "text", value: expect.stringContaining('"truncated":true') })
          expect(
            yield* executeTool(service, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-outline",
                name: "outline",
                input: { file: "source.ts" },
              },
            }),
          ).toMatchObject({ type: "text", value: expect.stringContaining('"container":"Parent"') })
        }).pipe(Effect.provide(Layer.mergeAll(activeLocation, config, intelligence, mutation, registry, tools)))
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
