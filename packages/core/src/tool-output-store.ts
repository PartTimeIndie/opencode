export * as ToolOutputStore from "./tool-output-store"

import path from "path"
import { open } from "node:fs/promises"
import { createHash } from "crypto"
import { LayerNode } from "./effect/layer-node"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { Config } from "./config"
import { ConfigOptimization } from "./config/optimization"
import { ToolContext, type ContextView } from "./tool-context"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { SessionSchema } from "./session/schema"
import { Identifier } from "./util/identifier"
import type { ToolOutput } from "@opencode-ai/llm"
import { ContentStore } from "./content-store"
import { SessionMessage } from "./session/message"
import { FileAttachment } from "./session/prompt"
import { isRecord } from "./util/record"
import { boundedPersistedContentPreview, MAX_PERSISTED_CONTENT_PREVIEW_BYTES } from "./content-preview"
import { StructuredContentReference } from "./structured-content-reference"
import { boundedToolDetails } from "./util/tool-details"

export const MAX_LINES = 2_000
export const MAX_BYTES = 50 * 1024
export const RETENTION = Duration.days(7)
export const MAX_PROVIDER_PREVIEW_BYTES = MAX_PERSISTED_CONTENT_PREVIEW_BYTES
export const MAX_PROVIDER_TOTAL_PREVIEW_BYTES = MAX_BYTES
export const MAX_STRUCTURED_BYTES = 256 * 1024
export const PROVIDER_BUDGET_OMISSION = "... tool output omitted: provider replay budget exhausted ..."

export const MANAGED_DIRECTORY = "tool-output"

export interface BoundInput {
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID?: SessionMessage.ID
  readonly toolCallID: string
  readonly tool?: string
  readonly output: ToolOutput
}

export interface BoundResult {
  readonly output: ToolOutput
  readonly outputPaths: ReadonlyArray<string>
}

export interface MaterializeInput {
  readonly sessionID: SessionSchema.ID
  readonly output: ToolOutput
  readonly budget?: MaterializeBudget
  readonly attachmentBudget?: MaterializeBudget
}

export interface MaterializeBudget {
  remaining: number
}

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("ToolOutputStore.StorageError", {
  operation: Schema.Literals(["encode", "write"]),
  cause: Schema.Defect,
}) {}

export type Error = StorageError | ContentStore.Error

