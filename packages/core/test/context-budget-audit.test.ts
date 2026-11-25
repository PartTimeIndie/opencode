import { expect, test } from "bun:test"
// Match the established Surface tool initialization boundary.
import "../src/session"
import { auditExport } from "../script/source-tool-definition"
import { evaluate } from "../script/context-budget-scenarios"
import { ContextBudget } from "../src/util/context-budget"
import { catalogTrace } from "../script/context-budget-traces"
import { SkillCatalog } from "../src/skill/catalog"

test("audit keeps measurement boundaries explicit and omits raw secrets", () => {
  const report = ContextBudget.audit({
    agents: [
      {
        name: "plan",
        boundary: "materialized-definitions",
        components: [{ id: "global", text: "SECRET-é" }],
        tools: [
          {
            name: "read",
            description: "SECRET-description",
            inputSchema: { description: "SECRET-schema", type: "string" },
          },
        ],
        capturedBody: "SECRET-not-really-captured",
      },
    ],
  })
  const agent = report.agents[0]
  expect(agent.components[0]).toMatchObject({
    chars: 8,
    utf8Bytes: 9,
    estimatedTokens: 2,
    tokenMethod: "estimate:chars/4",
  })
  expect(agent.capturedBody).toBeNull()
  expect(agent.missing).toEqual(["captured-provider-body", "provider-usage", "model-specific-tokenizer"])
  expect(JSON.stringify(report)).not.toContain("SECRET")
})

test("schema measurement preserves property names, required/enums and all constraints", () => {
  const schema = {
    type: "object",
    description: "annotation",
    properties: {
      description: { type: "string", description: "nested annotation", maxLength: 40 },
      code: { enum: ["description", "x"] },
    },
    required: ["description"],
    additionalProperties: false,
    allOf: [{ description: "annotation", minProperties: 1 }],
  }
  expect(ContextBudget.schemaWithoutDescriptions(schema)).toEqual({
    type: "object",
    properties: { description: { type: "string", maxLength: 40 }, code: { enum: ["description", "x"] } },
    required: ["description"],
    additionalProperties: false,
    allOf: [{ minProperties: 1 }],
  })
  expect(schema.description).toBe("annotation")
  expect(ContextBudget.tools([{ name: "surface", inputSchema: schema }])[0].schemaAnnotationBytes).toBeGreaterThan(0)
})

test("budget releases reservations only for validated actual provider usage", () => {
  const budget = new ContextBudget.ModelBudget()
  const id = budget.reserve(100, 20)
  expect(() => budget.settle(id, { input: 101, output: 1 })).toThrow("over-bound")
  expect(budget.used.input).toBe(100)
  budget.settle(id, { input: 60, output: 10 })
  expect(budget.used).toEqual({ requests: 1, input: 60, output: 10 })
  expect(() => budget.settle(id, { input: 0, output: 0 })).toThrow()
})

test("only actual captured body and declared provider usage have that label", () => {
  const agent = ContextBudget.audit({
    agents: [
      {
        name: "build",
        boundary: "captured-provider-body",
        components: [],
        tools: [],
        capturedBody: "{}",
        usage: { input: 20, cachedInput: 10, output: 2 },
      },
    ],
  }).agents[0]
  expect(agent.capturedBody?.utf8Bytes).toBe(2)
  expect(agent.providerUsage).toEqual({ input: 20, cachedInput: 10, output: 2 })
  expect(agent.missing).toEqual(["model-specific-tokenizer"])
})

test("budget reserves before each call including failed requests and cached input", () => {
  const budget = new ContextBudget.ModelBudget({ requests: 2, input: 30, output: 8 })
  budget.reserve(15, 4)
  expect(() => budget.reserve(16, 4)).toThrow("exhausted")
  expect(budget.used).toEqual({ requests: 1, input: 15, output: 4 })
  budget.reserve(15, 4)
  expect(() => budget.reserve(0, 0)).toThrow("exhausted")
  expect(() => new ContextBudget.ModelBudget().reserve(-1, 1)).toThrow("Invalid")
})

