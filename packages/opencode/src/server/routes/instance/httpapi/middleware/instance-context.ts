import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { type InstanceContext } from "@/project/instance-context"
import { Effect, Layer } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { WorkspaceRouteContext } from "./workspace-routing"

export class InstanceContextMiddleware extends HttpApiMiddleware.Service<
  InstanceContextMiddleware,
  {
    requires: WorkspaceRouteContext
  }
>()("@opencode/ExperimentalHttpApiInstanceContext") {}

function decode(input: string): string {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

function provideInstanceContext<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
  store: InstanceStore.Interface,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext> {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    // load() is typed never-failing, but the bootstrap deadline completes the
    // entry deferred with InstanceUnavailableError at runtime. Surface that as
    // the structured 503 instead of an undeclared failure.
    type Loaded =
      | { _tag: "Ready"; ctx: InstanceContext }
      | { _tag: "Unavailable"; error: InstanceStore.InstanceUnavailableError }
    const loaded = yield* store
      .load({ directory: decode(route.directory) })
      .pipe(
        Effect.map((ctx): Loaded => ({ _tag: "Ready", ctx })),
        Effect.catchIf(
          (error) => InstanceStore.InstanceUnavailableError.isInstance(error),
          (error) => Effect.succeed<Loaded>({ _tag: "Unavailable", error: error as InstanceStore.InstanceUnavailableError }),
        ),
      )
    if (loaded._tag === "Unavailable") return InstanceStore.InstanceUnavailableError.response(loaded.error)
    const ctx = loaded.ctx
    return yield* effect.pipe(
      Effect.provideService(InstanceRef, ctx),
      Effect.provideService(WorkspaceRef, route.workspaceID),
    )
  })
}

export const instanceContextLayer = Layer.effect(
  InstanceContextMiddleware,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return InstanceContextMiddleware.of((effect) => provideInstanceContext(effect, store))
  }),
)
