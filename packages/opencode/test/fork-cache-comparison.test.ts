import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { cacheBudget } from "../script/fork-cache-budget"
import { compare, limits, wirePrefix } from "../script/fork-cache-comparison"

const body = (role: string, options = {}) => JSON.stringify({ model: "fixture", instructions: "fixed", tools: [], ...options,
  input: [{ role: "user", content: "shared" }, { role: "user", content: role }] })

test("cache comparison validates the inclusive attempt and estimate bounds", () => {
  for (const count of [0, 1, 17, 2.5, NaN]) expect(() => limits(count, 4096)).toThrow()
  for (const tokens of [1023, 8193, NaN]) expect(() => limits(2, tokens)).toThrow()
  expect(limits(16, 8192)).toEqual({ maxRequests: 16, targetInputTokens: 8192 })
})

test("serialized wire comparison checks all non-dialogue options without exporting bodies", () => {
  expect(wirePrefix(body("main"), body("child"))).toMatchObject({ entries: 1 })
  expect(wirePrefix(body("main"), body("child")).sha256).toMatch(/^[a-f0-9]{64}$/)
  for (const options of [{ model: "other" }, { instructions: "other" }, { tools: [{}] }, { reasoning: { effort: "low" } }])
    expect(() => wirePrefix(body("main"), body("child", options))).toThrow()
  expect(() => wirePrefix("{}", "{}")).toThrow()
  expect(() => wirePrefix(body("main"), JSON.stringify({ model: "fixture", instructions: "fixed", tools: [], input: ["other"] }))).toThrow()
})

test("declared seed/child pairs use fresh families and stop within the total cap", async () => {
  const seen: { family: string; prefix: string; role: string }[] = []
  const result = await compare({ maxRequests: 4, targetInputTokens: 4096, send: async (input) => {
    seen.push(input)
    return { body: body(input.role), inputTokens: 4096, cacheReadInputTokens: input.role === "main" ? 0 : 3584 }
  } })
  expect(result.accepted).toBe(true)
  expect(result.samples).toHaveLength(4)
  expect(result.prefixes).toHaveLength(2)
  expect(seen[0]?.family).toBe(seen[1]?.family)
  expect(seen[2]?.family).not.toBe(seen[0]?.family)
  expect(seen[0]?.prefix).toBe(seen[1]?.prefix)
  expect(seen[0]?.prefix.length).toBe(4096 * 4)
})

for (const failure of ["seed-unknown", "child-unknown", "low", "network", "wire"])
  test(`cache comparison does not retry after ${failure}`, async () => {
    let attempts = 0
    const result = await compare({ maxRequests: 16, targetInputTokens: 4096, send: async ({ role }) => {
      attempts++
      if (failure === "network") throw new Error("must not appear in the report")
      return { body: body(role, failure === "wire" && role === "child" ? { model: "drift" } : {}),
        inputTokens: 4096, cacheReadInputTokens: failure === "seed-unknown" || failure === "child-unknown" && role === "child"
          ? undefined : role === "main" ? 0 : failure === "low" ? 0 : 3584 }
    } })
    expect(result.accepted).toBe(false)
    expect(attempts).toBe(failure === "network" || failure === "seed-unknown" ? 1 : 2)
    expect(result.samples).toHaveLength(attempts)
    expect(JSON.stringify(result)).not.toContain("must not appear")
    if (failure === "low" || failure === "child-unknown") expect(result.prefixes).toHaveLength(1)
    if (failure === "wire") expect(result.reason).toBe("wire-verification-failed")
  })

test("durable cache budget reserves before transport, refuses restart and never refunds failed attempts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cache-budget-"))
  const approval = path.join(root, "approval.json")
  const input = { approval, sessionID: "session", credentialID: "reference", modelID: "fixture", variant: "high", maxRequests: 2, targetInputTokens: 4096 }
  try {
    await writeFile(approval, JSON.stringify({ version: 1, sessionID: input.sessionID, oauthException: {
      providerID: "openai", modelID: input.modelID, variant: input.variant, credentialID: input.credentialID,
      maxRequests: 16, targetInputTokens: 4096, externalRequestsUsed: 0,
    } }))
    expect(() => cacheBudget({ ...input, modelID: "fallback" })).toThrow()
    expect(() => cacheBudget({ ...input, maxRequests: 17 })).toThrow()
    const budget = cacheBudget(input)
    expect(budget.used).toBe(0)
    expect(budget.reserve()).toBe(1)
    expect(JSON.parse(await readFile(`${approval}.cache-series/request-1.json`, "utf8"))).toMatchObject({ ordinal: 1, state: "consumed-before-transport" })
    expect(() => cacheBudget(input)).toThrow()
    expect(budget.reserve()).toBe(2)
    expect(() => budget.reserve()).toThrow()
    expect(budget.used).toBe(2)
    expect((await readdir(`${approval}.cache-series`)).sort()).toEqual(["request-1.json", "request-2.json", "scope.json"])
  } finally { await rm(root, { recursive: true, force: true }) }
})
