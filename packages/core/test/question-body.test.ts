import { describe, expect, test } from "bun:test"
import { QuestionV2 } from "@opencode-ai/core/question"

const hero = { id: "hero", label: "Hero", mediaType: "image", src: "images/hero.png", defaultChecked: true }

const valid = {
  question: "Welche Inhalte behalten?",
  options: [
    { id: "keep", label: "Behalten" },
    { id: "discard", label: "Verwerfen" },
  ],
  body: [
    { id: "summary", type: "markdown", content: "## Zusammenfassung\n\n[Details](https://example.com)" },
    { id: "vault", type: "action_link", label: "Vault öffnen", href: "obsidian://open?vault=Notes" },
    {
      id: "media",
      type: "media_checklist",
      items: [
        hero,
        { id: "voice", label: "Voice", mediaType: "audio", src: "https://example.com/voice.mp3" },
      ],
    },
  ],
}

describe("QuestionV2 authored body", () => {
  test("accepts canonical blocks and obsidian links", () => {
    expect(QuestionV2.validateToolInput({ questions: [valid] })).toBeUndefined()
    expect(QuestionV2.decodeAuthoringInfo(valid).body).toHaveLength(3)
  })

  test("accepts an explicit opt-out from redundant host expectation guidance", () => {
    const decoded = QuestionV2.decodeAuthoringInfo({ ...valid, showExpectation: false })
    expect(decoded.showExpectation).toBe(false)
    expect(QuestionV2.validateToolInput({ questions: [{ ...valid, showExpectation: false }] })).toBeUndefined()
  })

  test("reports duplicate block and item ids with precise paths", () => {
    expect(
      QuestionV2.validateToolInput({
        questions: [{ ...valid, body: [valid.body[0], { ...valid.body[0] }] }],
      }),
    ).toContain('["questions"][0]["body"][1]["id"]')

    expect(
      QuestionV2.validateToolInput({
        questions: [
          {
            ...valid,
            body: [
              {
                id: "media",
                type: "media_checklist",
                items: [hero, { ...hero }],
              },
            ],
          },
        ],
      }),
    ).toContain('["questions"][0]["body"][0]["items"][1]["id"]')
  })

  test("rejects empty content, unsafe schemes, and manual expectations", () => {
    expect(
      QuestionV2.validateToolInput({
        questions: [{ ...valid, body: [{ id: "empty", type: "markdown", content: "  " }] }],
      }),
    ).toContain('["content"]')
    expect(
      QuestionV2.validateToolInput({
        questions: [
          { ...valid, body: [{ id: "unsafe", type: "action_link", label: "Open", href: "javascript:alert(1)" }] },
        ],
      }),
    ).toContain('["href"]')
    expect(
      QuestionV2.validateToolInput({
        questions: [{ ...valid, body: [{ id: "duplicate", type: "markdown", content: "Erwartet: auswählen" }] }],
      }),
    ).toContain("host-owned")
  })

  test("keeps legacy persisted content readable but rejects it for new writes", () => {
    const legacy = {
      question: "Legacy review",
      context: "Old context",
      markdown: "## Old page",
      options: [{ label: "Keep" }],
    }
    expect(QuestionV2.decodePersistedInfo(legacy)).toMatchObject(legacy)
    expect(() => QuestionV2.decodeAuthoringInfo(legacy)).toThrow('["questions"][0]["context"]')
    expect(QuestionV2.validateToolInput({ questions: [legacy] })).toContain('["questions"][0]["context"]')
  })

  test("requires stable option ids for value-bearing bodies", () => {
    expect(
      QuestionV2.validateToolInput({
        questions: [{ ...valid, options: [{ label: "Keep" }] }],
      }),
    ).toContain('["options"][0]["id"]')

    expect(
      QuestionV2.validateToolInput({
        questions: [
          {
            ...valid,
            options: [
              { id: "keep-a", label: "Keep" },
              { id: "keep-b", label: "Keep" },
            ],
          },
        ],
      }),
    ).toContain("Option labels must be unique")
  })

  test("rejects an omitted choice type when it would render no answer control", () => {
    expect(
      QuestionV2.validateToolInput({
        questions: [{ question: "Leere Auswahl?" }],
      }),
    ).toContain('Invalid field ["questions"][0]["options"]')
  })
})
