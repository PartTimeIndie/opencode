import { ToolDefinition, type Model } from "@opencode-ai/llm"

const questionItemSchema = {
  type: "object",
  properties: {
    question: { type: "string" },
    type: { type: "string" },
    header: { type: "string" },
    options: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          description: { type: "string" },
        },
        required: ["label"],
        additionalProperties: true,
      },
    },
    multiple: { type: "boolean" },
    allowOther: { type: "boolean" },
    allowFeedback: { type: "boolean" },
    body: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          type: { type: "string" },
          content: { type: "string" },
        },
        additionalProperties: true,
      },
    },
    sections: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    form: { type: "object", additionalProperties: true },
  },
  required: ["question"],
  additionalProperties: true,
} as const

const SURFACE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["blocking", "interactive", "passive"] },
    questions: {
      type: "array",
      items: questionItemSchema,
    },
    sourceFile: {
      type: "object",
      properties: {
        path: { type: "string" },
        sha256: { type: "string" },
        count: { type: "integer" },
      },
      required: ["path", "sha256", "count"],
      additionalProperties: false,
    },
    phase: { type: "string", enum: ["implementation_complete_followup"] },
    version: { type: "integer", enum: [1] },
    controlID: { type: "string" },
    title: { type: "string" },
    markdown: { type: "string" },
    controls: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    values: { type: "object", additionalProperties: true },
    effects: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    actions: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    dock: { type: "boolean" },
  },
  required: ["mode"],
  additionalProperties: true,
} as const

/**
 * Keep the provider-facing Surface schema free of unions and recursive definitions.
 * Several OpenAI-compatible model gateways accept the full registry schema but then
 * emit an empty argument object. The registry definition remains authoritative for
 * settlement and validation, so this compatibility schema can stay permissive.
 */
export function adaptToolDefinitions(_model: Model, definitions: ReadonlyArray<ToolDefinition>) {
  if (!definitions.some((definition) => definition.name === "surface")) return definitions
  return definitions.map((definition) =>
    definition.name === "surface"
      ? new ToolDefinition({
          ...definition,
          inputSchema: SURFACE_INPUT_SCHEMA,
        })
      : definition,
  )
}

/** Apply provider-facing tool compatibility after the final composed SessionRunner request tool list is assembled. */
export function providerFacingRequestTools(model: Model, composedRequestTools: ReadonlyArray<ToolDefinition>) {
  return adaptToolDefinitions(model, composedRequestTools)
}
