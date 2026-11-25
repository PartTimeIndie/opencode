import type { Hooks } from "@opencode-ai/plugin"
import { ShellEnvironment } from "@opencode-ai/core/shell-environment"
import { Effect } from "effect"

/** Bridge the existing SDK hook into native tools without coupling Core to the legacy host. */
export const registerShellEnvironment = Effect.fn("Plugin.registerShellEnvironment")(function* (
  directory: string,
  hooks: readonly Hooks[],
) {
  const environment = yield* ShellEnvironment.Service
  yield* environment.register(directory, (input) => Effect.tryPromise({
    try: async () => {
      const output = { env: {} as Record<string, string> }
      for (const hook of hooks) {
        await hook["shell.env"]?.({ cwd: input.cwd, sessionID: input.sessionID, callID: input.callID }, output)
      }
      if (typeof output.env !== "object" || output.env === null || Array.isArray(output.env)
        || Object.entries(output.env).some(([key, value]) => !key || /[=\0]/.test(key)
          || typeof value !== "string" || value.includes("\0"))) {
        throw new Error("Invalid shell environment")
      }
      return output.env
    },
    catch: () => new Error("Plugin shell.env hook failed; shell was not started"),
  }))
})
