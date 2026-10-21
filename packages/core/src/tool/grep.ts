export * as GrepTool from "./grep"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Option, Schema } from "effect"
import path from "path"
import { Config } from "../config"
import { ConfigOptimization } from "../config/optimization"
import { ContentStore } from "../content-store"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { Perf } from "../observability/perf"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "grep"
export const DEFAULT_LIMIT = 200

const ArtifactPath = Schema.String.annotate({ description: "attachment:// reference to a stored tool-output artifact owned by this session" })

export const Input = Schema.Struct({
  pattern: FileSystem.GrepInput.fields.pattern.annotate({
    description: "Regex pattern to search for in file contents",
  }),
  path: Schema.Union([RelativePath, ArtifactPath]).pipe(Schema.optional).annotate({
    description:
      "Relative directory to search, or an attachment:// reference to a stored tool-output artifact owned by this session",
  }),
  include: FileSystem.GrepInput.fields.include.annotate({
    description: 'File glob to include in the search (for example, "*.js" or "*.{ts,tsx}")',
  }),
  limit: FileSystem.GrepInput.fields.limit.annotate({
    description: "Maximum matches to return",
  }),
})

export class ArtifactSearchPage extends Schema.Class<ArtifactSearchPage>("Grep.ArtifactSearchPage")({
  type: Schema.Literal("artifact-search-page"),
  uri: Schema.String,
  sha256: Schema.String,
  bytes: Schema.Number,
  matches: Schema.Array(
    Schema.Struct({
      line: Schema.Number,
      text: Schema.String,
    }),
  ),
  totalMatches: Schema.Number,
  truncated: Schema.Boolean,
}) {}

export const Output = Schema.Union([Schema.Array(FileSystem.Match), ArtifactSearchPage])
type ModelOutput = typeof Output.Encoded
type ArtifactPageOutput = Extract<ModelOutput, { type: "artifact-search-page" }>

const isArtifactPage = (output: ModelOutput): output is ArtifactPageOutput =>
  typeof output === "object" && !Array.isArray(output) && "type" in output && output.type === "artifact-search-page"

/** Format an artifact search page as trusted raw-retrieval evidence the context router must not compress. */
export const toArtifactModelOutput = (page: ArtifactPageOutput) => {
  const lines = [
    `Stored tool output search (raw retrieval): ${page.uri}`,
    `sha256=${page.sha256} bytes=${page.bytes}`,
    page.truncated
      ? `Found at least ${page.matches.length} matches; raise the limit for exhaustive results.`
      : `Found ${page.matches.length} matches`,
  ]
  for (const match of page.matches) lines.push(`  Line ${match.line}: ${match.text}`)
  return lines.join("\n")
}

/** Format raw search matches into the familiar concise model output. */
export const toModelOutput = (output: ModelOutput) => {
  if (isArtifactPage(output)) return toArtifactModelOutput(output)
  const lines =
    output.length === 0
      ? ["No files found"]
      : [
          `Found ${output.length} matches`,
          ...(output.length >= DEFAULT_LIMIT
            ? [`Search reached at least ${DEFAULT_LIMIT} matches; rerun with a higher limit if you need exhaustive results.`]
            : []),
        ]
  let current = ""
  for (const match of output) {
    if (current !== match.entry.path) {
      if (current) lines.push("")
      current = match.entry.path
      lines.push(`${match.entry.path}:`)
    }
    lines.push(`  Line ${match.line}: ${match.text}`)
  }
  return lines.join("\n")
}

