import { describe, expect, test } from "bun:test"
import { preserveNullableModelChains } from "./preserve-nullable-model-chains"

describe("preserveNullableModelChains", () => {
  test("adds null to every model chain without widening unrelated chains", () => {
    const source = `export type Session = {
  model?: {
    id: string
    chain?: {
      steps: Array<{ id: string }>
    }
  }
  agent: {
    model: {
      chain?: { id: string }
    }
  }
  config: {
    chain?: { id: string }
  }
}`

    const result = preserveNullableModelChains(source)

    expect(result).toContain("    } | null\n  }")
    expect(result).toContain("      chain?: { id: string } | null")
    expect(result).toContain("    chain?: { id: string }")
    expect(preserveNullableModelChains(result)).toBe(result)
  })

  test("fails if generated SDK types no longer expose model chain fields", () => {
    expect(() => preserveNullableModelChains("export type Session = { id: string }"))
      .toThrow("No generated model.chain type was found")
  })
})
