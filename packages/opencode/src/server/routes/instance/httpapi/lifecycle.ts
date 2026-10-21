import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceStore } from "@/project/instance-store"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { PluginBoot } from "@opencode-ai/core/plugin/boot"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Effect } from "effect"
import { HttpEffect, HttpMiddleware, HttpServerRequest } from "effect/unstable/http"

type MarkedInstance = {
  ctx: InstanceContext
  store: InstanceStore.Interface
  bridge: EffectBridge.Shape
}

// Disposal is requested by an endpoint handler, but must run from the outer
// server middleware after the response has been produced. The original Request
// object is the stable handoff key between those two phases.
const disposeAfterResponse = new WeakMap<object, MarkedInstance>()

const mark = (ctx: InstanceContext) =>
  Effect.gen(function* () {
    return { ctx, store: yield* InstanceStore.Service, bridge: yield* EffectBridge.make() }
  })

export const markInstanceForDisposal = (ctx: InstanceContext) =>
  Effect.gen(function* () {
    const marked = yield* mark(ctx)
    return yield* HttpEffect.appendPreResponseHandler((request, response) =>
      Effect.sync(() => {
        // The response is sent before disposeMiddleware performs the teardown.
        disposeAfterResponse.set(request.source, marked)
        return response
      }),
    )
  })

export const markInstanceForReload = (ctx: InstanceContext, next: InstanceStore.LoadInput) =>
  Effect.gen(function* () {
    const marked = yield* mark(ctx)
    return yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.as(Effect.uninterruptible(marked.bridge.run(marked.store.reload(next))), response),
    )
  })

export const invalidateAgentForInstance = (ctx: InstanceContext) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap
    yield* Effect.gen(function* () {
      yield* PluginBoot.Service.use((boot) => boot.wait())
      yield* AgentV2.Service.use((agent) => Effect.sync(() => agent.invalidate?.()))
    }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
  })

export const disposeMiddleware: HttpMiddleware.HttpMiddleware = (effect) =>
  Effect.gen(function* () {
    const response = yield* effect
    const request = yield* HttpServerRequest.HttpServerRequest
    const marked = disposeAfterResponse.get(request.source)
    if (!marked) return response
    disposeAfterResponse.delete(request.source)
    yield* Effect.uninterruptible(marked.bridge.run(marked.store.dispose(marked.ctx))).pipe(
      Effect.catchCause((cause) => Effect.logWarning("instance disposal failed", { cause })),
    )
    return response
  })
