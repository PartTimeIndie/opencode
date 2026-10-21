import { describe, expect, test } from "bun:test"
import { CacheHint, LLM, Model, ToolDefinition } from "@opencode-ai/llm"
import { AnthropicMessages } from "@opencode-ai/llm/protocols/anthropic-messages"
import { BedrockConverse } from "@opencode-ai/llm/protocols/bedrock-converse"
import { Gemini } from "@opencode-ai/llm/protocols/gemini"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { OpenAICompatibleChat } from "@opencode-ai/llm/protocols/openai-compatible-chat"
import { OpenAIResponses } from "@opencode-ai/llm/protocols/openai-responses"
import { Effect } from "effect"
import {
  adaptToolDefinitions,
  providerFacingRequestTools,
} from "@opencode-ai/core/session/runner/tool-compatibility"

const SURFACE_TOOL_NAME = "surface"
const glm53 = Model.make({ provider: "zhipuai-coding-plan", id: "glm-5.3", route: OpenAIChat.route })
const glm52 = Model.make({ provider: "zhipuai-coding-plan", id: "glm-5.2", route: OpenAIChat.route })
const openaiGlm53 = Model.make({ provider: "openai", id: "glm-5.3", route: OpenAIChat.route })
const openrouterStealth = Model.make({ provider: "openrouter", id: "stealth/ox-alpha", route: OpenAIChat.route })
const protocolModels = {
  anthropic: Model.make({ provider: "anthropic", id: "claude", route: AnthropicMessages.route }),
  bedrock: Model.make({ provider: "amazon-bedrock", id: "claude", route: BedrockConverse.route }),
  gemini: Model.make({ provider: "google", id: "gemini", route: Gemini.route }),
  compatible: Model.make({ provider: "openai-compatible", id: "chat", route: OpenAICompatibleChat.route }),
  responses: Model.make({ provider: "openai", id: "responses", route: OpenAIResponses.route }),
}

const registrySchema = {
  type: "object",
  properties: { mode: { type: "string" } },
  additionalProperties: true,
} as const

const makeSurface = () =>
  ToolDefinition.make({
    name: SURFACE_TOOL_NAME,
    description: "surface",
    inputSchema: registrySchema,
    outputSchema: { type: "object" },
    cache: CacheHint.make({ type: "ephemeral" }),
    metadata: { registry: true },
    native: { vendor: "host" },
  })

const makeOther = (name: string) =>
  ToolDefinition.make({
    name,
    description: name,
    inputSchema: { type: "object", properties: { command: { type: "string" } } },
  })

