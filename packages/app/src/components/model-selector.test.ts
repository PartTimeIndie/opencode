import { expect, test } from "bun:test"
import { modelSelectorChains, modelSelectorListOptions } from "./model-selector"

test("model selector opens at the top without auto-following an active model", () => {
  expect(modelSelectorListOptions).toEqual({ initialScroll: "top", noInitialSelection: true })
})

test("the dropdown follows saved order without pinning Planning Chain", () => {
  const chains = ["Speech TTS", "Standard Coder", "Planning Chain", "Speech STT", "Fast Chain"].map((name) => ({
    id: name,
    name,
    steps: [{ providerID: "openai", modelID: "gpt-5.6" }],
  }))
  expect(modelSelectorChains(chains).map((chain) => chain.name)).toEqual([
    "Speech TTS", "Standard Coder", "Planning Chain", "Speech STT", "Fast Chain",
  ])
  expect(chains.map((chain) => chain.name)).toEqual([
    "Speech TTS", "Standard Coder", "Planning Chain", "Speech STT", "Fast Chain",
  ])
  expect(modelSelectorChains(chains)[0]).toBe(chains[0])
})

test("chain names never override saved order, including differently cased Planning Chain", () => {
  const chains = ["B", "A"].map((name) => ({ id: name, name, steps: [] }))
  expect(modelSelectorChains(chains)).toEqual(chains)
  expect(modelSelectorChains([])).toEqual([])
  const planning = { id: "plan", name: " planning CHAIN ", steps: [] }
  expect(modelSelectorChains([...chains, planning])).toEqual([...chains, planning])
})
