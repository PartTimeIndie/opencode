import { describe, expect, test } from "bun:test"

describe("speech-to-text-app improvement prompts overlay contract", () => {
  test("hides skills and application profiles behind an overlay button in the synced runtime copy", async () => {
    const source = await Bun.file(
      new URL("../../../../.opencode/plugins/speech-to-text-app/index.js", import.meta.url),
    ).text()

    expect(source).toContain('key: "improvementPrompts"')
    expect(source).toContain('type: "overlay"')
    expect(source).toContain('label: "Improvement prompts"')

    const templateIndex = source.indexOf('key: "improvementPromptTemplate"')
    const overlayIndex = source.indexOf('key: "improvementPrompts"')
    const skillsIndex = source.indexOf('key: "defaultImprovementSkills"')
    const profilesIndex = source.indexOf("applicationProfileSetting(api.settings)")
    expect(templateIndex).toBeGreaterThan(-1)
    expect(overlayIndex).toBeGreaterThan(-1)
    expect(skillsIndex).toBeGreaterThan(-1)
    expect(profilesIndex).toBeGreaterThan(-1)
    // The general prompt template stays visible in the main settings list, before the overlay button.
    expect(templateIndex).toBeLessThan(overlayIndex)
    // The cluttering prompt fields render only inside the overlay fields array.
    expect(skillsIndex).toBeGreaterThan(overlayIndex)
    expect(profilesIndex).toBeGreaterThan(overlayIndex)

    // Custom vocabulary and learned corrections stay directly editable.
    const vocabularyIndex = source.indexOf('key: "customVocabulary"')
    const learnedIndex = source.indexOf('key: "learnedTerms"')
    expect(vocabularyIndex).toBeGreaterThan(-1)
    expect(learnedIndex).toBeGreaterThan(-1)
    expect(vocabularyIndex).toBeLessThan(overlayIndex)
    expect(learnedIndex).toBeLessThan(overlayIndex)
  })
})