describe("SessionRunner tool compatibility", () => {
  test("uses the portable surface schema for every model provider", () => {
    const surface = makeSurface()
    const bash = makeOther("bash")
    const read = makeOther("read")
    const definitions = [bash, surface, read]

    const adapted = adaptToolDefinitions(glm53, definitions)
    expect(adapted[0]).toBe(bash)
    expect(adapted[2]).toBe(read)
    expect(adapted[1]).not.toBe(surface)
    expect(adapted[1].name).toBe(SURFACE_TOOL_NAME)
    expect(adapted[1].inputSchema).not.toBe(registrySchema)

    const schema = adapted[1].inputSchema as {
      type: string
      properties: Record<string, unknown>
      additionalProperties?: boolean
    }
    expect(schema.type).toBe("object")
    expect(schema.additionalProperties).toBe(true)
    expect(schema.properties.mode).toEqual({
      type: "string",
      enum: ["blocking", "interactive", "passive"],
    })
    expect(schema.properties.sourceFile).toEqual({
      type: "object",
      properties: {
        path: { type: "string" },
        sha256: { type: "string" },
        count: { type: "integer" },
      },
      required: ["path", "sha256", "count"],
      additionalProperties: false,
    })
    expect(schema.properties.phase).toEqual({
      type: "string",
      enum: ["implementation_complete_followup"],
    })
    expect(JSON.stringify(schema)).not.toMatch(/\"(?:anyOf|oneOf|allOf|\$defs|\$ref)\"/)

    const questions = schema.properties.questions as {
      items: { properties: Record<string, unknown>; additionalProperties?: boolean }
    }
    const questionItem = questions.items
    expect(questionItem.additionalProperties).toBe(true)
    expect(questionItem.properties.type).toEqual({ type: "string" })
    const body = questionItem.properties.body as { items: { properties: Record<string, unknown> } }
    expect(body.items.properties.id).toEqual({ type: "string" })
    expect(body.items.properties.type).toEqual({ type: "string" })
    expect(body.items.properties.content).toEqual({ type: "string" })

    for (const model of [glm52, openaiGlm53, openrouterStealth, ...Object.values(protocolModels)]) {
      const result = adaptToolDefinitions(model, definitions)
      expect(result[1]).not.toBe(surface)
      expect(result[1].inputSchema).toEqual(schema)
    }
  })

  test("portable surface fields survive every protocol request lowering", async () => {
    const request = (model: Model) =>
      LLM.request({
        model,
        prompt: "Use the surface tool.",
        tools: adaptToolDefinitions(model, [makeSurface()]),
      })
    const bodies = await Promise.all([
      Effect.runPromise(OpenAIChat.protocol.body.from(request(glm53))),
      Effect.runPromise(OpenAIResponses.protocol.body.from(request(protocolModels.responses))),
      Effect.runPromise(AnthropicMessages.protocol.body.from(request(protocolModels.anthropic))),
      Effect.runPromise(BedrockConverse.protocol.body.from(request(protocolModels.bedrock))),
      Effect.runPromise(Gemini.protocol.body.from(request(protocolModels.gemini))),
    ])

    for (const body of bodies) {
      const schema = JSON.stringify(body)
      expect(schema).toContain('"mode"')
      expect(schema).toContain('"questions"')
      expect(schema).toContain('"sourceFile"')
      expect(schema).toContain('"controls"')
      expect(schema).not.toMatch(/"(?:anyOf|oneOf|allOf|\$defs|\$ref)"/)
    }
  })

  test("preserves cache metadata native and outputSchema on adapted surface", () => {
    const surface = makeSurface()
    const adapted = adaptToolDefinitions(glm53, [surface])[0]!
    expect(adapted.cache).toEqual(surface.cache)
    expect(adapted.metadata).toEqual(surface.metadata)
    expect(adapted.native).toEqual(surface.native)
    expect(adapted.outputSchema).toEqual(surface.outputSchema)
  })

  test("leaves a tool list without surface unchanged", () => {
    const definitions = [makeOther("bash"), makeOther("read")]
    expect(adaptToolDefinitions(openrouterStealth, definitions)).toBe(definitions)
  })

  test("providerFacingRequestTools is the post-composition boundary helper", () => {
    const surface = makeSurface()
    const composed = [makeOther("bash"), surface]
    const adapted = providerFacingRequestTools(glm53, composed)
    expect(adapted[0]).toBe(composed[0])
    expect(adapted[1]).not.toBe(surface)
    expect(adapted[1].inputSchema).not.toBe(surface.inputSchema)
  })

  test("provider schema advertises canonical blocking and control payload fields", () => {
    const adapted = adaptToolDefinitions(glm53, [makeSurface()])[0]!
    const schema = adapted.inputSchema as {
      additionalProperties?: boolean
      properties: {
        sourceFile: unknown
        phase: unknown
        version: unknown
        controlID: unknown
        controls: unknown
        values: unknown
        effects: unknown
        actions: unknown
        dock: unknown
        questions: {
          items: {
            additionalProperties?: boolean
            properties: {
              body: { items: { additionalProperties?: boolean } }
            }
          }
        }
      }
    }
    expect(schema.additionalProperties).toBe(true)
    expect(schema.properties.questions.items.additionalProperties).toBe(true)
    expect(schema.properties.questions.items.properties.body.items.additionalProperties).toBe(true)
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining([
        "sourceFile",
        "phase",
        "version",
        "controlID",
        "controls",
        "values",
        "effects",
        "actions",
        "dock",
      ]),
    )
  })
})
