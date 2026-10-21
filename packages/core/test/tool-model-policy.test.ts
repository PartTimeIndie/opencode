import { describe, expect, test } from "bun:test"
import { ModelPolicy } from "../src/tool/model-policy"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"

const openrouter = ProviderV2.ID.make("openrouter")
const zhipuai = ProviderV2.ID.make("zhipuai-coding-plan")
const openai = ProviderV2.ID.make("openai")

// Mirrors the Settings model chain shape: model IDs may contain slashes, so
// `openrouter/stealth/ox-alpha` is provider `openrouter` with model
// `stealth/ox-alpha`.
const oxStep = { id: ModelV2.ID.make("stealth/ox-alpha"), providerID: openrouter }
const glmStep = { id: ModelV2.ID.make("glm-5.3"), providerID: zhipuai }
const lunaStep = {
  id: ModelV2.ID.make("gpt-5.6-luna"),
  providerID: openai,
  variant: ModelV2.VariantID.make("low"),
}
const repoChain = {
  id: "repo",
  name: "Repo chain",
  active: 0,
  steps: [oxStep, glmStep, lunaStep],
}
const parent = ModelV2.Ref.make({ ...oxStep, chain: repoChain })

describe("ModelPolicy.allowedModels", () => {
  test("unions the agent model, parent model, their chain steps, and trusted extras without duplicates", () => {
    const agent = ModelV2.Ref.make({ id: ModelV2.ID.make("gpt-5.6-sol"), providerID: openai })
    const allowed = ModelPolicy.allowedModels({
      agent,
      parent,
      extra: [ModelV2.Ref.make(glmStep)],
    })

    expect(allowed).toHaveLength(4)
    expect(allowed.map(ModelPolicy.formatModel)).toEqual([
      "openai/gpt-5.6-sol",
      "openrouter/stealth/ox-alpha",
      "zhipuai-coding-plan/glm-5.3",
      "openai/gpt-5.6-luna (low)",
    ])
  })
})