test("static audit extracts contracts but not closure-owned execution", () => {
  expect(auditExport('const Input = {}; Tool.make({input: Input, description: "read", execute: danger})')).toContain(
    'description: "read"',
  )
  expect(auditExport('Tool.make({input: hidden, description: "read"})')).toBeUndefined()
  expect(
    auditExport("const Input = {}; Tool.make({input: Input, description: shellDescription(shell)})"),
  ).not.toContain("shellDescription")
})

test("model acceptance assertions do not treat a tool promise as a completed fixture", () => {
  expect(evaluate("multi-topic", [], ["I will load the skills"])).toBe(false)
  expect(
    evaluate("manual-standalone", [{ name: "skill", input: { name: "multi-agent-review" }, result: "Denied" }], []),
  ).toBe(false)
  expect(
    evaluate(
      "multi-topic",
      ["unity-localization", "imagegen"].map((name) => ({
        name: "skill",
        input: { name },
        result: `Fixture skill ${name}: instructions`,
      })),
      [],
    ),
  ).toBe(true)
  expect(
    evaluate(
      "surface",
      [
        {
          name: "surface",
          input: {
            mode: "blocking",
            questions: [{ question: "Color?", options: [{ label: "A" }, { label: "B" }], allowOther: true }],
          },
          result: "Fixture",
        },
      ],
      [],
    ),
  ).toBe(true)
  expect(
    evaluate("surface", [{ name: "surface", input: { mode: "blocking", actions: [] }, result: "invalid" }], []),
  ).toBe(false)
})

test("group navigation is not counted as a full skill load and unsuccessful calls never pass", () => {
  const loads = ["unity-localization", "imagegen"].map((name) => ({
    name: "skill",
    input: { name },
    result: `Fixture skill ${name}: instructions`,
  }))
  const groups = ["unity", "agents"].map((group) => ({
    name: "skill",
    input: { group },
    result: `<skill_group id="${group}" revision="fixture">descriptions</skill_group>`,
  }))
  expect(evaluate("multi-topic", [...groups, ...loads], [])).toBe(true)
  for (const result of [
    "Denied or unknown skill",
    "Unknown group. No flat fallback.",
    "Fixture only; no external action.",
  ])
    expect(evaluate("multi-topic", [...groups, { ...loads[0], result }, loads[1]], [])).toBe(false)
  expect(
    evaluate("multi-topic", [...loads, { name: "skill", input: {}, result: "Fixture only; no external action." }], []),
  ).toBe(false)
  expect(evaluate("rules", [], ["Read gameplay-presentation.md; release-and-mirrors.md is excluded."])).toBe(true)
  expect(
    evaluate(
      "rules",
      [{ name: "read", input: { path: "release-and-mirrors.md" }, result: "Fixture" }],
      ["gameplay-presentation.md"],
    ),
  ).toBe(false)
})

test("calculated all-open final request includes navigation overhead and repeated opening is bounded", () => {
  const leaves: SkillCatalog.Entry[] = ["a", "b", "c"].map((name) => ({
    type: "skill",
    name,
    description: "x".repeat(100),
  }))
  const flat = { revision: "fixture", root: leaves, groups: {}, issues: [] }
  const grouped: SkillCatalog.Catalog = {
    revision: "fixture",
    root: [{ type: "group", name: "family", description: "Family" }],
    groups: { family: leaves },
    issues: [],
  }
  expect(catalogTrace(flat, grouped, []).unopenedSkills).toEqual(["a", "b", "c"])
  const all = catalogTrace(flat, grouped, ["family"])
  expect(all.allGroupsOpened).toBe(true)
  expect(all.unopenedDescriptorChars).toBe(0)
  expect(all.finalRequest.G).toBeGreaterThan(all.finalRequest.F)
  const repeated = catalogTrace(flat, grouped, ["family", "family"])
  expect(repeated.repeatedOpenings).toBe(1)
  expect(repeated.expansions[1].resultChars).toBeLessThan(repeated.expansions[0].resultChars)
  expect(() => catalogTrace(flat, grouped, ["missing"])).toThrow("Unknown group")
})
