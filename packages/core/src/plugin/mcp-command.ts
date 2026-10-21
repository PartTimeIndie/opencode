export * as McpCommandPlugin from "./mcp-command"

import { Effect } from "effect"
import { CommandV2 } from "../command"
import { McpPrompt } from "../mcp/prompt"
import { PluginV2 } from "../plugin"

export const Plugin = PluginV2.define({
  id: PluginV2.ID.make("mcp-command"),
  effect: Effect.gen(function* () {
    const command = yield* CommandV2.Service
    const mcp = yield* McpPrompt.Service
    const transform = yield* command.transform()
    const prompts = yield* mcp.prompts()

    yield* transform((editor) => {
      for (const [name, prompt] of Object.entries(prompts)) {
        editor.update(name, (command) => {
          command.template = prompt.description ?? ""
          command.description = prompt.description
          command.source = "mcp"
          command.hints = prompt.arguments?.map((_, index) => `$${index + 1}`) ?? []
        })
        editor.resolve(name, (input) =>
          mcp
            .getPrompt(prompt.client, prompt.name, promptArguments(prompt.arguments ?? [], input.arguments))
            .pipe(Effect.map((result) => (result ? McpPrompt.promptText(result.messages) : ""))),
        )
      }
    })
  }),
})

function promptArguments(args: NonNullable<McpPrompt.Prompt["arguments"]>, raw: string) {
  const values = CommandV2.parseArguments(raw)
  return Object.fromEntries(
    args.map((argument, index) => [
      argument.name,
      index === args.length - 1 ? values.slice(index).join(" ") : (values[index] ?? ""),
    ]),
  )
}
