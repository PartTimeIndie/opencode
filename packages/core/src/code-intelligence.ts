export * as CodeIntelligence from "./code-intelligence"

import { Context, Effect, Layer } from "effect"
import { FSUtil } from "./fs-util"
import { LayerNode } from "./effect/layer-node"

export type Position = { readonly line: number; readonly character: number }
export type Range = { readonly start: Position; readonly end: Position }
export type Symbol = {
  readonly name: string
  readonly detail?: string
  readonly kind: number
  readonly file: string
  readonly range: Range
  readonly selectionRange?: Range
  readonly depth: number
  readonly container?: string
}
export type Location = { readonly file: string; readonly range: Range }
export type Diagnostic = {
  readonly file: string
  readonly range: Range
  readonly message: string
  readonly severity?: number
  readonly source?: string
  readonly code?: string
}
export type Call = {
  readonly name: string
  readonly kind: number
  readonly file: string
  readonly range: Range
  readonly fromRanges: readonly Range[]
}

export interface Provider {
  readonly status: () => Effect.Effect<ReadonlyArray<{ readonly id: string; readonly status: "connected" | "error" }>>
  readonly workspaceSymbols: (query: string) => Effect.Effect<readonly Symbol[]>
  readonly documentSymbols: (file: string) => Effect.Effect<readonly Symbol[]>
  readonly hover: (file: string, position: Position) => Effect.Effect<readonly string[]>
  readonly definition: (file: string, position: Position) => Effect.Effect<readonly Location[]>
  readonly references: (file: string, position: Position) => Effect.Effect<readonly Location[]>
  readonly implementation: (file: string, position: Position) => Effect.Effect<readonly Location[]>
  readonly diagnostics: (file?: string) => Effect.Effect<readonly Diagnostic[]>
  readonly incomingCalls: (file: string, position: Position) => Effect.Effect<readonly Call[]>
  readonly outgoingCalls: (file: string, position: Position) => Effect.Effect<readonly Call[]>
}

export interface Interface {
  readonly register: (directory: string, provider: Provider) => Effect.Effect<void>
  readonly get: (directory: string) => Effect.Effect<Provider | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CodeIntelligence") {}

const providers = new Map<string, Provider>()

export const layer = Layer.succeed(
  Service,
  Service.of({
    register: (directory, provider) =>
      Effect.sync(() => {
        providers.set(FSUtil.normalizePath(directory), provider)
      }),
    get: (directory) => Effect.sync(() => providers.get(FSUtil.normalizePath(directory))),
  }),
)

export const defaultLayer = layer
export const node = LayerNode.make(layer, [])
