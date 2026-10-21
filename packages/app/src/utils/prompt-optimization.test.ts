import { describe, expect, test } from "bun:test"
import { buildPromptOptimization, compactVerifierContext } from "./prompt-optimization"

const enabled = {
  optimizationProfile: "safe" as const,
  toolContextCompression: true,
  externalContextReduction: true,
  sourceTestContextPack: true,
  compactVerifierContext: true,
  selfTestPolicy: true,
  coreSearchLimits: true,
  toolMaterializationCache: false,
  runnerRequestMetrics: true,
  sessionTabPrefetch: true,
}

describe("prompt optimization", () => {
  test("builds system guidance for enabled optimizations", () => {
    const result = buildPromptOptimization({
      text: "fix the failing test",
      settings: enabled,
      contextFileCount: 2,
      fileAttachmentCount: 1,
    })

    expect(result.system).toContain("OpenCode optimization profile enabled")
    expect(result.system).toContain("Optimization profile: safe")
    expect(result.system).toContain("Session continuity after context compaction")
    expect(result.system).toContain("continue in-progress work instead of asking the user to repeat prior context")
    expect(result.system).toContain("External context reduction")
    expect(result.system).toContain("Source/test context pack")
    expect(result.system).toContain("Self-test policy")
    expect(result.system).toContain("Tool-context compression")
    expect(result.system).toContain("tool_context_compression")
    expect(result.system).not.toContain("skip-tests")
    expect(result.requestText).toBeUndefined()
  })

  test("no longer advertises retired request-path features", () => {
    const result = buildPromptOptimization({
      text: "fix the failing test",
      settings: enabled,
      contextFileCount: 2,
      fileAttachmentCount: 1,
    })

    expect(result.system).not.toContain("deferred_tool_discovery")
    expect(result.system).not.toContain("Deferred tool discovery")
    expect(result.system).not.toContain("compact_tool_schemas")
    expect(result.system).not.toContain("Compact tool schemas")
    expect(result.system).not.toContain("patch_verify_tool")
    expect(result.system).not.toContain("Patch verify tool")
    expect(result.system).not.toContain("batch_core_tools")
    expect(result.system).not.toContain("Batch core tools")
    expect(result.system).not.toContain("Read deduplication")
  })

  test("omits disabled optimization rules", () => {
    const result = buildPromptOptimization({
      text: "fix the failing test",
      settings: { ...enabled, externalContextReduction: false, toolContextCompression: false },
      contextFileCount: 0,
      fileAttachmentCount: 0,
    })

    expect(result.system).not.toContain("External context reduction")
    expect(result.system).not.toContain("Tool-context compression")
    expect(result.system).toContain("Self-test policy")
  })

  test("disables optimization guidance when the profile is off", () => {
    const result = buildPromptOptimization({
      text: "fix the failing test",
      settings: { ...enabled, optimizationProfile: "off" },
      contextFileCount: 2,
      fileAttachmentCount: 1,
    })

    expect(result.system).toBeUndefined()
    expect(result.requestText).toBeUndefined()
    expect(result.compactedVerifierContext).toBe(false)
  })

  test("compacts long verifier logs while keeping diagnostics", () => {
    const log = [
      "Please fix this.",
      ...Array.from({ length: 120 }, (_, index) => `INFO setup noise ${index}`),
      "Traceback (most recent call last):",
      '  File "tests/test_example.py", line 10, in test_value',
      "AssertionError: expected 1 got 2",
      ...Array.from({ length: 900 }, (_, index) => `DEBUG more noise ${index}`),
      "FAILED tests/test_example.py::test_value",
    ].join("\n")
    const result = compactVerifierContext(log)

    expect(result.compacted).toBe(true)
    expect(result.text?.length).toBeLessThan(log.length)
    expect(result.text).toContain("AssertionError")
    expect(result.text).toContain("FAILED tests/test_example.py::test_value")
  })

  test("preserves user instructions outside noisy verifier output", () => {
    const instruction = "IMPORTANT: keep the public parser API backwards compatible."
    const log = [
      "Fix the failing verifier.",
      ...Array.from({ length: 360 }, (_, index) => `INFO test runner noise ${index}`),
      instruction,
      ...Array.from({ length: 360 }, (_, index) => `DEBUG dependency cache line ${index}`),
      "Traceback (most recent call last):",
      '  File "tests/test_parser.py", line 22, in test_parser_api',
      "AssertionError: parser output changed",
      ...Array.from({ length: 360 }, (_, index) => `WARN teardown noise ${index}`),
      "FAILED tests/test_parser.py::test_parser_api",
    ].join("\n")

    const result = compactVerifierContext(log)

    expect(result.compacted).toBe(true)
    expect(result.text?.length).toBeLessThan(log.length)
    expect(result.text).toContain(instruction)
    expect(result.text).toContain("AssertionError: parser output changed")
  })
})
