import { describe, expect, test } from "bun:test"
import {
  reconcileRestoredSelection,
  resolveNewTabSelection,
  resolveRestoredSessionSelection,
  resolveSessionModelSelection,
} from "./session-model-selection"

const visibleModel = {
  model: { providerID: "openai", modelID: "gpt-5.6-luna" },
  variant: "default",
}

describe("resolveSessionModelSelection", () => {
  test("new sessions prefer the selected agent's configured chain", () => {
    expect(
      resolveSessionModelSelection({
        agent: {
          model: {
            providerID: "openai",
            modelID: "gpt-5.6-sol",
            chain: { id: "agent-chain" },
          },
          variant: "xhigh",
        },
        visible: visibleModel,
      }),
    ).toEqual({ chainID: "agent-chain", variant: null })
  })

  test("agent model and variant beat the visible previous-session selection", () => {
    expect(
      resolveSessionModelSelection({
        agent: {
          model: { providerID: "openai", modelID: "gpt-5.6-sol" },
          variant: "high",
        },
        visible: {
          model: { providerID: "openrouter", modelID: "openrouter/free" },
          variant: "default",
        },
      }),
    ).toEqual({ model: { providerID: "openai", modelID: "gpt-5.6-sol" }, variant: "high" })
  })

  test("a nullable agent chain stays a direct-model selection instead of using the default chain", () => {
    expect(resolveSessionModelSelection({
      agent: { model: { providerID: "openai", modelID: "gpt-5.6-sol", chain: null } },
      defaultChainID: "default-chain",
    })).toEqual({ model: { providerID: "openai", modelID: "gpt-5.6-sol" }, variant: null })
  })

  test("a changed agent default replaces stale visible selection at the next selection boundary", () => {
    expect(
      resolveSessionModelSelection({
        agent: {
          model: {
            providerID: "openai",
            modelID: "gpt-5.6-sol",
            chain: { id: "updated-agent-chain" },
          },
        },
        visible: visibleModel,
      }),
    ).toEqual({ chainID: "updated-agent-chain", variant: null })
  })

  test("uses the configured default chain when no selection belongs to the current context", () => {
    expect(
      resolveSessionModelSelection({
        defaultChainID: "configured-default",
      }),
    ).toEqual({ chainID: "configured-default", variant: null })
  })

  test("keeps a visible manual selection ahead of the default chain", () => {
    expect(
      resolveSessionModelSelection({
        defaultChainID: "configured-default",
        visible: visibleModel,
      }),
    ).toEqual(visibleModel)
  })

  test("a real agent switch uses the global default chain instead of the prior selection", () => {
    expect(resolveSessionModelSelection({ agent: {}, fresh: true, defaultChainID: "default-chain", visible: visibleModel })).toEqual({
      chainID: "default-chain", variant: null,
    })
    expect(resolveSessionModelSelection({ agent: {}, fresh: true, fallback: visibleModel, visible: { chainID: "old-chain" } })).toEqual(visibleModel)
  })

  test("agent switching without a default inherits the last visible bottom-composer selection", () => {
    expect(resolveSessionModelSelection({ agent: {}, visible: visibleModel })).toEqual(visibleModel)
    expect(
      resolveSessionModelSelection({
        agent: {},
        visible: { chainID: "last-visible-chain", variant: null },
      }),
    ).toEqual({ chainID: "last-visible-chain", variant: null })
  })

  test("an agent without a default keeps the visible selection even when named plan or build", () => {
    for (const name of ["plan", "build"]) {
      expect(resolveSessionModelSelection({ agent: {}, visible: { model: { providerID: name, modelID: "visible" } } })).toEqual({
        model: { providerID: name, modelID: "visible" },
      })
    }
  })
})

