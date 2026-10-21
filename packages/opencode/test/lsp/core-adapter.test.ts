import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { pathToFileURL } from "url"
import { makeProvider } from "@/lsp/core-adapter"
import { LSP } from "@/lsp/lsp"

const file = path.resolve("src/example.ts")
const range = { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } }

describe("LSP core adapter", () => {
  test("flattens nested document symbols without creating another LSP owner", async () => {
    const lsp = LSP.Service.of({
      init: () => Effect.void,
      status: () => Effect.succeed([{ id: "typescript", name: "TypeScript", root: process.cwd(), status: "connected" }]),
      hasClients: () => Effect.succeed(true),
      touchFile: () => Effect.void,
      diagnostics: () => Effect.succeed({}),
      hover: () => Effect.succeed([]),
      definition: () => Effect.succeed([]),
      references: () => Effect.succeed([]),
      implementation: () => Effect.succeed([]),
      documentSymbol: () =>
        Effect.succeed([
          {
            name: "Parent",
            kind: 5,
            range,
            selectionRange: range,
            children: [{ name: "child", kind: 6, range, selectionRange: range }],
          },
        ] as unknown as LSP.DocumentSymbol[]),
      workspaceSymbol: () =>
        Effect.succeed([{ name: "workspace", kind: 12, location: { uri: pathToFileURL(file).href, range } }]),
      prepareCallHierarchy: () => Effect.succeed([]),
      incomingCalls: () => Effect.succeed([]),
      outgoingCalls: () => Effect.succeed([]),
    })
    const provider = makeProvider(lsp)

    expect(await Effect.runPromise(provider.documentSymbols(file))).toEqual([
      expect.objectContaining({ name: "Parent", file, depth: 0 }),
      expect.objectContaining({ name: "child", file, depth: 1, container: "Parent" }),
    ])
    expect(await Effect.runPromise(provider.workspaceSymbols("workspace"))).toEqual([
      expect.objectContaining({ name: "workspace", file, depth: 0 }),
    ])
  })
})
