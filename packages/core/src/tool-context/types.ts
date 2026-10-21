export * as ToolContextTypes from "./types"

export type Processor = "logs" | "search" | "diff" | "json"

export type Hint = "log" | "search" | "diff" | "json" | "text"

export type Omission = {
  readonly kind: string
  readonly count: number
  readonly ranges: ReadonlyArray<string>
}

export type Compressed = {
  readonly processor: Processor
  readonly text: string
  readonly omissions: ReadonlyArray<Omission>
}