/** Grep leaf that defaults its filesystem root to the active Location. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service
    const config = yield* Effect.serviceOption(Config.Service)
    const defaultLimit = Effect.fn("GrepTool.defaultLimit")(function* () {
      if (Option.isNone(config)) return Number.MAX_SAFE_INTEGER
      const entries = yield* config.value.entries().pipe(Effect.catch(() => Effect.succeed([] as Config.Entry[])))
      return ConfigOptimization.resolve(entries).features.core_search_limits ? DEFAULT_LIMIT : Number.MAX_SAFE_INTEGER
    })
    const contentStore = Option.getOrUndefined(yield* Effect.serviceOption(ContentStore.Service))

    // Artifact search: grep a session-owned stored tool output by attachment reference.
    // Session ownership comes from ContentStore.locate; results are exact raw evidence.
    const searchArtifact = (
      input: { readonly pattern: string; readonly path: string; readonly limit?: number | undefined },
      context: Tool.Context,
    ): Effect.Effect<ArtifactSearchPage, ToolFailure> =>
      Effect.gen(function* () {
        if (!contentStore) return yield* new ToolFailure({ message: "Stored tool output retrieval is unavailable" })
        const located = yield* contentStore.locate({ uri: input.path, sessionID: context.sessionID })
        if (!located) return yield* new ToolFailure({ message: "Stored tool output does not belong to this session" })
        yield* permission.assert({
          action: name,
          resources: [input.path],
          save: ["*"],
          metadata: { artifact: input.path, limit: input.limit },
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
        })
        const limit = input.limit ?? (yield* defaultLimit())
        const result = yield* ripgrep
          .grep({
            cwd: path.dirname(located.path),
            pattern: input.pattern,
            file: path.basename(located.path),
            limit,
          })
          .pipe(Effect.mapError((cause) => new ToolFailure({ message: `Unable to grep stored output: ${cause}` })))
        return new ArtifactSearchPage({
          type: "artifact-search-page",
          uri: input.path,
          sha256: located.sha256,
          bytes: located.sizeBytes,
          matches: result.map((match) => ({ line: match.line, text: match.text })),
          totalMatches: result.length,
          truncated: limit !== Number.MAX_SAFE_INTEGER && result.length >= limit,
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.fail(
            error instanceof ToolFailure
              ? error
              : new ToolFailure({ message: error instanceof Error ? error.message : String(error) }),
          ),
        ),
      )

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Search file contents by regular expression within the active Location or an absolute managed tool-output file. Use a path to narrow the search, include to filter files by glob, and limit to bound the match count. Returns concise file resources, line numbers, and bounded line previews.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: isArtifactPage(output)
                ? toModelOutput(output)
                : toModelOutput(
                    output.map((match) => ({
                      ...match,
                      entry: { ...match.entry, path: path.resolve(location.directory, match.entry.path) },
                    })),
                  ),
            },
          ],
          execute: (input, context) => {
            const artifactPath = input.path
            if (artifactPath !== undefined && artifactPath.startsWith(ContentStore.URI_PREFIX))
              return searchArtifact({ ...input, path: artifactPath }, context)
            return Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: [input.pattern],
                save: ["*"],
                metadata: {
                  root: ".",
                  path: input.path,
                  include: input.include,
                  limit: input.limit,
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const target = path.resolve(location.directory, input.path ?? ".")
              const info = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
              const limit = input.limit ?? (yield* defaultLimit())
              return yield* ripgrep
                .grep({
                  cwd: info?.type === "Directory" ? target : path.dirname(target),
                  pattern: input.pattern,
                  file: info?.type === "File" ? path.basename(target) : undefined,
                  include: input.include,
                  limit,
                })
                .pipe(
                  Effect.tap((result) =>
                    Perf.record(
                      {
                        kind: "optimization",
                        feature: "core_search_limits",
                        tool: name,
                        explicit_limit: input.limit !== undefined,
                        limit,
                        returned: result.length,
                        limit_hit: limit !== Number.MAX_SAFE_INTEGER && result.length >= limit,
                      },
                      "optimization",
                    ),
                  ),
                  Effect.map((result) =>
                    result.map(
                      (match) =>
                        new FileSystem.Match({
                          ...match,
                          entry: new FileSystem.Entry({
                            ...match.entry,
                            path: RelativePath.make(
                              path.relative(
                                location.directory,
                                path.resolve(
                                  info?.type === "Directory" ? target : path.dirname(target),
                                  match.entry.path,
                                ),
                              ),
                            ),
                          }),
                        }),
                    ),
                  ),
                )
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `Unable to grep for ${input.pattern}` })))
          }
        }),
      })
      .pipe(Effect.orDie)
  }),
)
