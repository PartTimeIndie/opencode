export * as ConfigCapabilities from "./capabilities"

import { Schema } from "effect"

export class Info extends Schema.Class<Info>("ConfigV2.Capabilities")({
  guarded_mutations: Schema.Boolean.pipe(Schema.optional),
  lsp_tools: Schema.Boolean.pipe(Schema.optional),
  structural_outline: Schema.Boolean.pipe(Schema.optional),
  reviewed_memory: Schema.Boolean.pipe(Schema.optional),
  dap: Schema.Boolean.pipe(Schema.optional),
  isolated_workspaces: Schema.Boolean.pipe(Schema.optional),
}) {}

export type Resolved = {
  readonly guarded_mutations: boolean
  readonly lsp_tools: boolean
  readonly structural_outline: boolean
  readonly reviewed_memory: boolean
  readonly dap: boolean
  readonly isolated_workspaces: boolean
}

type Entry = {
  readonly type: string
  readonly info?: {
    readonly capabilities?: Info
  }
}

const defaults: Resolved = {
  guarded_mutations: false,
  lsp_tools: false,
  structural_outline: false,
  reviewed_memory: false,
  dap: false,
  isolated_workspaces: false,
}

export function resolve(entries: readonly Entry[]): Resolved {
  return entries
    .filter((entry) => entry.type === "document")
    .reduce(
      (result, entry) => ({
        ...result,
        ...(entry.info?.capabilities ?? {}),
      }),
      defaults,
    )
}
