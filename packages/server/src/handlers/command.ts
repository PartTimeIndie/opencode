import { CommandV2 } from "@opencode-ai/core/command"
import { PluginBoot } from "@opencode-ai/core/plugin/boot"
import { SkillCommandPlugin } from "@opencode-ai/core/plugin/skill-command"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../groups/location"

export const CommandHandler = HttpApiBuilder.group(Api, "server.command", (handlers) =>
  handlers.handle("command.list", () =>
    response(
      Effect.gen(function* () {
        yield* PluginBoot.Service.use((boot) => boot.wait({ mcpCommands: true }))
        yield* SkillCommandPlugin.sync()
        return yield* CommandV2.Service.use((command) => command.list())
      }),
    ),
  ),
)
