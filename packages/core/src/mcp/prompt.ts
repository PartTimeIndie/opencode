export * as McpPrompt from "./prompt"

import { Context, Effect, Exit, Layer } from "effect"
import { McpClient } from "./client"
import { McpNaming } from "./naming"

type PromptInfo = Awaited<ReturnType<McpClient.MCPClient["listPrompts"]>>["prompts"][number]
type PromptMessage = Awaited<ReturnType<McpClient.MCPClient["getPrompt"]>>["messages"][number]

export type Prompt = PromptInfo & { client: string }

export interface Interface {
  readonly prompts: () => Effect.Effect<Record<string, Prompt>>
  readonly getPrompt: (
    clientName: string,
    name: string,
    args?: Record<string, string>,
  ) => Effect.Effect<Awaited<ReturnType<McpClient.MCPClient["getPrompt"]>> | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/McpPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const clients = yield* McpClient.Service

    const prompts = Effect.fn("McpPrompt.prompts")(function* () {
      const results = yield* Effect.forEach(
        clients.servers(),
        (server) =>
          Effect.gen(function* () {
            const listed = yield* Effect.gen(function* () {
              const firstClient = yield* clients.get(server.name)
              if (!firstClient) return [] as PromptInfo[]
              const first = yield* listPrompts(firstClient, server.timeout).pipe(Effect.exit)
              if (Exit.isSuccess(first)) return first.value
              yield* clients.invalidate(server.name)
              yield* Effect.sleep("50 millis")
              const retryClient = yield* clients.get(server.name)
              if (!retryClient) return yield* Effect.fail(new Error(`MCP server '${server.name}' is unavailable`))
              return yield* listPrompts(retryClient, server.timeout)
            }).pipe(
              Effect.catch((error) =>
                clients.invalidate(server.name).pipe(
                  Effect.andThen(
                    Effect.logWarning("failed to list MCP prompts", { server: server.name, error: describe(error) }),
                  ),
                  Effect.as([] as PromptInfo[]),
                ),
              ),
            )
            return listed.map(
              (prompt) => [McpNaming.prompt(server.name, prompt.name), { ...prompt, client: server.name }] as const,
            )
          }),
        { concurrency: "unbounded" },
      )
      return Object.fromEntries(results.flat())
    })

    const getPrompt = Effect.fn("McpPrompt.getPrompt")(function* (
      clientName: string,
      name: string,
      args?: Record<string, string>,
    ) {
      const client = yield* clients.get(clientName)
      if (!client) {
        yield* Effect.logWarning("MCP prompt client not found", { clientName, promptName: name })
        return
      }
      const server = clients.servers().find((item) => item.name === clientName)
      return yield* Effect.tryPromise({
        try: (signal) =>
          client.getPrompt(
            { name, arguments: args },
            { timeout: server?.timeout ?? McpClient.DEFAULT_TIMEOUT, signal },
          ),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          clients.invalidate(clientName).pipe(
            Effect.andThen(
              Effect.logWarning("failed to get MCP prompt", {
                clientName,
                promptName: name,
                error: describe(error),
              }),
            ),
            Effect.as(undefined),
          ),
        ),
      )
    })

    return Service.of({ prompts, getPrompt })
  }),
)

export const locationLayer = layer.pipe(Layer.provide(McpClient.locationLayer))

function listPrompts(client: McpClient.MCPClient, timeout?: number) {
  if (!client.getServerCapabilities()?.prompts) return Effect.succeed([] as PromptInfo[])
  return Effect.tryPromise({
    try: () =>
      McpClient.paginate(
        (cursor) =>
          client.listPrompts(
            cursor === undefined ? undefined : { cursor },
            { timeout: timeout ?? McpClient.DEFAULT_TIMEOUT },
          ),
        (result) => result.prompts,
      ),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}

export function promptText(messages: readonly PromptMessage[]) {
  return messages.map((message) => (message.content.type === "text" ? message.content.text : "")).join("\n")
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
