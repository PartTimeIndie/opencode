import { describe, expect, test } from "bun:test"
import {
  isExplicitVariantSelection,
  migrateLocalSelectionStore,
  resolveLocalModel,
  toSessionModelRef,
  type LocalModelKey,
} from "./local-model"

const fallback: LocalModelKey = { providerID: "opencode", modelID: "default" }
const agent: LocalModelKey = { providerID: "opencode", modelID: "agent" }

describe("migrateLocalSelectionStore", () => {
  test("preserves current per-session selections and drops obsolete workspace state", () => {
    const session = { agent: "plan", model: agent, variant: "high" }
    expect(
      migrateLocalSelectionStore<typeof session>({
        session: { ses_current: session },
        workspace: { agent: "legacy" },
      }),
    ).toEqual({ session: { ses_current: session } })
  })

  test("wraps legacy pick entries as sessions and drops the workspace sentinel", () => {
    const session = { agent: "build", model: fallback, variant: null }
    expect(
      migrateLocalSelectionStore<typeof session>({
        pick: {
          __workspace__: { agent: "plan" },
          ses_legacy: session,
        },
      }),
    ).toEqual({ session: { ses_legacy: session } })
  })

  test("uses an empty session map for malformed or workspace-only data", () => {
    expect(migrateLocalSelectionStore(undefined)).toEqual({ session: {} })
    expect(migrateLocalSelectionStore({ workspace: { agent: "plan" } })).toEqual({ session: {} })
  })
})

describe("resolveLocalModel", () => {
  test("uses the available fallback for a new draft without an explicit selection", () => {
    expect(
      resolveLocalModel({
        fallback,
        isValid: () => true,
      }),
    ).toEqual(fallback)
  })

  test("prefers a configured agent model over the remembered workspace fallback", () => {
    expect(
      resolveLocalModel({
        agent,
        fallback,
        isValid: () => true,
      }),
    ).toEqual(agent)
  })

  test("does not silently replace an invalid explicit selection", () => {
    expect(
      resolveLocalModel({
        explicit: agent,
        fallback,
        isValid: (model) => model.modelID === fallback.modelID,
      }),
    ).toBeUndefined()
  })
})

describe("toSessionModelRef", () => {
  test("builds a direct session model with the selected variant", () => {
    expect(
      toSessionModelRef(
        {
          model: { providerID: "openrouter", modelID: "openrouter/free" },
          variant: "default",
        },
        [],
      ),
    ).toEqual({ providerID: "openrouter", id: "openrouter/free", variant: "default" })
  })

  test("builds the complete persisted chain from the selected chain", () => {
    expect(
      toSessionModelRef(
        { chainID: "free-fallback", variant: null },
        [
          {
            id: "free-fallback",
            name: "Free fallback",
            steps: [
              { providerID: "openrouter", modelID: "openrouter/free" },
              { providerID: "openai", modelID: "gpt-5.6-luna", variant: "high" },
            ],
          },
        ],
      ),
    ).toEqual({
      providerID: "openrouter",
      id: "openrouter/free",
      chain: {
        id: "free-fallback",
        name: "Free fallback",
        active: 0,
        steps: [
          { providerID: "openrouter", id: "openrouter/free" },
          { providerID: "openai", id: "gpt-5.6-luna", variant: "high" },
        ],
      },
    })
  })

  test("does not persist a removed chain as an unrelated direct model", () => {
    expect(toSessionModelRef({ chainID: "removed" }, [])).toBeUndefined()
  })
})

describe("isExplicitVariantSelection", () => {
  test("distinguishes user changes from select hydration", () => {
    expect(isExplicitVariantSelection()).toBe(true)
    expect(isExplicitVariantSelection({ remember: true })).toBe(true)
    expect(isExplicitVariantSelection({ remember: false })).toBe(false)
  })
})
