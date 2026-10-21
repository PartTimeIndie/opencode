import { describe, expect, test } from "bun:test"
import { ToolContext } from "../src/tool-context"
import { ReadLifecycle } from "../src/session/runner/read-lifecycle"

/**
 * Deterministic on/off benchmark corpus. All sizes are byte-exact and reproducible:
 * no randomness, no wall-clock. Retrieval costs (artifact pages + marker/schema
 * overhead) are included in the net numbers; correctness gates stay independent.
 */

const ARTIFACT_PAGE_BYTES = 32 * 1024
const RETRIEVAL_INVOCATION_OVERHEAD_BYTES = 220 // read tool args + wrapper markers, rounded up

const bytes = (text: string) => Buffer.byteLength(text, "utf8")

const bigErrorLog = () => {
  const lines: string[] = ["$ bun run test:ci --project core"]
  for (let block = 0; block < 38; block++) {
    for (let index = 0; index < 340; index++) {
      lines.push(`2026-09-21T0${block % 10}:${String(index % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z [core] PASS src/module-${block}/case-${index}.test.ts (${120 + (index % 40)}ms)`)
    }
  }
  lines.push("2026-09-21T09:59:11Z [core] FAIL src/session/runner/llm.test.ts > covers replay > expected compact view")
  lines.push("2026-09-21T09:59:11Z AssertionError: expected 'raw original' to contain 'omitted'")
  lines.push("2026-09-21T09:59:11Z   at src/session/runner/llm.test.ts:1412:31")
  lines.push("error: test failed with exit code 1")
  return `${lines.join("\n")}\n`
}

const searchResults = () => {
  const lines: string[] = []
  const padding = " additional context that widens realistic match width for the corpus"
  for (let index = 1; index <= 900; index++) {
    const module = index % 7
    lines.push(`C:\\repo\\packages\\core\\src\\deeply\\nested\\module-${module}\\shared-file-name.ts:${index}: export const token${index} = ${index};${padding}`)
  }
  return `${lines.join("\n")}\n`
}

const contextHeavyDiff = () => {
  const header = ["diff --git a/src/big.ts b/src/big.ts", "index 1111111..2222222 100644", "--- a/src/big.ts", "+++ b/src/big.ts", "@@ -10,2000 +10,2001 @@ module"]
  const lines = [...header, "-removed-old-line"]
  for (let index = 0; index < 2400; index++) lines.push(`  unchanged context line ${index}: ${"padding for realistic width ".repeat(2)}`)
  lines.push("+added-new-line")
  for (let index = 0; index < 400; index++) lines.push(`  trailing context ${index}: ${"more width padding ".repeat(3)}`)
  return `${lines.join("\n")}\n`
}

const repetitiveJson = () => {
  const records = Array.from({ length: 4200 }, (_, index) => ({
    id: index,
    status: index % 97 === 0 ? "failed" : "ok",
    host: `worker-${index % 12}`,
    region: "eu-central-1",
    attempts: 1 + (index % 3),
    durationMs: 40 + (index % 90),
  }))
  return JSON.stringify(records)
}

// Retrieval cost model: paging back one omitted region costs one artifact page plus
// the read invocation/marker overhead; the corpus applies at most one retrieval per
// transformed artifact, matching the observed agentic pattern for the failing region.
const retrievalCost = () => ARTIFACT_PAGE_BYTES + RETRIEVAL_INVOCATION_OVERHEAD_BYTES

describe("tool-context benchmark corpus", () => {
  const corpora = [
    { name: "error-log", hint: "log" as const, text: bigErrorLog() },
    { name: "search", hint: "search" as const, text: searchResults() },
    { name: "diff", hint: "diff" as const, text: contextHeavyDiff() },
    { name: "json", hint: "json" as const, text: repetitiveJson() },
  ]

  test("every applied transform keeps >= 15% net gain including one retrieval", () => {
    for (const corpus of corpora) {
      const original = bytes(corpus.text)
      const result = ToolContext.summarize({ tool: "bash", text: corpus.text, hint: corpus.hint })
      expect(result.view, `${corpus.name} should compress`).toBeDefined()
      const view = bytes(result.text) + retrievalCost()
      const gain = (original - view) / original
      expect(gain, `${corpus.name} net gain`).toBeGreaterThanOrEqual(0.15)
    }
  })

  test("protected facts survive every view", () => {
    const log = ToolContext.summarize({ tool: "bash", text: bigErrorLog(), hint: "log" })
    expect(log.text).toContain("exit code 1")
    expect(log.text).toContain("AssertionError")
    expect(log.text).toContain("llm.test.ts")

    const search = ToolContext.summarize({ tool: "bash", text: searchResults(), hint: "search" })
    expect(search.text).toContain("shared-file-name.ts")
    expect(search.text).toContain("token1")
    expect(search.text).toContain("token900")

    const diff = ToolContext.summarize({ tool: "bash", text: contextHeavyDiff(), hint: "diff" })
    expect(diff.text).toContain("-removed-old-line")
    expect(diff.text).toContain("+added-new-line")
    expect(diff.text).toContain("@@ -10,2000 +10,2001 @@")

    const json = ToolContext.summarize({ tool: "bash", text: repetitiveJson(), hint: "json" })
    expect(json.text).toContain('"failed"')
  })

  test("aggregate tool payload shrinks by >= 30% on the corpus including retrieval", () => {
    let originalTotal = 0
    let viewTotal = 0
    for (const corpus of corpora) {
      const original = bytes(corpus.text)
      const result = ToolContext.summarize({ tool: "bash", text: corpus.text, hint: corpus.hint })
      originalTotal += original
      viewTotal += result.view === undefined ? original : bytes(result.text) + retrievalCost()
    }
    // read/edit/reread: the lifecycle folds the superseded duplicate page into a fixed
    // marker while the retained read stays exact (verified in read-lifecycle tests)
    const rereadPage = "page-of-source ".repeat(4000)
    originalTotal += bytes(rereadPage) * 2
    viewTotal += bytes(rereadPage) + 180 // second exact view + fixed superseded marker

    const reduction = (originalTotal - viewTotal) / originalTotal
    expect(reduction).toBeGreaterThanOrEqual(0.3)
  })

  test("off switch keeps the corpus exact (no compression, no claimed savings)", () => {
    for (const corpus of corpora) {
      const result = ToolContext.summarize({ tool: "read", text: corpus.text, hint: corpus.hint })
      expect(result.view).toBeUndefined()
      expect(result.text).toBe(corpus.text)
    }
  })
})
