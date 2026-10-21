import { AgentV2 } from "@opencode-ai/core/agent"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Effect } from "effect"

export const toolIdentity = {
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_tool_test"),
}

export const toolDefinitions = (
  registry: ToolRegistry.Interface,
  permissions?: Parameters<typeof registry.materialize>[0],
  policy?: Parameters<typeof registry.materialize>[1],
  context?: Parameters<typeof registry.materialize>[2],
) => registry.materialize(permissions, policy, context).pipe(Effect.map((materialized) => materialized.definitions))

export const settleTool = (registry: ToolRegistry.Interface, input: ToolRegistry.ExecuteInput) =>
  registry
    .materialize(undefined, undefined, { sessionID: input.sessionID, agent: input.agent })
    .pipe(Effect.flatMap((materialized) => materialized.settle(input)))

export const executeTool = (registry: ToolRegistry.Interface, input: ToolRegistry.ExecuteInput) =>
  settleTool(registry, input).pipe(Effect.map((settlement) => settlement.result))