describe("resolveNewTabSelection", () => {
  const build = {
    name: "build",
    model: { providerID: "openai", modelID: "gpt-5.6-sol" },
    variant: "medium",
  }
  const planPick = { model: { providerID: "openai", modelID: "gpt-6-astra" }, variant: "high" }

  test("a new tab starts on the default agent's configured model and variant, not the last-used pick", () => {
    expect(
      resolveNewTabSelection({
        agent: build,
        defaultChainID: "glm-codex",
        visible: planPick,
      }),
    ).toEqual({
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5.6-sol" },
      variant: "medium",
    })
  })

  test("an agent-configured chain replaces both the default chain and the last-used selection", () => {
    expect(
      resolveNewTabSelection({
        agent: {
          name: "plan",
          model: { providerID: "openai", modelID: "gpt-6-astra", chain: { id: "planning-chain" } },
          variant: "high",
        },
        defaultChainID: "glm-codex",
        visible: planPick,
      }),
    ).toEqual({ agent: "plan", chainID: "planning-chain", variant: null })
  })

  test("without an agent default, the configured default chain beats the global picker memory", () => {
    expect(
      resolveNewTabSelection({
        agent: { name: "build" },
        defaultChainID: "glm-codex",
        visible: { chainID: "planning-chain", variant: null },
      }),
    ).toEqual({ agent: "build", chainID: "glm-codex", variant: null })
  })

  test("without an agent or chain default a new tab does not copy another tab's model", () => {
    expect(resolveNewTabSelection({
      agent: { name: "build" },
      visible: { model: { providerID: "openrouter", modelID: "openrouter/free" }, variant: null },
    })).toEqual({ agent: "build" })
    expect(resolveNewTabSelection({ agent: { name: "build" }, fallback: visibleModel })).toEqual({ agent: "build", ...visibleModel })
  })

  test("without any agent the resolution falls back to chain or an empty selection", () => {
    expect(resolveNewTabSelection({ defaultChainID: "glm-codex" })).toEqual({
      chainID: "glm-codex",
      variant: null,
    })
    expect(resolveNewTabSelection({ visible: planPick })).toEqual({})
    expect(resolveNewTabSelection({})).toEqual({})
  })
})

describe("resolveRestoredSessionSelection", () => {
  const chains = new Set(["luna-free-qa", "remembered-chain"])
  const isValidModel = (model: { providerID: string; modelID: string }) => model.providerID !== "missing"

  test("keeps an existing valid chain selection instead of replacing it with the active step", () => {
    expect(
      resolveRestoredSessionSelection({
        previous: { chainID: "luna-free-qa", variant: null },
        model: {
          providerID: "openai",
          modelID: "gpt-5.6-luna",
          variant: "default",
        },
        hasChain: (id) => chains.has(id),
        isValidModel,
      }),
    ).toEqual({ action: "skip" })
  })

  test("force restore persists the canonical session chain without reducing it to a model", () => {
    expect(
      resolveRestoredSessionSelection({
        previous: { chainID: "remembered-chain", variant: null },
        model: {
          providerID: "openai",
          modelID: "gpt-5.6-luna",
          chain: { id: "luna-free-qa" },
          variant: "default",
        },
        force: true,
        hasChain: (id) => chains.has(id),
        isValidModel,
      }),
    ).toEqual({ action: "restore", selection: { chainID: "luna-free-qa", variant: null } })
  })

  test("restores direct models when the canonical session selection has no chain", () => {
    expect(
      resolveRestoredSessionSelection({
        model: { providerID: "openrouter", modelID: "openrouter/free", variant: "default" },
        hasChain: (id) => chains.has(id),
        isValidModel,
      }),
    ).toEqual({
      action: "restore",
      selection: { model: { providerID: "openrouter", modelID: "openrouter/free" }, variant: "default" },
    })
  })

  test("restores a direct model when the canonical session explicitly clears its chain", () => {
    expect(
      resolveRestoredSessionSelection({
        model: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "high", chain: null },
        force: true,
        hasChain: (id) => chains.has(id),
        isValidModel,
      }),
    ).toEqual({
      action: "restore",
      selection: { model: { providerID: "openai", modelID: "gpt-5.6-sol" }, variant: "high" },
    })
  })

  test("keeps a canonical chain while Settings chains are still loading", () => {
    expect(
      resolveRestoredSessionSelection({
        model: {
          providerID: "openai",
          modelID: "gpt-5.6-luna",
          chain: { id: "removed-chain" },
          variant: "medium",
        },
        hasChain: (id) => chains.has(id),
        isValidModel,
      }),
    ).toEqual({ action: "restore", selection: { chainID: "removed-chain", variant: null } })
  })
})

describe("reconcileRestoredSelection", () => {
  const persisted = {
    agent: "plan",
    model: { providerID: "glm", modelID: "glm-5.3" },
    variant: "default",
  }

  test("the authoritative session agent wins over the stale persisted agent", () => {
    expect(reconcileRestoredSelection({ persisted, sessionAgent: "build" })).toEqual({
      agent: "build",
      model: { providerID: "glm", modelID: "glm-5.3" },
      variant: "default",
    })
  })

  test("keeps the persisted selection when the record has no differing agent", () => {
    expect(reconcileRestoredSelection({ persisted, sessionAgent: "plan" })).toBe(persisted)
    expect(reconcileRestoredSelection({ persisted, sessionAgent: undefined })).toBe(persisted)
  })

  test("passes through a missing persisted selection", () => {
    expect(reconcileRestoredSelection({ persisted: undefined, sessionAgent: "build" })).toBeUndefined()
  })
})
