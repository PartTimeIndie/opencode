import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "./session"
import type { RevertInput } from "./revert"

export interface Interface {
  readonly ensureStarted: (input: { session: Session.Info; request: RevertInput }) => Effect.Effect<Session.Info>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRevertRepair") {}

// Retain the compatibility boundary, but never spawn a writing agent for a blocked rollback.
export const layer = Layer.succeed(Service, Service.of({ ensureStarted: (input) => Effect.succeed(input.session) }))
export const defaultLayer = layer
export const node = LayerNode.make(layer, [])

export * as SessionRevertRepair from "./revert-repair"
