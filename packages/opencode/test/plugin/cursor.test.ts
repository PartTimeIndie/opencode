import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { CursorAuthPlugin } from "../../../provider-plugins/cursor/src/server/cursor"

describe("CursorAuthPlugin", () => {
  test("exposes the Cursor browser-login connect method", async () => {
    const hooks = await CursorAuthPlugin({} as PluginInput)
    expect(hooks.auth?.provider).toBe("cursor")
    expect(hooks.auth?.methods.map((method) => method.label)).toEqual([
      "Cursor account (browser login)",
      "API key (cursor.com/settings)",
    ])
  })
})