describe("ModelPolicy.selectModel", () => {
  test("inherits the agent model while keeping the parent's Settings fallback chain", () => {
    const agent = ModelV2.Ref.make({ id: ModelV2.ID.make("gpt-5.6-sol"), providerID: openai })
    const selection = ModelPolicy.selectModel({ agent, parent })

    expect(selection.ok).toBe(true)
    if (!selection.ok) return
    expect(selection.model).toMatchObject({ id: "gpt-5.6-sol", providerID: "openai" })
    expect(selection.model?.chain?.steps.map((step) => String(step.id))).toEqual([
      "gpt-5.6-sol",
      "glm-5.3",
      "gpt-5.6-luna",
    ])
  })

  test("inherits the parent model unchanged when no chain exists", () => {
    const selection = ModelPolicy.selectModel({ parent: ModelV2.Ref.make(glmStep) })

    expect(selection).toEqual({ ok: true, model: ModelV2.Ref.make(glmStep) })
  })

  test("applies a requested variant to the inherited model", () => {
    const selection = ModelPolicy.selectModel({
      variant: "high",
      parent: ModelV2.Ref.make(glmStep),
    })

    expect(selection).toEqual({
      ok: true,
      model: ModelV2.Ref.make({ ...glmStep, variant: ModelV2.VariantID.make("high") }),
    })
  })

  test("accepts a configured chain step by provider/model and activates it while preserving fallbacks", () => {
    const selection = ModelPolicy.selectModel({ model: "zhipuai-coding-plan/glm-5.3", parent })

    expect(selection.ok).toBe(true)
    if (!selection.ok) return
    expect(selection.model).toMatchObject(glmStep)
    expect(selection.model?.chain).toMatchObject({ active: 1 })
    expect(selection.model?.chain?.steps).toHaveLength(3)
  })

  test("resolves a slash-containing chain model by its bare model id", () => {
    const selection = ModelPolicy.selectModel({ model: "stealth/ox-alpha", parent })

    expect(selection.ok).toBe(true)
    if (!selection.ok) return
    expect(selection.model).toMatchObject(oxStep)
    expect(selection.model?.chain).toMatchObject({ active: 0 })
  })

  test("resolves a slash-free bare model id when it is unambiguous", () => {
    const selection = ModelPolicy.selectModel({ model: "glm-5.3", parent })

    expect(selection.ok).toBe(true)
    if (!selection.ok) return
    expect(selection.model).toMatchObject(glmStep)
  })

  test("rejects a catalog model that was never configured", () => {
    const selection = ModelPolicy.selectModel({ model: "openai/gpt-5.5", parent })

    expect(selection.ok).toBe(false)
    if (selection.ok) return
    expect(selection.requested).toBe("openai/gpt-5.5")
    expect(selection.allowed.map(ModelPolicy.formatModel)).toEqual([
      "openrouter/stealth/ox-alpha",
      "zhipuai-coding-plan/glm-5.3",
      "openai/gpt-5.6-luna (low)",
    ])
    expect(ModelPolicy.rejectionMessage(selection)).toContain("openai/gpt-5.5 is not configured")
    expect(ModelPolicy.rejectionMessage(selection)).toContain("Allowed models: openrouter/stealth/ox-alpha")
  })

  test("rejects a bare model id that matches configured models on several providers", () => {
    const ambiguous = ModelPolicy.selectModel({
      model: "glm-5.3",
      parent,
      extra: [ModelV2.Ref.make({ id: ModelV2.ID.make("glm-5.3"), providerID: openai })],
    })

    expect(ambiguous.ok).toBe(false)
  })

  test("rejects any override when nothing is configured", () => {
    const selection = ModelPolicy.selectModel({ model: "openai/gpt-5.5" })

    expect(selection.ok).toBe(false)
    if (selection.ok) return
    expect(ModelPolicy.rejectionMessage(selection)).toContain("No models are configured")
  })

  test("keeps the matched step variant unless the caller overrides it", () => {
    const inherited = ModelPolicy.selectModel({ model: "openai/gpt-5.6-luna", parent })
    const overridden = ModelPolicy.selectModel({ model: "openai/gpt-5.6-luna", variant: "high", parent })

    expect(inherited.ok && inherited.model?.variant).toBe(ModelV2.VariantID.make("low"))
    expect(overridden.ok && overridden.model?.variant).toBe(ModelV2.VariantID.make("high"))
  })

  test("grafts a trusted extra model into the parent chain instead of dropping fallbacks", () => {
    const reviewer = ModelV2.Ref.make({ id: ModelV2.ID.make("gpt-5.6-sol"), providerID: openai, variant: ModelV2.VariantID.make("high") })
    const selection = ModelPolicy.selectModel({ model: "openai/gpt-5.6-sol", variant: "high", parent, extra: [reviewer] })

    expect(selection.ok).toBe(true)
    if (!selection.ok) return
    expect(selection.model).toMatchObject({ id: "gpt-5.6-sol", providerID: "openai", variant: "high" })
    expect(selection.model?.chain).toMatchObject({ active: 0 })
    expect(selection.model?.chain?.steps.map((step) => String(step.id))).toEqual([
      "gpt-5.6-sol",
      "glm-5.3",
      "gpt-5.6-luna",
    ])
  })

  test("inherits an explicit session model while the agent chain extends the policy", () => {
    const sol = ModelV2.ID.make("gpt-5.6-sol")
    const agent = ModelV2.Ref.make({
      id: sol,
      providerID: openai,
      chain: {
        id: "agent",
        name: "Agent chain",
        active: 0,
        steps: [
          { id: sol, providerID: openai },
          lunaStep,
        ],
      },
    })
    const allowed = ModelPolicy.allowedModels({ agent, parent: ModelV2.Ref.make(glmStep) })
    const selection = ModelPolicy.selectModel({ agent, parent: ModelV2.Ref.make(glmStep), inherit: ModelV2.Ref.make(glmStep) })

    expect(allowed.map(ModelPolicy.formatModel)).toEqual([
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-luna (low)",
      "zhipuai-coding-plan/glm-5.3",
    ])
    expect(selection.ok).toBe(true)
    if (!selection.ok) return
    expect(selection.model).toMatchObject(glmStep)
    expect(selection.model?.chain?.steps.map((step) => String(step.id))).toEqual(["glm-5.3", "gpt-5.6-luna"])
  })

  test("an explicit session null chain suppresses the agent fallback chain", () => {
    const selected = ModelV2.Ref.make({
      id: ModelV2.ID.make("gpt-5.6-sol"),
      providerID: openai,
      chain: null,
    })
    const agent = ModelV2.Ref.make({
      id: selected.id,
      providerID: openai,
      chain: {
        id: "agent",
        name: "Agent chain",
        active: 0,
        steps: [selected, lunaStep],
      },
    })

    expect(ModelPolicy.selectModel({ agent, parent: selected, inherit: selected })).toEqual({ ok: true, model: selected })
    const overridden = ModelPolicy.selectModel({ model: "openai/gpt-5.6-sol", agent, parent: selected })
    expect(overridden.ok).toBe(true)
    if (!overridden.ok) return
    expect(overridden.model?.chain).toBeNull()
  })

  test("Task default selection respects a parent null without discarding an agent-owned chain", () => {
    const session = ModelV2.Ref.make({ ...oxStep, chain: null })
    const agentModel = ModelV2.Ref.make({ id: ModelV2.ID.make("gpt-5.6-sol"), providerID: openai })
    const agentChain = ModelV2.Ref.make({
      ...agentModel,
      chain: {
        id: "agent",
        name: "Agent chain",
        active: 0,
        steps: [agentModel, lunaStep],
      },
    })

    expect(ModelPolicy.selectModel({ agent: agentModel, parent: session })).toEqual({ ok: true, model: agentModel })
    expect(ModelPolicy.selectModel({ parent: session })).toEqual({ ok: true, model: session })
    expect(ModelPolicy.selectModel({ agent: agentChain, parent: session })).toEqual({ ok: true, model: agentChain })
  })

  test("saved chain-null persists across new user input when re-inherited from the saved session", () => {
    // Root evidence: a saved chain:null session (explicit no-fallback) must
    // survive a new user input that carries no model override — PROVIDED the
    // caller re-inherits from the saved session (spawn_agent path). The
    // plain task-resume path (no inherit) re-selects from agent + parent;
    // that documented caller behavior is pinned in tool-task.test.ts.
    const saved = ModelV2.Ref.make({
      id: ModelV2.ID.make("gpt-5.6-luna"),
      providerID: openai,
      chain: null,
    })
    // New user input without a model override inherits the saved session
    // model: base = inherit (saved), chainSource suppressed by parent null.
    const reselected = ModelPolicy.selectModel({ parent: saved, inherit: saved })
    expect(reselected).toEqual({ ok: true, model: saved })
    if (!reselected.ok) return
    expect(reselected.model?.chain).toBeNull()
    // A resuming parent that still carries the standard chain keeps its own
    // chain for ITS identity, but the saved null session re-inherited on the
    // next turn still suppresses fallback: base.chain null wins.
    const parentStandard = ModelV2.Ref.make({
      id: ModelV2.ID.make("gpt-5.6-sol"),
      providerID: openai,
      chain: {
        id: "standard",
        name: "Standard",
        active: 0,
        steps: [
          { id: ModelV2.ID.make("gpt-5.6-sol"), providerID: openai },
          { id: ModelV2.ID.make("gpt-5.6-luna"), providerID: openai },
        ],
      },
    })
    const inherited = ModelPolicy.selectModel({ parent: parentStandard, inherit: saved })
    expect(inherited.ok).toBe(true)
    if (!inherited.ok) return
    // Saved identity wins: Luna with explicit null, not the parent Sol.
    expect(inherited.model).toMatchObject({ id: "gpt-5.6-luna", providerID: "openai" })
    expect(inherited.model?.chain).toBeNull()
  })
})

describe("ModelPolicy.refs", () => {
  test("converts persisted reviewer entries into model refs, keeping variants and slash model ids", () => {
    expect(
      ModelPolicy.refs([
        { model: "openrouter/stealth/ox-alpha" },
        { model: "openai/gpt-5.6-sol", variant: "high" },
      ]),
    ).toEqual([
      { id: ModelV2.ID.make("stealth/ox-alpha"), providerID: ProviderV2.ID.make("openrouter") },
      { id: ModelV2.ID.make("gpt-5.6-sol"), providerID: ProviderV2.ID.make("openai"), variant: ModelV2.VariantID.make("high") },
    ])
  })
})
