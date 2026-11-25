import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigDelegation } from "@opencode-ai/core/config/delegation"
import { Config } from "@opencode-ai/core/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigMigrateV1 } from "@opencode-ai/core/v1/config/migrate"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { DelegationPreferences } from "@opencode-ai/core/session/delegation-preferences"

const candidates = [
  { agent: "reader", model: "fixture/a", variant: "medium" },
  { agent: "builder", model: "fixture/b", chain: "configured-chain" },
  { agent: "builder", model: "fixture/a", variant: "high" },
]

describe("DelegationPreferences", () => {
  test("retains each config document's binding rules and origin instead of only the latest block", () => {
    const layers = DelegationPreferences.documentLayers([
      new Config.Document({ type: "document", path: "global.json", info: new Config.Info({ delegation: { rules: [{ allowed: [{ agent: "reader" }] }] } }) }),
      new Config.Directory({ type: "directory", path: AbsolutePath.make("/project") }),
      new Config.Document({ type: "document", path: "project.json", info: new Config.Info({ delegation: { rules: [{ allowed: [{ agent: "builder" }] }] } }) }),
    ])
    const result = DelegationPreferences.resolveLayers({ layers, candidates, topics: [] })
    expect(result.impossible).toBe(true)
    expect(result.rules.map((entry) => entry.source)).toEqual(["project.json", "global.json"])
    expect(result.rules.map((entry) => entry.scope)).toEqual(["project", "global"])
  })
  test("preserves the same validated delegation values across V1 and V2 config", () => {
    const delegation = { ordinaryQuestions: false,
      preferences: [{ topic: "code", selections: [{ chain: "configured-chain" }] }],
      rules: [{ allowed: [{ agent: "builder" }] }] }
    const legacy = Schema.decodeUnknownSync(ConfigV1.Info)({ delegation })
    expect(legacy.delegation).toEqual(delegation)
    expect(Schema.decodeUnknownSync(Config.Info)(ConfigMigrateV1.migrate(legacy)).delegation).toEqual(delegation)
    expect(Schema.is(Config.Info)({ delegation: { ordinaryQuestions: "off" } })).toBe(false)
  })
  test("keeps advisory choices separate from hard rules across mixed topics", () => {
    const result = DelegationPreferences.resolve({ candidates, topics: ["code", "review"],
      global: { rules: [{ allowed: [{ agent: "builder" }] }] },
      project: { rules: [{ topic: "review", allowed: [{ model: "fixture/a" }] }] },
      session: { ordinaryQuestions: false, preferences: [{ topic: "code", selections: [{ agent: "reader" }] }] },
      task: { preferences: [{ topic: "review", selections: [{ variant: "high" }] }] },
    })
    expect(result.ordinaryQuestions).toBe(false)
    expect(result.candidates).toEqual([candidates[2]])
    expect(result.preferences.map((entry) => entry.scope)).toEqual(["task", "session"])
    expect(result.rules.map((entry) => entry.scope)).toEqual(["project", "global"])
    expect(result.impossible).toBe(false)
  })

  test("does not let an inner hard rule loosen an outer rule or invent a fallback", () => {
    const result = DelegationPreferences.resolve({ candidates, topics: ["code"],
      global: { rules: [{ allowed: [{ agent: "reader" }] }] },
      task: { rules: [{ allowed: [{ agent: "builder" }] }] },
    })
    expect(result.candidates).toEqual([])
    expect(result.impossible).toBe(true)
    expect(result.rules).toHaveLength(2)
  })

  test("preserves explicit chain identity and never adds an unconfigured candidate", () => {
    const result = DelegationPreferences.resolve({ candidates, topics: [],
      session: { rules: [{ allowed: [{ chain: "configured-chain" }] }] },
    })
    expect(result.candidates).toEqual([candidates[1]])
    expect(DelegationPreferences.resolve({ candidates, topics: [],
      task: { rules: [{ allowed: [{ model: "unknown/model" }] }] },
    }).impossible).toBe(true)
  })

  test("uses scope priority for ordinary questions without keyword routing", () => {
    const result = DelegationPreferences.resolve({ candidates, topics: ["ui"],
      global: { ordinaryQuestions: false }, project: { ordinaryQuestions: true },
      session: { preferences: [{ topic: "Unity UI", selections: [{ agent: "reader" }] }] },
    })
    expect(result.ordinaryQuestions).toBe(true)
    expect(result.preferences).toEqual([])
    expect(result.candidates).toEqual(candidates)
  })

  test("deletes only explicitly cleared values and keeps returned objects independent", () => {
    const value = { ordinaryQuestions: false, rules: [{ allowed: [{ agent: "reader" }] }] }
    const next = DelegationPreferences.apply(value, { ordinaryQuestions: null })
    expect(next).toEqual({ rules: value.rules })
    expect(next.rules).not.toBe(value.rules)
    expect(value.ordinaryQuestions).toBe(false)
    const resolved = DelegationPreferences.resolve({ candidates, topics: [], global: value })
    expect(resolved.candidates[0]).not.toBe(candidates[0])
    expect(resolved.rules[0]?.rule).not.toBe(value.rules[0])
  })

  test("validates direct versus chain references and rejects empty rules", () => {
    expect(Schema.is(ConfigDelegation.Selection)({})).toBe(false)
    expect(Schema.is(ConfigDelegation.Selection)({ model: "fixture/a", chain: "chain" })).toBe(false)
    expect(Schema.is(ConfigDelegation.Selection)({ agent: " " })).toBe(false)
    expect(Schema.is(ConfigDelegation.Info)({ rules: [{ allowed: [] }] })).toBe(false)
    expect(Schema.is(ConfigDelegation.Info)({ preferences: [{ topic: "", selections: [{ agent: "reader" }] }] })).toBe(false)
  })
})
