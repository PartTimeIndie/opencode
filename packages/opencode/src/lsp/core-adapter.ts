import { CodeIntelligence } from "@opencode-ai/core/code-intelligence"
import { Effect } from "effect"
import { fileURLToPath, pathToFileURL } from "url"
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  Hover,
  Location,
  LocationLink,
  MarkedString,
} from "vscode-languageserver-types"
import { LSP } from "./lsp"

type DocumentNode = {
  readonly name: string
  readonly detail?: string
  readonly kind: number
  readonly range: CodeIntelligence.Range
  readonly selectionRange?: CodeIntelligence.Range
  readonly children?: readonly DocumentNode[]
  readonly location?: { readonly uri: string; readonly range: CodeIntelligence.Range }
  readonly containerName?: string
}

export function makeProvider(lsp: LSP.Interface): CodeIntelligence.Provider {
  return {
    status: () => lsp.status().pipe(Effect.map((items) => items.map((item) => ({ id: item.id, status: item.status })))),
    workspaceSymbols: (query) =>
      lsp.workspaceSymbol(query).pipe(
        Effect.map((items) =>
          items.flatMap((item) => {
            const file = filePath(item.location.uri)
            return file
              ? [{ name: item.name, kind: item.kind, file, range: item.location.range, depth: 0 }]
              : []
          }),
        ),
      ),
    documentSymbols: (file) =>
      lsp.documentSymbol(pathToFileURL(file).href).pipe(
        Effect.map((items) => items.flatMap((item) => flattenSymbol(item as DocumentNode, file))),
      ),
    hover: (file, position) =>
      lsp.hover({ file, ...position }).pipe(
        Effect.map((items) => items.flatMap((item) => (item ? hoverText(item) : []))),
      ),
    definition: (file, position) =>
      lsp.definition({ file, ...position }).pipe(Effect.map((items) => items.flatMap(locationResult))),
    references: (file, position) =>
      lsp.references({ file, ...position }).pipe(Effect.map((items) => items.flatMap(locationResult))),
    implementation: (file, position) =>
      lsp.implementation({ file, ...position }).pipe(Effect.map((items) => items.flatMap(locationResult))),
    diagnostics: (file) =>
      lsp.diagnostics().pipe(
        Effect.map((byFile) =>
          Object.entries(byFile).flatMap(([target, diagnostics]) => {
            if (file && target !== file) return []
            return diagnostics.map((item) => ({
              file: target,
              range: item.range,
              message: item.message,
              ...(item.severity === undefined ? {} : { severity: item.severity }),
              ...(item.source === undefined ? {} : { source: item.source }),
              ...(item.code === undefined ? {} : { code: String(item.code) }),
            }))
          }),
        ),
      ),
    incomingCalls: (file, position) =>
      lsp.incomingCalls({ file, ...position }).pipe(
        Effect.map((items) => items.flatMap((item) => incomingCall(item))),
      ),
    outgoingCalls: (file, position) =>
      lsp.outgoingCalls({ file, ...position }).pipe(
        Effect.map((items) => items.flatMap((item) => outgoingCall(item))),
      ),
  }
}

function flattenSymbol(item: DocumentNode, fallbackFile: string, depth = 0, container?: string): CodeIntelligence.Symbol[] {
  const file = item.location ? filePath(item.location.uri) : fallbackFile
  if (!file) return []
  const current = {
    name: item.name,
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    kind: item.kind,
    file,
    range: item.location?.range ?? item.range,
    ...(item.selectionRange === undefined ? {} : { selectionRange: item.selectionRange }),
    depth,
    ...(container ?? item.containerName ? { container: container ?? item.containerName } : {}),
  }
  return [current, ...(item.children ?? []).flatMap((child) => flattenSymbol(child, file, depth + 1, item.name))]
}

function locationResult(item: Location | LocationLink): CodeIntelligence.Location[] {
  const uri = "targetUri" in item ? item.targetUri : item.uri
  const file = filePath(uri)
  if (!file) return []
  return [{ file, range: "targetSelectionRange" in item ? item.targetSelectionRange : item.range }]
}

function hoverText(hover: Hover) {
  const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents]
  return contents.flatMap(markedText)
}

function markedText(value: MarkedString | { readonly kind: string; readonly value: string }) {
  if (typeof value === "string") return value ? [value] : []
  return value.value ? [value.value] : []
}

function incomingCall(item: CallHierarchyIncomingCall) {
  return call(item.from, item.fromRanges)
}

function outgoingCall(item: CallHierarchyOutgoingCall) {
  return call(item.to, item.fromRanges)
}

function call(item: CallHierarchyItem, fromRanges: CodeIntelligence.Range[]): CodeIntelligence.Call[] {
  const file = filePath(item.uri)
  if (!file) return []
  return [{ name: item.name, kind: item.kind, file, range: item.selectionRange, fromRanges }]
}

function filePath(uri: string) {
  if (!uri.startsWith("file://")) return
  return fileURLToPath(uri)
}
