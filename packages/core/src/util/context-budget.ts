export * as ContextBudget from "./context-budget"

import { createHash } from "node:crypto"

export const measure = (text: string) => ({
  chars: text.length,
  utf8Bytes: Buffer.byteLength(text, "utf8"),
  estimatedTokens: Math.round(text.length / 4),
  tokenMethod: "estimate:chars/4" as const,
  sha256: createHash("sha256").update(text).digest("hex"),
})

type Tool = { name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown }

// Strip only annotation keywords at schema positions, never a property named "description".
export function schemaWithoutDescriptions(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => key !== "description" && key !== "$comment")
      .map(([key, value]) => {
        if (
          ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"].includes(key) &&
          value &&
          typeof value === "object"
        )
          return [
            key,
            Object.fromEntries(Object.entries(value).map(([name, child]) => [name, schemaWithoutDescriptions(child)])),
          ]
        if (
          [
            "items",
            "additionalProperties",
            "contains",
            "not",
            "if",
            "then",
            "else",
            "propertyNames",
            "unevaluatedProperties",
          ].includes(key)
        )
          return [key, schemaWithoutDescriptions(value)]
        if (["oneOf", "anyOf", "allOf", "prefixItems"].includes(key) && Array.isArray(value))
          return [key, value.map(schemaWithoutDescriptions)]
        return [key, value]
      }),
  )
}

export function tools(tools: ReadonlyArray<Tool>) {
  return tools.map((tool) => {
    const schema = JSON.stringify(tool.inputSchema ?? {})
    const structural = JSON.stringify(schemaWithoutDescriptions(tool.inputSchema ?? {}))
    return {
      name: tool.name,
      description: measure(tool.description ?? ""),
      inputSchema: measure(schema),
      inputSchemaWithoutDescriptions: measure(structural),
      schemaAnnotationBytes: Buffer.byteLength(schema) - Buffer.byteLength(structural),
      outputSchema: measure(JSON.stringify(tool.outputSchema ?? {})),
    }
  })
}

export type Fixture = {
  agents: ReadonlyArray<{
    name: string
    boundary: "materialized-definitions" | "prepared-runner" | "captured-provider-body"
    components: ReadonlyArray<{ id: string; text: string }>
    tools: ReadonlyArray<Tool>
    // Supplied only by an actual captured request, never reconstructed from components.
    capturedBody?: string
    usage?: { input: number; cachedInput: number; output: number }
  }>
}

export function audit(fixture: Fixture) {
  return {
    version: "context-budget-audit/v1",
    warning:
      "Character estimates are not tokenizer counts. Component estimates are not additive. Prepared runner definitions are not an HTTP body. Cached input still occupies context.",
    agents: fixture.agents.map((agent) => ({
      name: agent.name,
      boundary: agent.boundary,
      components: agent.components.map((component) => ({ id: component.id, ...measure(component.text) })),
      tools: tools(agent.tools),
      definitions: measure(JSON.stringify(agent.tools)),
      capturedBody:
        agent.boundary === "captured-provider-body" && agent.capturedBody !== undefined
          ? measure(agent.capturedBody)
          : null,
      providerUsage: agent.usage ?? null,
      missing: [
        ...(agent.boundary !== "captured-provider-body" || agent.capturedBody === undefined
          ? ["captured-provider-body"]
          : []),
        ...(!agent.usage ? ["provider-usage"] : []),
        "model-specific-tokenizer",
      ],
    })),
  }
}

export type Allowance = { requests: number; input: number; output: number }
export class ModelBudget {
  readonly used: Allowance = { requests: 0, input: 0, output: 0 }
  private readonly pending = new Map<number, { input: number; output: number }>()
  settle(id: number, usage: { input: number; output: number }) {
    const reserved = this.pending.get(id)
    if (
      !reserved ||
      ![usage.input, usage.output].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      usage.input > reserved.input ||
      usage.output > reserved.output
    )
      throw new Error("Invalid or over-bound provider usage; stop model checks")
    this.used.input -= reserved.input - usage.input
    this.used.output -= reserved.output - usage.output
    this.pending.delete(id)
  }
  constructor(
    readonly limit: Allowance = { requests: 24, input: 750000, output: 40000 },
    prior: Allowance = { requests: 0, input: 0, output: 0 },
  ) {
    if (
      Object.entries(prior).some(
        ([key, value]) => !Number.isSafeInteger(value) || value < 0 || value > limit[key as keyof Allowance],
      )
    )
      throw new Error("Invalid prior model budget")
    Object.assign(this.used, prior)
  }
  reserve(inputUpperBound: number, outputLimit: number) {
    if (![inputUpperBound, outputLimit].every((value) => Number.isSafeInteger(value) && value >= 0))
      throw new Error("Invalid model reservation")
    if (
      this.used.requests + 1 > this.limit.requests ||
      this.used.input + inputUpperBound > this.limit.input ||
      this.used.output + outputLimit > this.limit.output
    )
      throw new Error("Model test budget exhausted")
    // Failed requests retain their reservation. Only validated actual usage may release it.
    this.used.requests++
    this.used.input += inputUpperBound
    this.used.output += outputLimit
    this.pending.set(this.used.requests, { input: inputUpperBound, output: outputLimit })
    return this.used.requests
  }
}
