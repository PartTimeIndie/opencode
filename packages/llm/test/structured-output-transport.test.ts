import { describe, expect, test } from "bun:test"
import { LLM, ToolDefinition } from "../src"
import { StructuredOutputTransport } from "../src/structured-output-transport"
import { OpenAIChat } from "../src/protocols"

const model = OpenAIChat.route.model({ id: "fixture" })
const tool = ToolDefinition.make({ name: "answer", description: "Return answer", inputSchema: { type: "object" } })

describe("structured output tool transport", () => {
  test("selects native JSON only for a proven direct endpoint and keeps compatible endpoints on tools", () => {
    for (const [route, native] of [
      [OpenAIChat.route, true],
      [OpenAIChat.route.with({ endpoint: { baseURL: "https://compatible.test/v1" } }), false],
      [OpenAIChat.route.with({ provider: "compatible" }), false],
      [OpenAIChat.route.with({ endpoint: { baseURL: "https://api.openai.com/v1/proxy" } }), false],
    ] as const) {
      const input = LLM.request({ model: route.model({ id: "fixture" }), prompt: "Return answer" })
      const output = StructuredOutputTransport.objectRequest(input, tool)
      expect(output.responseFormat?.type).toBe(native ? "json" : "tool")
      expect(output.tools).toHaveLength(native ? 0 : 1)
      expect(input.responseFormat).toBeUndefined()
      expect(input.tools).toEqual([])
    }
  })

  test("enables strict mode only for its conservative lossless schema subset", () => {
    const closed = {
      type: "object", properties: { answer: { type: ["string", "null"] } },
      required: ["answer"], additionalProperties: false,
    }
    expect(StructuredOutputTransport.strictSchema(closed)).toBe(true)
    for (const schema of [
      { ...closed, required: [] },
      { ...closed, additionalProperties: true },
      { ...closed, properties: { answer: { anyOf: [{ type: "string" }, { type: "number" }] } } },
      { type: "array", items: closed },
      { ...closed, properties: { answer: { type: "string", const: "fixed" } } },
      { ...closed, properties: { answer: { type: ["string", "number"] } } },
      { ...closed, properties: { answer: { type: "string", items: { type: "string" } } } },
    ]) expect(StructuredOutputTransport.strictSchema(schema)).toBe(false)
  })
  test("checks route-default contract overlays but permits unrelated generation overrides", () => {
    const conflicting = model.route.with({ http: { body: { tools: [] } } }).model({ id: "fixture" })
    expect(() => StructuredOutputTransport.normalize(LLM.request({
      model: conflicting, prompt: "Return answer", responseFormat: { type: "json", schema: tool.inputSchema },
    }))).toThrow("overlay")
    const input = LLM.request({
      model, prompt: "Return answer", responseFormat: { type: "json", schema: tool.inputSchema },
      http: { body: { temperature: 0.2, text: { verbosity: "low" }, generationConfig: { maxOutputTokens: 256 } } },
    })
    expect(StructuredOutputTransport.normalize(input).http).toEqual(input.http)
  })

  test("leaves requests without a tool response format unchanged", () => {
    const input = LLM.request({ model, prompt: "Hello" })
    expect(StructuredOutputTransport.normalizeTool(input)).toBe(input)
  })

  test("retains ordinary tools and does not mutate the accepted request", () => {
    const ordinary = ToolDefinition.make({ ...tool, name: "read" })
    const input = LLM.request({ model, prompt: "Hello", tools: [ordinary], responseFormat: { type: "tool", tool } })
    const output = StructuredOutputTransport.normalizeTool(input)
    expect(output.tools).toEqual([ordinary, tool])
    expect(output.toolChoice).toMatchObject({ type: "tool", name: "answer" })
    expect(input.tools).toEqual([ordinary])
    expect(input.toolChoice).toBeUndefined()
    expect(output.responseFormat).toEqual(input.responseFormat)
  })

  test("does not duplicate a matching existing definition", () => {
    const copy = ToolDefinition.make({ name: "answer", description: "Return answer", inputSchema: { type: "object" } })
    const output = StructuredOutputTransport.normalizeTool(LLM.request({
      model, prompt: "Hello", tools: [copy], responseFormat: { type: "tool", tool },
    }))
    expect(output.tools).toHaveLength(1)
  })

  test("rejects duplicate names and mismatched definitions", () => {
    for (const tools of [[tool, tool], [ToolDefinition.make({ ...tool, inputSchema: { type: "string" } })]]) {
      expect(() => StructuredOutputTransport.normalizeTool(LLM.request({
        model, prompt: "Hello", tools, responseFormat: { type: "tool", tool },
      }))).toThrow()
    }
  })

  test("rejects contradictory tool choices", () => {
    for (const toolChoice of ["none", "different-tool"]) {
      expect(() => StructuredOutputTransport.normalizeTool(LLM.request({
        model, prompt: "Hello", toolChoice, responseFormat: { type: "tool", tool },
      }))).toThrow()
    }
  })
})
