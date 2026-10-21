import { expect, test } from "bun:test"

const plugin = await import(
  new URL("../../../../.opencode/plugin-sources/scheduled-jobs-app/index.js", import.meta.url).href
)

const STANDARD_CODER_CHAIN = { id: "standard-coder", name: "Standard Coder", isDefault: true }

test("new scheduled jobs start on the dynamic Settings default chain without any implied model", () => {
  expect(plugin.scheduledJobModelRoutingDraft(undefined)).toEqual({
    modelChain: "default",
    model: "",
    variant: "",
  })
  expect(plugin.scheduledJobModelRoutingDraft(null)).toEqual({
    modelChain: "default",
    model: "",
    variant: "",
  })
})

test("persisted jobs keep their saved routing in the editor draft", () => {
  expect(
    plugin.scheduledJobModelRoutingDraft({ run: { modelChain: "06276054-f34d-4420-894d-73707ee82200" } }),
  ).toEqual({ modelChain: "06276054-f34d-4420-894d-73707ee82200", model: "", variant: "" })
  expect(plugin.scheduledJobModelRoutingDraft({ run: { model: "openrouter/free-model", variant: "low" } })).toEqual({
    modelChain: "",
    model: "openrouter/free-model",
    variant: "low",
  })
})

test("chain-routed jobs persist without direct model fields or exceptions", () => {
  const payload = plugin.payloadFromDraft({
    name: " nightly chain job ",
    description: "",
    schedule: " 0 9 * * * ",
    workdir: "C:/project",
    runOnce: "false",
    timeoutSeconds: "",
    jobType: "llm",
    prompt: " Run the review. ",
    agent: "",
    modelChain: "default",
    model: "openai/gpt-5.6-sol",
    variant: "high",
    modelPolicyExceptionConfirmed: "true",
    modelPolicyExceptionReason: "stale draft state must be ignored for chain jobs",
    runTarget: "app",
    appSessionStrategy: "new",
    accessControl: "ask",
    runFormat: "",
    share: "",
    continue: "",
    attachUrl: "",
  })
  expect(payload.modelChain).toBe("default")
  expect(payload.model).toBe("")
  expect(payload.variant).toBe("")
  expect(payload.modelPolicyException).toBeNull()
  expect(payload.prompt).toBe("Run the review.")
})

test("every direct single-model job fails closed until model, variant, and reason are explicitly confirmed", () => {
  // No model at all: the app default is not approvable as an exception.
  expect(
    plugin.modelPolicyExceptionValidationError({
      model: "",
      variant: "",
      modelPolicyExceptionConfirmed: "true",
      modelPolicyExceptionReason: "x".repeat(32),
    }),
  ).toContain("requires an explicit model and thinking level")

  // The retired hardcoded default no longer passes without an exception.
  expect(
    plugin.modelPolicyExceptionValidationError({
      model: "openai/gpt-5.6-sol",
      variant: "high",
      modelPolicyExceptionConfirmed: "false",
      modelPolicyExceptionReason: "",
    }),
  ).toContain("require an explicitly confirmed model-policy exception")

  // An explicit non-5.6 choice follows the same rule.
  expect(
    plugin.modelPolicyExceptionValidationError({
      model: "openrouter/free-model",
      variant: "low",
      modelPolicyExceptionConfirmed: "false",
      modelPolicyExceptionReason: "",
    }),
  ).toContain("require an explicitly confirmed model-policy exception")

  // Confirmed + bounded reason is the only passing shape.
  const draft = {
    model: "openrouter/free-model",
    variant: "low",
    modelPolicyExceptionConfirmed: "true",
    modelPolicyExceptionReason: "This isolated fixture explicitly requires the free model.",
  }
  expect(plugin.modelPolicyExceptionValidationError(draft)).toBe("")
  expect(plugin.modelPolicyExceptionFromDraft(draft)).toEqual({
    model: "openrouter/free-model",
    variant: "low",
    reason: "This isolated fixture explicitly requires the free model.",
  })
})

test("model policy status reports chain routing as compliant and direct jobs as exception or unresolved", () => {
  expect(plugin.modelPolicyStatus({ run: { modelChain: "default", runTarget: "app" } })).toMatchObject({
    kind: "chain",
    label: "Settings default chain",
  })
  expect(plugin.modelPolicyStatus({ run: { runTarget: "app" } })).toMatchObject({ kind: "unresolved" })
  expect(
    plugin.modelPolicyStatus({
      run: {
        runTarget: "app",
        model: "openrouter/free-model",
        variant: "low",
        modelPolicyException: {
          model: "openrouter/free-model",
          variant: "low",
          reason: "This isolated fixture explicitly requires the free model.",
        },
      },
    }),
  ).toMatchObject({ kind: "exception" })
})

test("verification fixtures run on the Settings chain by default and demand a variant for direct models", () => {
  const base = {
    operation: "create",
    fixtureId: "a".repeat(32),
    expectedScopeId: "scope",
    workdir: "C:/project",
    schedule: "37 23 31 12 *",
    prompt: "Check",
    preflightToken: "TOKEN12345",
  }
  expect(plugin.verificationFixtureInput(base)).toMatchObject({
    model: undefined,
    variant: undefined,
  })
  expect(
    plugin.verificationFixtureInput({
      ...base,
      model: "openrouter/free-model",
      variant: "low",
    }),
  ).toMatchObject({ model: "openrouter/free-model", variant: "low" })
  expect(() => plugin.verificationFixtureInput({ ...base, model: "openrouter/free-model" })).toThrow(
    "requires an explicit variant when model is set",
  )
})

test("model routing offers named Settings chains only for app jobs", () => {
  const api = {
    ui: {
      models: {
        chains: () => [STANDARD_CODER_CHAIN, { id: "great-coder", name: "Great Coder", isDefault: false }],
      },
    },
  }
  expect(plugin.modelChainOptions(api, "app").map((option: { value: string }) => option.value)).toEqual([
    "chain:default",
    "chain:standard-coder",
    "chain:great-coder",
    "direct",
  ])
  expect(plugin.modelChainOptions(api, "cli").map((option: { value: string }) => option.value)).toEqual([
    "chain:default",
    "direct",
  ])
})

test("shell command generation fails closed without a configured default chain", () => {
  expect(plugin.defaultChainOf([])).toBeUndefined()
  expect(plugin.defaultChainOf(undefined)).toBeUndefined()
  expect(plugin.defaultChainOf([{ id: "other", isDefault: false }, STANDARD_CODER_CHAIN])).toEqual(
    STANDARD_CODER_CHAIN,
  )
})
