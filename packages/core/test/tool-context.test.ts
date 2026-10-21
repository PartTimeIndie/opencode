import { describe, expect, test } from "bun:test"
import { ToolContext } from "../src/tool-context"
import { ViewCache } from "../src/tool-context/cache"

const bigLog = () => {
  const lines: string[] = ["$ bun test"]
  for (let index = 0; index < 300; index++) lines.push(`⠙ running suite ${Math.floor(index / 30)} (${Math.floor((index / 300) * 100)}%)`)
  for (let index = 0; index < 20; index++) lines.push(`WARN deprecated request shape (${index % 3}) retrying`)
  lines.push("ERROR connect ECONNREFUSED 127.0.0.1:3001 at src/a.ts:12")
  lines.push("ERROR connect ECONNREFUSED 127.0.0.1:3002 at src/b.ts:30")
  lines.push("Traceback (most recent call last):")
  lines.push('  File "src/c.ts", line 9, in run')
  lines.push("AssertionError: expected 4 to equal 5")
  for (let index = 0; index < 260; index++) lines.push(`at frame ${index} (src/generated.ts:${index})`)
  lines.push(" 42 pass")
  lines.push(" 1 fail")
  lines.push("Ran 43 tests in 2.1s")
  lines.push("error: test failed with exit code 1")
  return `${lines.join("\n")}\n`
}

