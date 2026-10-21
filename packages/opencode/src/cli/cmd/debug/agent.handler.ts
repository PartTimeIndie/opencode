import { EOL } from "os"
import { basename } from "path"
import { Effect } from "effect"
import { Agent } from "../../../agent/agent"
import { Permission } from "../../../permission"
import { iife } from "../../../util/iife"
import { fail } from "../../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"

export const debugAgent = Effect.fn("Cli.debug.agent")(function* (args: {
  name: string
  tool?: string
  params?: string
}) {
  const ctx = yield* InstanceRef
  if (!ctx) return
  return yield* run(args, ctx)
})

const run = Effect.fn("Cli.debug.agent.body")(function* (
  args: { name: string; tool?: string; params?: string },
  ctx: InstanceContext,
) {
  const agentName = args.name
  const agent = yield* Agent.Service.use((svc) => svc.get(agentName))
  if (!agent) {
    process.stderr.write(
      `Agent ${agentName} not found, run '${basename(process.execPath)} agent list' to get an agent list` + EOL,
    )
    return yield* fail("", 1)
  }
  const availableTools = yield* getAvailableTools(ctx)
  const resolvedTools = resolveTools(agent, availableTools)
  const toolID = args.tool
  if (toolID) {
    const tool = availableTools.find((item) => item.id === toolID)
    if (!tool) {
      process.stderr.write(`Tool ${toolID} not found for agent ${agentName}` + EOL)
      return yield* fail("", 1)
    }
    if (resolvedTools[toolID] === false) {
      process.stderr.write(`Tool ${toolID} is disabled for agent ${agentName}` + EOL)
      return yield* fail("", 1)
    }
    parseToolParams(args.params)
    return yield* fail("Debug tool execution through the legacy registry was removed; run a real session to exercise canonical tools.", 1)
  }

  const output = {
    ...agent,
    toolPolicy: agent.tools,
    tools: resolvedTools,
  }
  process.stdout.write(JSON.stringify(output, null, 2) + EOL)
})

const getAvailableTools = Effect.fn("Cli.debug.agent.getAvailableTools")(function* (ctx: InstanceContext) {
  const locations = yield* LocationServiceMap
  const materialized = yield* ToolRegistry.Service.use((registry) => registry.materialize()).pipe(
    Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))),
  )
  return materialized.definitions.map((item) => ({ id: item.name }))
})

function resolveTools(agent: Agent.Info, availableTools: { id: string }[]) {
  const disabled = Permission.disabled(
    availableTools.map((tool) => tool.id),
    agent.permission,
  )
  const resolved: Record<string, boolean> = {}
  for (const tool of availableTools) {
    const entry = agent.tools?.mode === "explicit" ? agent.tools.entries[tool.id] : undefined
    resolved[tool.id] =
      (agent.tools?.mode !== "explicit" && !disabled.has(tool.id)) ||
      !!entry && entry.visible !== false && entry.permission !== "deny" && !disabled.has(tool.id)
  }
  return resolved
}

function parseToolParams(input?: string) {
  if (!input) return {}
  const trimmed = input.trim()
  if (trimmed.length === 0) return {}

  const parsed = iife(() => {
    try {
      return JSON.parse(trimmed)
    } catch (jsonError) {
      try {
        return new Function(`return (${trimmed})`)()
      } catch (evalError) {
        throw new Error(
          `Failed to parse --params. Use JSON or a JS object literal. JSON error: ${jsonError}. Eval error: ${evalError}.`,
          { cause: evalError },
        )
      }
    }
  })

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool params must be an object.")
  }
  return parsed as Record<string, unknown>
}