export interface Interface {
  readonly limits: () => Effect.Effect<{ readonly maxLines: number; readonly maxBytes: number }>
  readonly bound: (input: BoundInput) => Effect.Effect<BoundResult, Error>
  readonly materialize: (input: MaterializeInput) => Effect.Effect<ToolOutput, Error>
  readonly cleanup: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ToolOutputStore") {}

const takePrefix = (input: string, maximumBytes: number) => {
  let bytes = 0
  let content = ""
  for (const char of input) {
    const size = Buffer.byteLength(char, "utf-8")
    if (bytes + size > maximumBytes) break
    content += char
    bytes += size
  }
  return content
}

const takeSuffix = (input: string, maximumBytes: number) => {
  let bytes = 0
  const content: string[] = []
  for (const char of Array.from(input).toReversed()) {
    const size = Buffer.byteLength(char, "utf-8")
    if (bytes + size > maximumBytes) break
    content.unshift(char)
    bytes += size
  }
  return content.join("")
}

const preview = (text: string, maxLines: number, maxBytes: number) => {
  const lines = text.split("\n")
  const headLines = Math.ceil(maxLines / 2)
  const tailLines = Math.floor(maxLines / 2)
  const sampled =
    lines.length <= maxLines
      ? text
      : [
          lines.slice(0, headLines).join("\n"),
          ...(tailLines > 0 ? [lines.slice(lines.length - tailLines).join("\n")] : []),
        ].join("\n")
  if (Buffer.byteLength(sampled, "utf-8") <= maxBytes) {
    return lines.length <= maxLines
      ? { head: sampled, tail: "" }
      : {
          head: lines.slice(0, headLines).join("\n"),
          tail: tailLines > 0 ? lines.slice(lines.length - tailLines).join("\n") : "",
        }
  }
  const headBytes = Math.ceil(maxBytes / 2)
  const tailBytes = Math.floor(maxBytes / 2)
  return { head: takePrefix(sampled, headBytes), tail: takeSuffix(sampled, tailBytes) }
}

const boundedPreview = (text: string, marker: string, maxLines: number, maxBytes: number) => {
  const markerOnly = takePrefix(marker, maxBytes).split("\n").slice(0, maxLines).join("\n")
  const markerBytes = Buffer.byteLength(marker, "utf-8")
  if (maxLines <= 4 || maxBytes <= markerBytes + 4) return markerOnly
  const bounded = preview(text, maxLines - 4, maxBytes - markerBytes - 4)
  return bounded.tail ? `${bounded.head}\n\n${marker}\n\n${bounded.tail}` : `${bounded.head}\n\n${marker}`
}

const lineCount = (text: string) => {
  let count = 1
  for (const char of text) if (char === "\n") count++
  return count
}

const stableFile = (input: BoundInput) =>
  `tool_${sanitize(input.sessionID)}_${sanitize(input.toolCallID)}`.slice(0, 180)

const sanitize = (value: string) => value.replace(/[^A-Za-z0-9_-]+/g, "_")

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const config = yield* Effect.serviceOption(Config.Service)
    const contentStore = Option.getOrUndefined(yield* Effect.serviceOption(ContentStore.Service))
    const viewCache = new ToolContext.ViewCache()
    const directory = path.join(global.data, MANAGED_DIRECTORY)
    const limits = Effect.fn("ToolOutputStore.limits")(function* () {
      const outputSettings = yield* settings()
      return { maxLines: outputSettings.maxLines, maxBytes: outputSettings.maxBytes }
    })
    const settings = Effect.fn("ToolOutputStore.settings")(function* () {
      if (Option.isNone(config))
        return { unlimited: false, maxLines: MAX_LINES, maxBytes: MAX_BYTES, stablePreview: true, compression: true }
      const entries = yield* config.value.entries().pipe(Effect.catch(() => Effect.succeed([] as Config.Entry[])))
      const configured = Object.assign(
        {},
        ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info.tool_output ?? {}] : [])),
      )
      const unlimited = configured.unlimited === true
      return {
        unlimited,
        maxLines: unlimited ? Number.POSITIVE_INFINITY : (configured.max_lines ?? MAX_LINES),
        maxBytes: unlimited ? Number.POSITIVE_INFINITY : (configured.max_bytes ?? MAX_BYTES),
        stablePreview: true,
        compression: ConfigOptimization.resolve(entries).features.tool_context_compression,
      }
    })

    const write = Effect.fn("ToolOutputStore.write")(function* (input: BoundInput, content: string, stable: boolean) {
      const file = path.join(directory, stable ? stableFile(input) : `tool_${Identifier.ascending()}`)
      yield* fs.ensureDir(directory).pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause })))
      yield* fs
        .writeFileString(file, content, stable ? undefined : { flag: "wx" })
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause })))
      return file
    })

    const bound = Effect.fn("ToolOutputStore.bound")(function* (input: BoundInput) {
      const outputLimits = yield* settings()
      const media = input.output.content.filter((item) => item.type === "file")
      const text = input.output.content.filter((item) => item.type === "text")
      const normalizedMedia = contentStore
        ? (yield* contentStore.normalizeFiles({
            sessionID: input.sessionID,
            messageID: input.assistantMessageID,
            key: `${input.assistantMessageID ?? input.toolCallID}:${input.toolCallID}:media`,
            files: media.map((item) => new FileAttachment({ uri: item.uri, mime: item.mime, name: item.name })),
          })).map((item) => ({ type: "file" as const, uri: item.uri, mime: item.mime, name: item.name }))
        : media
      const mediaReferences = media.flatMap((item, index) => {
        const normalized = normalizedMedia[index]
        if (!normalized || !normalized.uri.startsWith(ContentStore.URI_PREFIX)) return []
        const reference = StructuredContentReference.dataUriReference(item.uri, {
          uri: normalized.uri,
          mime: normalized.mime,
        })
        return reference ? [reference] : []
      })
      const contextual =
        input.output.content.length === 0
          ? yield* Effect.try({
              try: () => JSON.stringify(input.output.structured, null, 2) ?? String(input.output.structured),
              catch: (cause) => new StorageError({ operation: "encode", cause }),
            })
          : text.map((item) => item.text).join("")
      const contextualBytes = Buffer.byteLength(contextual, "utf8")
      const contextualLines = lineCount(contextual)
      // Native tool-context compression: persist the session-owned original first, then present
      // the deterministic model view. The tool's own structured value stays untouched.
      let contextualText = contextual
      let contextView: ContextView | undefined
      const structuredType =
        isRecord(input.output.structured) && typeof input.output.structured.type === "string"
          ? input.output.structured.type
          : undefined
      if (
        outputLimits.compression &&
        contentStore &&
        input.tool !== undefined &&
        !ToolContext.EXCLUDED_TOOLS.has(input.tool) &&
        (structuredType === undefined || !ToolContext.EXCLUDED_STRUCTURED_TYPES.has(structuredType)) &&
        text.length > 0
      ) {
        const sha256 = createHash("sha256").update(contextual).digest("hex")
        const cacheKey = ToolContext.cacheKey({
          scope: input.sessionID,
          sha256,
          processor: input.tool,
          options: outputLimits.compression ? "on" : "off",
        })
        const cached = viewCache.get(cacheKey, Date.now())
        const summary =
          cached !== undefined
            ? (JSON.parse(cached) as ToolContext.SummarizeResult)
            : ToolContext.summarize({ tool: input.tool, text: contextual })
        if (cached === undefined) viewCache.set(cacheKey, JSON.stringify(summary), Date.now())
        if (summary.view !== undefined) {
          const stored = yield* contentStore.storeTextAttachment({
            sessionID: input.sessionID,
            messageID: input.assistantMessageID,
            key: `${input.assistantMessageID ?? input.toolCallID}:${input.toolCallID}:tool-context-original`,
            text: contextual,
            mime: "text/plain",
            name: `${sanitize(input.toolCallID)}-original.txt`,
          })
          contextualText = `${summary.text}\nFull original: ${stored.uri}`
          contextView = {
            ...summary.view,
            estimates: {
              ...summary.view.estimates,
              viewBytes: Buffer.byteLength(contextualText, "utf8"),
            },
            original: {
              ref: stored.uri,
              sha256,
              bytes: contextualBytes,
              complete: true,
            },
          }
          // The provider only sees the text channel, so the compressed view itself names the
          // session-owned original ref without exposing the raw content.
        }
      }
      const effectiveBytes = Buffer.byteLength(contextualText, "utf8")
      const effectiveLines = lineCount(contextualText)
      const duplicateStructuredOutput =
        text.length > 0 &&
        !outputLimits.unlimited &&
        contextualBytes > MAX_PERSISTED_CONTENT_PREVIEW_BYTES &&
        isRecord(input.output.structured) &&
        input.output.structured.output === contextual
      const textNormalizedStructured = duplicateStructuredOutput
        ? { ...input.output.structured, output: boundedPersistedContentPreview(contextual) }
        : input.output.structured
      const sourceStructured = StructuredContentReference.replaceExact(textNormalizedStructured, mediaReferences)
      const encodedStructured = contentStore
        ? yield* Effect.try({
            try: () => JSON.stringify(sourceStructured) ?? String(sourceStructured),
            catch: (cause) => new StorageError({ operation: "encode", cause }),
          }).pipe(Effect.catch(() => Effect.succeed(undefined)))
        : undefined
      const encodedStructuredBytes =
        encodedStructured === undefined ? undefined : Buffer.byteLength(encodedStructured, "utf8")
      const structured =
        contentStore &&
        encodedStructured !== undefined &&
        encodedStructuredBytes !== undefined &&
        !outputLimits.unlimited &&
        encodedStructuredBytes > MAX_STRUCTURED_BYTES
          ? yield* Effect.gen(function* () {
              const stored = yield* contentStore.storeTextAttachment({
                sessionID: input.sessionID,
                messageID: input.assistantMessageID,
                key: `${input.assistantMessageID ?? input.toolCallID}:${input.toolCallID}:structured`,
                text: encodedStructured,
                mime: "application/json",
                name: `${sanitize(input.toolCallID)}-structured.json`,
              })
              const details = input.tool ? boundedToolDetails(input.tool, sourceStructured) : undefined
              return {
                ...(details ? { toolDetails: details } : {}),
                $opencode: {
                  type: "content-reference",
                  uri: stored.uri,
                  mime: "application/json",
                  sizeBytes: encodedStructuredBytes,
                  preview: boundedPreview(
                    encodedStructured,
                    `... full structured output stored at ${stored.uri} ...`,
                    MAX_LINES,
                    MAX_PERSISTED_CONTENT_PREVIEW_BYTES,
                  ),
                },
              }
            })
          : sourceStructured
      const finalStructured = contextView === undefined ? structured : withContextView(structured, contextView)
      const modelContent = contextView
        ? [{ type: "text" as const, text: contextualText }, ...normalizedMedia]
        : [...text, ...normalizedMedia]
      if (
        contentStore &&
        !outputLimits.unlimited &&
        contextView === undefined &&
        (contextualLines > outputLimits.maxLines ||
          contextualBytes >
            (text.length > 0
              ? Math.min(MAX_PERSISTED_CONTENT_PREVIEW_BYTES, outputLimits.maxBytes)
              : outputLimits.maxBytes))
      ) {
        const stored = yield* contentStore.storeTextAttachment({
          sessionID: input.sessionID,
          messageID: input.assistantMessageID,
          key: `${input.assistantMessageID ?? input.toolCallID}:${input.toolCallID}:text`,
          text: contextual,
          mime: "text/plain",
          name: `${sanitize(input.toolCallID)}-output.txt`,
        })
        const record = isRecord(structured) ? structured : { value: structured }
        const metadata = isRecord(record.$opencode) ? record.$opencode : {}
        return {
          output: {
            structured: {
              ...record,
              $opencode: {
                ...metadata,
                text: { type: "content-reference", uri: stored.uri, mime: stored.mime, sizeBytes: contextualBytes },
              },
            },
            content: [
              {
                type: "text" as const,
                text: boundedPreview(
                  contextual,
                  `... full output stored at ${stored.uri} ...`,
                  Math.min(MAX_LINES, outputLimits.maxLines),
                  Math.min(MAX_PERSISTED_CONTENT_PREVIEW_BYTES, outputLimits.maxBytes),
                ),
              },
              ...normalizedMedia,
            ],
          },
          outputPaths: [stored.uri],
        }
      }
      if (effectiveLines <= outputLimits.maxLines && effectiveBytes <= outputLimits.maxBytes)
        return {
          output: { structured: finalStructured, content: modelContent },
          outputPaths: [],
        }

      const outputPath = yield* write(input, contextualText, outputLimits.stablePreview)
      const marker = `... output truncated; full content saved to ${outputPath} ...`

      return {
        output: {
          structured: finalStructured,
          content: [
            {
              type: "text" as const,
              text: boundedPreview(contextualText, marker, outputLimits.maxLines, outputLimits.maxBytes),
            },
            ...normalizedMedia,
          ],
        },
        outputPaths: [outputPath],
      }
    })

    const materialize = Effect.fn("ToolOutputStore.materialize")(function* (input: MaterializeInput) {
      if (!contentStore) return input.output
      const outputSettings = yield* settings()
      const unlimited = outputSettings.unlimited
      const budget = unlimited
        ? { remaining: Number.POSITIVE_INFINITY }
        : (input.budget ?? { remaining: MAX_PROVIDER_TOTAL_PREVIEW_BYTES })
      const attachmentBudget = input.attachmentBudget ?? { remaining: ContentStore.MAX_PROVIDER_TOTAL_BYTES }
      const consumePreview = (text: string, marker: string) => {
        const allowance = unlimited ? Number.POSITIVE_INFINITY : Math.min(MAX_PROVIDER_PREVIEW_BYTES, budget.remaining)
        if (allowance <= 0) return PROVIDER_BUDGET_OMISSION
        const result =
          Buffer.byteLength(text, "utf8") <= allowance && (unlimited || lineCount(text) <= MAX_LINES)
            ? text
            : boundedPreview(text, marker, MAX_LINES, allowance)
        const size = Buffer.byteLength(result, "utf8")
        budget.remaining -= size
        return result
      }
      const resolveTextPreview = Effect.fn("ToolOutputStore.resolveTextPreview")(function* (uri: string) {
        const allowance = unlimited ? Number.POSITIVE_INFINITY : Math.min(MAX_PROVIDER_PREVIEW_BYTES, budget.remaining)
        if (allowance <= 0) return PROVIDER_BUDGET_OMISSION
        const located = yield* contentStore.locate({ uri, sessionID: input.sessionID })
        if (!located)
          return yield* new ContentStore.StorageError({
            operation: "read",
            resource: uri,
            cause: new Error("Managed tool output does not belong to this session"),
          })
        const bytes = yield* Effect.tryPromise({
          try: async () => {
            const handle = await open(located.path, "r")
            try {
              if (located.sizeBytes <= allowance) {
                const content = Buffer.alloc(located.sizeBytes)
                await handle.read(content, 0, content.byteLength, 0)
                return content
              }
              const content = Buffer.alloc(allowance * 2)
              const head = await handle.read(content, 0, allowance, 0)
              const tail = await handle.read(content, allowance, allowance, Math.max(0, located.sizeBytes - allowance))
              return Buffer.concat([
                content.subarray(0, head.bytesRead),
                Buffer.from(`\n... full tool output available at ${uri} ...\n`, "utf8"),
                content.subarray(allowance, allowance + tail.bytesRead),
              ])
            } finally {
              await handle.close()
            }
          },
          catch: (cause) => new ContentStore.StorageError({ operation: "read", resource: uri, cause }),
        })
        return consumePreview(Buffer.from(bytes).toString("utf8"), `... full tool output available at ${uri} ...`)
      })
      const resolve = Effect.fn("ToolOutputStore.resolveContent")(function* (uri: string) {
        const located = yield* contentStore.locate({ uri, sessionID: input.sessionID })
        if (!located)
          return yield* new ContentStore.StorageError({
            operation: "read",
            resource: uri,
            cause: new Error("Managed tool output does not belong to this session"),
          })
        if (
          located.sizeBytes > ContentStore.MAX_PROVIDER_ATTACHMENT_BYTES ||
          located.sizeBytes > attachmentBudget.remaining
        )
          return yield* new ContentStore.StorageError({
            operation: "limit",
            resource: uri,
            cause: new Error("Provider tool output materialization budget exceeded"),
          })
        const resolved = yield* contentStore.resolve({
          uri,
          sessionID: input.sessionID,
          maxBytes: ContentStore.MAX_PROVIDER_ATTACHMENT_BYTES,
        })
        if (!resolved)
          return yield* new ContentStore.StorageError({
            operation: "read",
            resource: uri,
            cause: new Error("Managed tool output could not be resolved"),
          })
        attachmentBudget.remaining -= resolved.bytes.byteLength
        return resolved
      })
      const text = textReference(input.output.structured)
      const restoredText = text ? yield* resolveTextPreview(text.uri) : undefined
      const content = yield* Effect.forEach(
        input.output.content,
        Effect.fnUntraced(function* (item) {
          if (item.type === "text") {
            if (restoredText !== undefined) return item
            return {
              ...item,
              text: consumePreview(item.text, "... tool output truncated for provider replay ..."),
            }
          }
          if (!item.uri.startsWith(ContentStore.URI_PREFIX)) return item
          const resolved = yield* resolve(item.uri)
          return {
            ...item,
            uri: `data:${resolved.mime};base64,${Buffer.from(resolved.bytes).toString("base64")}`,
            mime: resolved.mime,
            name: item.name ?? resolved.name,
          }
        }),
        { concurrency: 1 },
      )
      const reference = contentReference(input.output.structured)
      const structured = reference
        ? {
            ...(input.output.structured as Record<string, unknown>),
            $opencode: {
              ...reference.metadata,
              preview: yield* resolveTextPreview(reference.uri),
            },
          }
        : yield* Effect.try({
            try: () => JSON.stringify(input.output.structured) ?? String(input.output.structured),
            catch: (cause) => new StorageError({ operation: "encode", cause }),
          }).pipe(
            Effect.map((encoded) => {
              const sizeBytes = Buffer.byteLength(encoded, "utf8")
              const allowance = unlimited
                ? Number.POSITIVE_INFINITY
                : Math.min(MAX_PROVIDER_PREVIEW_BYTES, budget.remaining)
              if (sizeBytes <= allowance) {
                budget.remaining -= sizeBytes
                return input.output.structured
              }
              return {
                $opencode: {
                  type: "provider-preview",
                  sizeBytes,
                  preview: consumePreview(encoded, "... structured tool output truncated for provider replay ..."),
                },
              }
            }),
          )
      return {
        structured,
        content:
          restoredText === undefined
            ? content
            : [{ type: "text" as const, text: restoredText }, ...content.filter((item) => item.type === "file")],
      }
    })

    const cleanup = Effect.fn("ToolOutputStore.cleanup")(function* () {
      const entries = yield* fs.readDirectory(directory).pipe(Effect.catch(() => Effect.succeed([])))
      const cutoff = Date.now() - Duration.toMillis(RETENTION)
      for (const entry of entries) {
        if (!entry.startsWith("tool_")) continue
        const file = path.join(directory, entry)
        const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.void))
        const modified = info?.mtime.pipe(
          Option.map((date) => date.getTime()),
          Option.getOrElse(() => 0),
        )
        if (modified !== undefined && modified < cutoff) yield* fs.remove(file).pipe(Effect.catch(() => Effect.void))
      }
    })

    return Service.of({ limits, bound, materialize, cleanup })
  }),
)

