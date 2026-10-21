export * as CommandPlugin from "./command-plugin"

import { Context, Effect, Layer } from "effect"

export interface Input {
  readonly command: string
  readonly sessionID: string
  readonly arguments: string
  readonly text: string
}

export interface Interface {
  readonly transform: (input: Input) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/server/CommandPlugin") {}

export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    transform: (input) => Effect.succeed(input.text),
  }),
)
