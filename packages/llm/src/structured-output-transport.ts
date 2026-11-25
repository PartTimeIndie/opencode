import { isDeepStrictEqual } from "node:util"
import { LLMRequest, ToolChoice, ToolDefinition } from "./schema/messages"
import { prepare } from "./structured-json-subset"

export * as StructuredOutputTransport from "./structured-output-transport"

export const contractVersion = "original-schema-transport-v1"

/** Automatic selection is narrower than wire support: compatible hosts inherit no native claim. */
export function objectRequest(request: LLMRequest, tool: ToolDefinition) {
  const route = request.model.route
  const base = route.endpoint.baseURL?.replace(/\/+$/, "")
  const native = route.jsonSchema && (
    request.model.provider === "openai" && base === "https://api.openai.com/v1"
      && (route.protocol === "openai-chat" || route.protocol === "openai-responses")
    || request.model.provider === "google" && base === "https://generativelanguage.googleapis.com/v1beta"
      && route.protocol === "gemini"
  )
  if (native) return normalize(LLMRequest.update(request, {
    tools: [], toolChoice: undefined, responseFormat: { type: "json", schema: tool.inputSchema },
  }))
  return normalizeTool(LLMRequest.update(request, {
    tools: [tool], toolChoice: ToolChoice.named(tool.name), responseFormat: { type: "tool", tool },
  }))
}

/** Strict mode never fills optional fields or closes open objects on the caller's behalf. */
export function strictSchema(schema: unknown): boolean {
  const budget = { properties: 0, enums: 0, strings: 0 }
  const node = (value: unknown, depth: number): boolean => {
    if (depth > 5 || typeof value !== "object" || value === null || Array.isArray(value)) return false
    const entries = Object.entries(value)
    if (entries.some(([key]) => !["type", "title", "description", "enum", "properties", "required", "additionalProperties", "items"].includes(key))) return false
    budget.strings += entries.reduce((sum, [key, item]) => sum + key.length + (typeof item === "string" ? item.length : 0), 0)
    const fields = new Map(entries)
    const types = typeof fields.get("type") === "string" ? [fields.get("type")] : fields.get("type")
    if (!Array.isArray(types) || types.length === 0 || types.length > 2
      || new Set(types).size !== types.length || types.filter((type) => type !== "null").length > 1
      || types.some((type) => !["object", "array", "string", "number", "integer", "boolean", "null"].includes(type))) return false
    if (!types.includes("object") && ["properties", "required", "additionalProperties"].some((key) => fields.has(key))) return false
    if (!types.includes("array") && fields.has("items")) return false
    if (fields.has("enum")) {
      const values = fields.get("enum")
      if (!Array.isArray(values) || values.some((item) => item !== null && !["string", "number", "boolean"].includes(typeof item))) return false
      budget.enums += values.length
      budget.strings += values.reduce((sum, item) => sum + (typeof item === "string" ? item.length : 0), 0)
    }
    if (types.includes("object")) {
      const properties = fields.get("properties")
      const required = fields.get("required")
      if (typeof properties !== "object" || properties === null || Array.isArray(properties)
        || !Array.isArray(required) || fields.get("additionalProperties") !== false) return false
      const keys = Object.keys(properties)
      budget.properties += keys.length
      budget.strings += keys.reduce((sum, key) => sum + key.length, 0)
      if (required.length !== keys.length || !keys.every((key) => required.includes(key))
        || !Object.values(properties).every((item) => node(item, depth + 1))) return false
    }
    if (types.includes("array") && !node(fields.get("items"), depth + 1)) return false
    return budget.properties <= 100 && budget.enums <= 250 && budget.strings <= 12_000
  }
  return typeof schema === "object" && schema !== null && "type" in schema && schema.type === "object" && node(schema, 1)
}

/** Snapshot supported schemas before provider awaits; lowering may not weaken them silently. */
export function normalize(request: LLMRequest) {
  if (request.responseFormat?.type === "json") {
    assertContractOverlay(request)
    const contract = prepare(request.responseFormat.schema)
    return LLMRequest.update(request, { responseFormat: { type: "json", schema: contract.schema } })
  }
  return normalizeTool(request)
}

/** Normalize a result tool without changing the caller's accepted request profile. */
export function normalizeTool(request: LLMRequest) {
  if (request.responseFormat?.type !== "tool") return request
  assertContractOverlay(request)
  const original = request.responseFormat.tool
  if (original.native && Object.keys(original.native).length)
    throw new Error("Structured result tools cannot be provider-executed tools")
  const tool = new ToolDefinition({ ...original, inputSchema: prepare(original.inputSchema).schema })
  if (!tool.name.trim()) throw new Error("Structured output requires a nonempty tool name")
  const choice = request.toolChoice
  if (choice && choice.type !== "auto" && choice.type !== "required"
    && !(choice.type === "tool" && choice.name === tool.name))
    throw new Error("Structured output conflicts with the requested tool choice")
  const existing = request.tools.filter((item) => item.name === tool.name)
  if (existing.length > 1 || existing.some((item) => !isDeepStrictEqual(item, tool)))
    throw new Error("Structured output conflicts with an existing tool definition")
  return LLMRequest.update(request, {
    tools: existing.length ? request.tools.map((item) => item.name === tool.name ? tool : item) : [...request.tools, tool],
    toolChoice: request.model.route.structuredToolChoice?.(request) === "auto"
      ? ToolChoice.make("auto") : ToolChoice.named(tool.name),
    responseFormat: { type: "tool", tool },
  })
}

function assertContractOverlay(request: LLMRequest) {
  for (const body of [request.model.route.defaults.http?.body, request.http?.body]) {
    if (!body) continue
    if (["tools", "tool_choice", "toolChoice", "toolConfig", "response_format", "responseFormat"].some((key) => Object.hasOwn(body, key)))
      throw new Error("HTTP body overlay conflicts with the structured-output contract")
    for (const [parent, keys] of [
      ["text", ["format"]],
      ["generationConfig", ["responseMimeType", "responseSchema", "responseJsonSchema"]],
    ] as const) {
      if (!Object.hasOwn(body, parent)) continue
      const value = body[parent]
      if (typeof value !== "object" || value === null || keys.some((key) => Object.hasOwn(value, key)))
        throw new Error("HTTP body overlay conflicts with the structured-output contract")
    }
  }
}
