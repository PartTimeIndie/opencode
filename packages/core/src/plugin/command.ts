export * as CommandPlugin from "./command"

import { Effect } from "effect"
import { CommandV2 } from "../command"
import { Location } from "../location"
import { PluginV2 } from "../plugin"
import PROMPT_INITIALIZE from "./command/initialize.txt"
import PROMPT_REVIEW from "./command/review.txt"

export const Plugin = PluginV2.define({
  id: PluginV2.ID.make("command"),
  effect: Effect.gen(function* () {
    const command = yield* CommandV2.Service
    const location = yield* Location.Service
    const transform = yield* command.transform()

    yield* transform((editor) => {
      editor.update("init", (command) => {
        command.template = PROMPT_INITIALIZE.replace("${path}", location.project.directory)
        command.description = "guided AGENTS.md setup"
        command.source = "command"
        command.hints = CommandV2.hints(command.template)
      })
      editor.update("review", (command) => {
        command.template = PROMPT_REVIEW.replace("${path}", location.project.directory)
        command.description = "review changes [commit|branch|pr], defaults to uncommitted"
        command.source = "command"
        command.subtask = true
        command.hints = CommandV2.hints(command.template)
      })
    })
  }),
})
