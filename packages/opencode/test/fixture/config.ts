import { Config } from "@/config/config"
import { emptyConsoleState } from "@opencode-ai/core/v1/config/console-state"
import { Effect, Layer } from "effect"

export function make(overrides: Partial<Config.Interface> = {}) {
  return Config.Service.of({
    get: () => Effect.succeed({}),
    getGlobal: () => Effect.succeed({}),
    getConsoleState: () => Effect.succeed(emptyConsoleState),
    update: () => Effect.void,
    // The real service persists the merged config, so a null default can never
    // survive into the returned info; the echo mirrors that contract.
    updateGlobal: (config) => {
      const { default_model_chain, ...rest } = config
      return Effect.succeed({
        info: { ...rest, default_model_chain: default_model_chain === null ? undefined : default_model_chain },
        changed: false,
      })
    },
    invalidate: () => Effect.void,
    directories: () => Effect.succeed([]),
    waitForDependencies: () => Effect.void,
    ...overrides,
  })
}

export function layer(overrides?: Partial<Config.Interface>) {
  return Layer.succeed(Config.Service, make(overrides))
}

export * as TestConfig from "./config"
