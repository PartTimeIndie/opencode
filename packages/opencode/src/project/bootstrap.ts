import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "@/lsp/lsp"
import { Snapshot } from "../snapshot"
import * as Project from "./project"
import * as Vcs from "./vcs"
import { InstanceState } from "@/effect/instance-state"
import { ShareNext } from "@/share/share-next"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { Service } from "./bootstrap-service"
import { CodeIntelligence } from "@opencode-ai/core/code-intelligence"
import { makeProvider } from "@/lsp/core-adapter"
import { ProjectIconGeneration } from "./icon-generation"
import { SessionStatus } from "@/session/status"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionRetryStatus } from "@/session/retry-status"

export { Service } from "./bootstrap-service"
export type { Interface } from "./bootstrap-service"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Yield each bootstrap dep at layer init so `run` itself has R = never.
    // InstanceStore imports only the lightweight tag from bootstrap-service.ts,
    // so it can depend on bootstrap without importing this implementation graph.
    const config = yield* Config.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const codeIntelligence = yield* CodeIntelligence.Service
    const plugin = yield* Plugin.Service
    const project = yield* Project.Service
    const shareNext = yield* ShareNext.Service
    const snapshot = yield* Snapshot.Service
    const vcs = yield* Vcs.Service
    const projectIcons = yield* ProjectIconGeneration.Service
    const retryStatus = yield* SessionRetryStatus.Service

    const run = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      yield* codeIntelligence.register(ctx.directory, makeProvider(lsp))
      yield* Effect.logInfo("bootstrapping", { directory: ctx.directory })
      // everything depends on config so eager load it for nice traces
      yield* config.get()
      // Plugin can mutate config so it has to be initialized before anything else.
      yield* plugin.init()
      // Each service self-manages its own slow work via Effect.forkScoped against
      // its per-instance state scope. We just await materialization here.
      yield* Effect.forEach(
        [
          ["lsp", lsp],
          ["shareNext", shareNext],
          ["format", format],
          ["vcs", vcs],
          ["snapshot", snapshot],
          ["project", project],
          ["projectIcons", projectIcons],
        ] as const,
        ([name, service]) =>
          Effect.gen(function* () {
            yield* Effect.logInfo("bootstrap service starting", { directory: ctx.directory, name })
            yield* service.init().pipe(Effect.catchCause((cause) => Effect.logWarning("init failed", { cause })))
            yield* Effect.logInfo("bootstrap service finished", { directory: ctx.directory, name })
          }),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.withSpan("InstanceBootstrap.init"))
      // Retry countdown must be armed before the first drain can publish a retry.
      yield* retryStatus.init().pipe(
        Effect.catchCause((cause) => Effect.logWarning("retry status init failed", { cause })),
      )
    }).pipe(Effect.withSpan("InstanceBootstrap"))

    return Service.of({ run })
  }),
)

// Retry status depends on the bridge and status services; provide them to its
// layer directly because mergeAll does not wire sibling dependencies.
const retryStatusLayer = SessionRetryStatus.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
)

export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Config.defaultLayer,
      Format.defaultLayer,
      LSP.defaultLayer,
      CodeIntelligence.defaultLayer,
      Plugin.defaultLayer,
      Project.defaultLayer,
      ShareNext.defaultLayer,
      Snapshot.defaultLayer,
      Vcs.defaultLayer,
      ProjectIconGeneration.defaultLayer,
      retryStatusLayer,
    ),
  ),
)

export const node = LayerNode.make(layer, [
  Config.node,
  Format.node,
  LSP.node,
  CodeIntelligence.node,
  Plugin.node,
  Project.node,
  ShareNext.node,
  Snapshot.node,
  Vcs.node,
  ProjectIconGeneration.node,
  EventV2Bridge.node,
  SessionStatus.node,
  SessionRetryStatus.node,
])

export * as InstanceBootstrap from "./bootstrap"
