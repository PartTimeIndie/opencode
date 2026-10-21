import { describe, expect, test } from "bun:test"
import path from "node:path"

const {
  learnedTermsFromDiff,
  learnedVocabularyPrompt,
  mergeLearnedTerms,
  mergeVocabulary,
  parseLearnedTermsField,
  parseVocabularyField,
  serializeLearnedTermsField,
  topLearnedTerms,
} = await import(
  `${path.resolve("../../.opencode/plugin-sources/speech-to-text-app/index.js")}?learn-test=${Date.now()}`
)

describe("speech-to-text-app learned correction vocabulary", () => {
  test("extracts the user's replacement wording from composer edits with original casing", () => {
    expect(learnedTermsFromDiff("Prüfe die Bugs im Composer", "Prüfe die Bugs im OpenCode Composer")).toEqual([
      "OpenCode",
    ])
    expect(
      learnedTermsFromDiff(
        "Bitte den Bugfixing Flow prüfen",
        "Bitte den Bugfixing-Flow in Petty Ungodliness prüfen",
      ),
    ).toEqual(["Petty Ungodliness"])
  })

  test("learns multi-word phrases and single tokens while ignoring stop words and noise", () => {
    expect(learnedTermsFromDiff("Starte den Build", "Starte den Release Build")).toEqual(["Release"])
    expect(learnedTermsFromDiff("Das ist kaputt", "Das und ist kaputt")).toEqual([])
    // Pure deletions never invent terms.
    expect(learnedTermsFromDiff("Prüfe den Release Build jetzt", "Prüfe den Build jetzt")).toEqual([])
    // Numbers and ultra-short fragments stay out.
    expect(learnedTermsFromDiff("Version drei prüfen", "Version 42 prüfen")).toEqual([])
  })

  test("never learns from unrelated draft text, prefixes, appends, or other submits", () => {
    // Unrelated submit (no resync, no leading anchor).
    expect(learnedTermsFromDiff("Bitte die Bugs prüfen", "Schreibe eine Zusammenfassung des Meetings")).toEqual([])
    // Composer draft that only extends the inserted text with a prefix.
    expect(learnedTermsFromDiff("Bitte die Bugs prüfen", "Zusammenfassung: Bitte die Bugs prüfen")).toEqual([])
    // Trailing append of ordinary words after an untouched transcript.
    expect(learnedTermsFromDiff("Bitte die Bugs prüfen", "Bitte die Bugs prüfen jetzt gleich")).toEqual([])
    // The genuine mid-text replacement still works.
    expect(learnedTermsFromDiff("Bitte die Bugs prüfen", "Bitte die Bugfixes prüfen")).toEqual(["Bugfixes"])
  })

  test("caps the number of corrections per submit", () => {
    const anchors = ["aa", "bb", "cc", "dd", "ee", "ff", "gg", "hh", "ii", "jj", "kk"]
    const polished = anchors.map((anchor, index) => `${anchor} term${index + 1}`).join(" ")
    const submitted = anchors.map((anchor, index) => `${anchor} replaced${index + 1}`).join(" ")
    expect(learnedTermsFromDiff(polished, submitted)).toHaveLength(8)
  })

  test("merges corrections with counts, dedupes case-insensitively, and prefers spelled forms", () => {
    const merged = mergeLearnedTerms([{ term: "Bugs", count: 3 }], ["bugs", "VidMD"])
    expect(merged).toEqual([
      { term: "Bugs", count: 4 },
      { term: "VidMD", count: 1 },
    ])
    expect(mergeLearnedTerms([], [], 2).length).toBe(0)
    const capped = mergeLearnedTerms(
      Array.from({ length: 5 }, (_, index) => ({ term: `term${index}`, count: 1 })),
      ["term5"],
      3,
    )
    expect(capped.length).toBe(3)
    expect(new Set(capped.map((entry: { term: string }) => entry.term)).size).toBe(3)
  })

  test("serializes and parses the settings field with counts", () => {
    const field = serializeLearnedTermsField([
      { term: "Bugfixing", count: 4 },
      { term: "VidMD", count: 1 },
    ])
    expect(field).toBe("Bugfixing ×4\nVidMD")
    expect(parseLearnedTermsField(field)).toEqual([
      { term: "Bugfixing", count: 4 },
      { term: "VidMD", count: 1 },
    ])
    expect(parseLearnedTermsField("Plain term\nAnother ×0\n ×5")).toEqual([
      { term: "Plain term", count: 1 },
      { term: "Another", count: 1 },
    ])
    expect(parseLearnedTermsField(`${"x".repeat(80)} ×2`)).toEqual([])
  })

  test("ranks learned terms by clamped count and renders the spelling prompt block", () => {
    expect(
      topLearnedTerms([
        { term: "rare", count: 1 },
        { term: "often", count: 9 },
        { term: "negative", count: -5 },
        { term: "fractional", count: 0.5 },
      ]),
    ).toEqual(["often", "rare", "negative", "fractional"])
    const prompt = learnedVocabularyPrompt([{ term: "Bugfixing", count: 2 }])
    expect(prompt).toContain("corrected improved transcripts toward these spellings")
    expect(prompt).toContain("Bugfixing")
    expect(learnedVocabularyPrompt([])).toBe("")
  })

  test("merges custom vocabulary into the built-in glossary without duplicates", () => {
    expect(mergeVocabulary(["Bugs", "vidmd", "Unity", "a"])).toEqual(["vidmd"])
    expect(mergeVocabulary(["VidMD", "PU Board"])).toEqual(["VidMD", "PU Board"])
    // The settings field is one term per line; commas stay part of the term.
    expect(parseVocabularyField("VidMD\r\nPU Board, Deluxe")).toEqual(["VidMD", "PU Board, Deluxe"])
    expect(parseVocabularyField("")).toEqual([])
    expect(parseVocabularyField(`${"y".repeat(80)}`)).toEqual([])
  })
})
