import { describe, expect, test } from "bun:test"
import { sortProviderList } from "./provider-ordering"

describe("sortProviderList", () => {
  test("keeps popular providers before local providers", () => {
    expect(
      sortProviderList([
        { id: "lmstudio", name: "LM Studio" },
        { id: "openai", name: "OpenAI" },
        { id: "anthropic", name: "Anthropic" },
        { id: "mistral", name: "Mistral" },
        { id: "github-copilot", name: "GitHub Copilot" },
      ]).map((provider) => provider.id),
    ).toEqual(["anthropic", "github-copilot", "openai", "lmstudio", "mistral"])
  })

  test("sorts non-popular providers alphabetically", () => {
    expect(
      sortProviderList([
        { id: "z-local", name: "Z Local" },
        { id: "lmstudio", name: "LM Studio" },
        { id: "mistral", name: "Mistral" },
      ]).map((provider) => provider.id),
    ).toEqual(["lmstudio", "mistral", "z-local"])
  })
})
