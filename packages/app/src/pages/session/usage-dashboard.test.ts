import { describe, expect, test } from "bun:test"
import type { GlobalSession } from "@opencode-ai/sdk/v2/client"
import { applyLimit, buildSummary, parseModelLimit } from "./usage-dashboard-model"

describe("buildSummary", () => {
  test("aggregates tokens, cost, agents, models, and active agent state", () => {
    const summary = buildSummary(
      [
        session({ id: "a", agent: "build", cost: 0.25, input: 10, output: 5, reasoning: 3, cacheRead: 2 }),
        session({ id: "b", agent: "plan", cost: 0.5, input: 4, output: 6, providerID: "anthropic" }),
      ],
      {},
      undefined,
      [{ agent: "build" }],
    )

    expect(summary.sessionCount).toBe(2)
    expect(summary.totalTokens).toBe(30)
    expect(summary.totalCost).toBe(0.75)
    expect(summary.agents[0]).toMatchObject({ name: "build", active: true, activeSessions: 1, tokens: 20 })
    expect(summary.models.map((row) => row.name)).toEqual(["openai/model-a", "anthropic/model-b"])
  })

  test("filters sessions before the selected range start", () => {
    const summary = buildSummary(
      [session({ id: "old", updated: 1_000, input: 100 }), session({ id: "new", updated: 2_000, input: 5 })],
      {},
      1_500,
      [],
    )

    expect(summary.sessionCount).toBe(1)
    expect(summary.totalTokens).toBe(5)
    expect(summary.agents).toHaveLength(1)
  })

  test("prefills fixed ranges and reports no daily usage for empty data", () => {
    const summary = buildSummary([], { days: 7 }, undefined, [])

    expect(summary.daily).toHaveLength(7)
    expect(summary.hasDailyUsage).toBe(false)
  })

  test("aggregates more than eight distinct models without dropping rows", () => {
    const sessions = Array.from({ length: 12 }, (_, index) =>
      session({ id: `m${index}`, providerID: "openai", modelID: `gpt-6-astra-${index}`, input: 1000 - index }),
    )
    const summary = buildSummary(sessions, {}, undefined, [])

    expect(summary.models).toHaveLength(12)
    expect(summary.models[0]!.name).toBe("openai/gpt-6-astra-0")
  })
})

describe("applyLimit", () => {
  const rows = Array.from({ length: 12 }, (_, index) => index)

  test("slices numeric limits and preserves order", () => {
    expect(applyLimit(rows, 8)).toHaveLength(8)
    expect(applyLimit(rows, 8)[0]).toBe(0)
    expect(applyLimit(rows, 50)).toHaveLength(12)
  })

  test("returns every row for all", () => {
    expect(applyLimit(rows, "all")).toHaveLength(12)
    expect(applyLimit([], "all")).toHaveLength(0)
  })
})

describe("parseModelLimit", () => {
  test("parses known limits", () => {
    expect(parseModelLimit("8")).toBe(8)
    expect(parseModelLimit("20")).toBe(20)
    expect(parseModelLimit("50")).toBe(50)
    expect(parseModelLimit("all")).toBe("all")
  })

  test("falls back to the default 8 for unknown values", () => {
    expect(parseModelLimit("12")).toBe(8)
    expect(parseModelLimit("")).toBe(8)
    expect(parseModelLimit("everything")).toBe(8)
  })
})

function session(input: {
  id: string
  agent?: string
  cost?: number
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
  providerID?: string
  modelID?: string
  updated?: number
}) {
  return {
    id: input.id,
    slug: input.id,
    projectID: "project-a",
    directory: "C:/repo/project-a",
    cost: input.cost ?? 0,
    tokens: {
      input: input.input ?? 0,
      output: input.output ?? 0,
      reasoning: input.reasoning ?? 0,
      cache: {
        read: input.cacheRead ?? 0,
        write: input.cacheWrite ?? 0,
      },
    },
    title: input.id,
    agent: input.agent,
    model: {
      id: input.modelID ?? (input.providerID === "anthropic" ? "model-b" : "model-a"),
      providerID: input.providerID ?? "openai",
    },
    version: "test",
    time: {
      created: input.updated ?? 1_700_000_000_000,
      updated: input.updated ?? 1_700_000_000_000,
    },
    project: {
      id: "project-a",
      name: "Project A",
      worktree: "C:/repo/project-a",
    },
  } satisfies GlobalSession
}