function withContextView(value: unknown, view: ContextView): Record<string, unknown> {
  const record = isRecord(value) ? value : { value }
  const metadata = isRecord(record.$opencode) ? record.$opencode : {}
  return { ...record, $opencode: { ...metadata, contextView: view } }
}

function contentReference(value: unknown) {
  if (!isRecord(value) || !isRecord(value.$opencode)) return
  const metadata = value.$opencode
  if (metadata.type !== "content-reference" || typeof metadata.uri !== "string") return
  return { uri: metadata.uri, metadata }
}

function textReference(value: unknown) {
  if (!isRecord(value) || !isRecord(value.$opencode)) return
  const metadata = isRecord(value.$opencode.text)
    ? value.$opencode.text
    : isRecord(value.$opencode.output)
      ? value.$opencode.output
      : undefined
  if (!metadata) return
  if (metadata.type !== "content-reference" || typeof metadata.uri !== "string") return
  return { uri: metadata.uri }
}

export const defaultLayer = layer.pipe(
  Layer.provide(ContentStore.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Global.defaultLayer),
)
export const node = LayerNode.make(layer, [ContentStore.node, FSUtil.node, Global.node])

/** Runs retention scanning once globally rather than once per active Location. */
export const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Service
    yield* store.cleanup().pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.forkScoped)
  }),
)

export const defaultCleanupLayer = Layer.merge(defaultLayer, cleanupLayer.pipe(Layer.provide(defaultLayer)))
