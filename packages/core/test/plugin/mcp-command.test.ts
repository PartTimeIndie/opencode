import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CommandV2 } from "@opencode-ai/core/command"
import { McpPrompt } from "@opencode-ai/core/mcp/prompt"
import { McpCommandPlugin } from "@opencode-ai/core/plugin/mcp-command"
import { testEffect } from "../lib/effect"

const it = testEffect(CommandV2.locationLayer)

describe("McpCommandPlugin.Plugin", () => {
  it.effect("registers MCP prompts as commands and resolves prompt content at execution time", () =>
    Effect.gen(function* () {
      const command = yield* CommandV2.Service
      yield* McpCommandPlugin.Plugin.effect.pipe(
        Effect.provideService(CommandV2.Service, command),
        Effect.provideService(
          McpPrompt.Service,
          McpPrompt.Service.of({
            prompts: () =>
              Effect.succeed({
                "demo:review": {
                  client: "demo",
                  name: "review",
                  description: "Review through MCP",
                  arguments: [{ name: "target" }, { name: "details" }],
                },
              }),
            getPrompt: (_clientName, _name, args) =>
              Effect.succeed({
                messages: [
                  {
                    role: "user",
                    content: { type: "text", text: `resolved ${args?.target} ${args?.details}` },
                  },
                ],
              }),
          }),
        ),
      )

      expect(yield* command.get("demo:review")).toMatchObject({
        name: "demo:review",
        template: "Review through MCP",
        description: "Review through MCP",
        source: "mcp",
        hints: ["$1", "$2"],
      })
      expect(yield* command.resolve({ name: "demo:review", arguments: "src extra details" })).toBe(
        "resolved src extra details",
      )
    }),
  )
})