describe("ToolContext.summarize", () => {
  test("compresses noisy logs while preserving distinct errors, tracebacks and summaries", () => {
    const text = bigLog()
    const result = ToolContext.summarize({ tool: "bash", text })
    expect(result.view).toBeDefined()
    expect(result.view?.processor).toBe("logs")
    expect(result.text).toContain("AssertionError: expected 4 to equal 5")
    expect(result.text).toContain("127.0.0.1:3001")
    expect(result.text).toContain("127.0.0.1:3002")
    expect(result.text).toContain("exit code 1")
    expect(result.text).toContain("omitted")
    expect(result.view?.omissions[0]?.kind).toBe("log-lines")
    expect(result.view?.omissions[0]?.count).toBeGreaterThan(0)
    const gain = 1 - Buffer.byteLength(result.text, "utf8") / Buffer.byteLength(text, "utf8")
    expect(gain).toBeGreaterThanOrEqual(ToolContext.MIN_GAIN_RATIO)
  })

  test("is deterministic for identical input", () => {
    const text = bigLog()
    expect(ToolContext.summarize({ tool: "bash", text })).toEqual(ToolContext.summarize({ tool: "bash", text }))
  })

  test("keeps low-redundancy logs exact (no-gain fallback without claimed savings)", () => {
    const lines: string[] = ["$ cmd"]
    for (let index = 0; index < 44; index++)
      lines.push(`ERROR unique failure ${index}: ${"detail ".repeat(30)} reference-${index}`)
    const text = `${lines.join("\n")}\n`
    const result = ToolContext.summarize({ tool: "bash", text })
    expect(result.view).toBeUndefined()
    expect(result.text).toBe(text)
  })

  test("passes through small and excluded tool output", () => {
    expect(ToolContext.summarize({ tool: "bash", text: "short".repeat(100) }).view).toBeUndefined()
    const text = `${"x".repeat(200)}\n`.repeat(200)
    expect(ToolContext.summarize({ tool: "surface", text }).view).toBeUndefined()
    expect(ToolContext.summarize({ tool: "read", text }).view).toBeUndefined()
  })

  test("groups search results, preserves Windows drive paths, line numbers and duplicate counts", () => {
    const lines: string[] = []
    const padding = " additional context for realistic match width"
    for (let index = 1; index <= 50; index++)
      lines.push(`C:\\repo\\pre-commit-config.yaml:${index}: export const value${index} = ${index}${padding}`)
    for (let index = 1; index <= 50; index++) lines.push(`src/dashed-file-name.ts:${index}: match-${index}${padding}`)
    for (let index = 1; index <= 10; index++) lines.push(`src/dashed-file-name.ts:5: exact duplicate${padding}`)
    const text = `${lines.join("\n")}\n`
    const result = ToolContext.summarize({ tool: "grep", text })
    expect(result.view?.processor).toBe("search")
    expect(result.text).toContain("C:\\repo\\pre-commit-config.yaml")
    expect(result.text).toContain("src/dashed-file-name.ts")
    expect(result.text).toContain("duplicate")
    expect(result.text).toContain("omitted")
    expect(result.text).toContain("value1")
    expect(result.text).toContain("value50")
  })

  test("collapses only unchanged diff context and never drops changed lines", () => {
    const header = [
      "diff --git a/big.ts b/big.ts",
      "index 111..222 100644",
      "--- a/big.ts",
      "+++ b/big.ts",
      "@@ -10,80 +10,81 @@ module",
    ]
    const lines = [...header, "-removed-one"]
    for (let index = 0; index < 60; index++) lines.push(` unchanged context line ${index} ${"padding ".repeat(12)}`)
    lines.push("+added-one")
    for (let index = 0; index < 12; index++) lines.push(` trailing context ${index} ${"padding ".repeat(12)}`)
    const text = `${lines.join("\n")}\n`
    const result = ToolContext.summarize({ tool: "bash", text, hint: "diff" })
    expect(result.view?.processor).toBe("diff")
    expect(result.text).toContain("-removed-one")
    expect(result.text).toContain("+added-one")
    expect(result.text).toContain("unchanged context lines omitted")
    expect(result.text).not.toContain("unchanged context line 10")
    expect(result.text).toContain("@@ -10,80 +10,81 @@")
  })

  test("rejects malformed diffs", () => {
    const text = `${"not a diff\n".repeat(400)}`
    expect(ToolContext.summarize({ tool: "bash", text, hint: "diff" }).view).toBeUndefined()
  })

  test("compresses repetitive JSON arrays with head/tail retention and duplicate counting", () => {
    const records = Array.from({ length: 500 }, (_, index) => ({ id: index, status: "ok", host: "same" }))
    records.push({ ...records[10] })
    const text = JSON.stringify(records)
    const result = ToolContext.summarize({ tool: "bash", text, hint: "json" })
    expect(result.view?.processor).toBe("json")
    expect(result.text).toContain('"id": 0')
    expect(result.text).toContain('"id": 499')
    expect(result.text).toContain("duplicates collapsed")
    expect(result.text).toContain("records omitted")
    expect(result.view?.omissions.some((omission) => omission.kind === "json-duplicates")).toBe(true)
  })

  test("does not compress unparseable JSON", () => {
    const text = `${"[{broken".repeat(2000)}`
    expect(ToolContext.summarize({ tool: "bash", text, hint: "json" }).view).toBeUndefined()
  })

  test("routes MCP/plugin outputs through generic detection without trusted hints", () => {
    const records = Array.from({ length: 400 }, (_, index) => ({ id: index, status: "ok", region: "eu-1" }))
    const mcpJson = JSON.stringify(records)
    // Unknown tool name: no hint, JSON detected conservatively
    const mcpResult = ToolContext.summarize({ tool: "githubserver_list_deployments", text: mcpJson })
    expect(mcpResult.view?.processor).toBe("json")
    expect(mcpResult.text).toContain('"id": 0')
    // Plugin tool with log-shaped text: generic log detection
    const pluginLines = ["$ deploy"]
    for (let index = 0; index < 300; index++) pluginLines.push(`step ${index}: retrying transient warning`)
    pluginLines.push("ERROR quota exceeded for project acme")
    const pluginResult = ToolContext.summarize({ tool: "vendor-x_deploy_runner", text: `${pluginLines.join("\n")}\n` })
    expect(pluginResult.view?.processor).toBe("logs")
    expect(pluginResult.text).toContain("quota exceeded for project acme")
  })

  test("keeps opaque MCP/plugin payloads exact", () => {
    // Neither log/search/diff shaped nor valid JSON: passthrough with zero claimed savings
    const opaque = `${Array.from({ length: 300 }, (_, index) => `~${index}#${index.toString(16)}?`).join(" ")}\n`
    const result = ToolContext.summarize({ tool: "unknownserver_binary_blob", text: opaque })
    expect(result.view).toBeUndefined()
    expect(result.text).toBe(opaque)
  })
})

describe("ViewCache", () => {
  test("stores, expires and evicts least-recently-used entries within bounds", () => {
    const cache = new ViewCache(2, 1024 * 1024, 1000)
    cache.set("a", "value-a", 0)
    expect(cache.get("a", 10)).toBe("value-a")
    expect(cache.get("a", 2000)).toBeUndefined()
    cache.set("a", "value-a", 2000)
    cache.set("b", "value-b", 2001)
    cache.get("a", 2002)
    cache.set("c", "value-c", 2003)
    expect(cache.get("b", 2004)).toBeUndefined()
    expect(cache.get("a", 2005)).toBe("value-a")
    expect(cache.get("c", 2005)).toBe("value-c")
  })
})
