import { describe, expect, test } from "bun:test"
import type { QuestionV2Info } from "./question-dock-types"
import {
  displayFieldContent,
  mediaChecklistSelection,
  safeQuestionActionHref,
  structuredQuestionAnswer,
} from "./session-question-body"

const question = {
  question: "Welche Inhalte behalten?",
  options: [
    { id: "keep", label: "Behalten" },
    { id: "discard", label: "Verwerfen" },
  ],
  body: [
    { id: "summary", type: "markdown", content: "## Seite" },
    {
      id: "media",
      type: "media_checklist",
      items: [
        { id: "hero", label: "Hero", mediaType: "image", src: "hero.png", defaultChecked: true },
        { id: "notes", label: "Notizen", mediaType: "file", src: "notes.md" },
      ],
    },
  ],
} as QuestionV2Info

describe("question body answers", () => {
  test("returns stable option and media ids plus feedback", () => {
    const answer = structuredQuestionAnswer(question, ["Behalten"], { media: ["notes"] }, "Bitte Hero ersetzen.")
    expect(JSON.parse(answer!)).toEqual({
      version: 1,
      type: "opencode.question.answer",
      selectedOptionIDs: ["keep"],
      values: { media: { selectedItemIDs: ["notes"] } },
      feedback: "Bitte Hero ersetzen.",
    })
  })

  test("uses stable default selections until the user changes them", () => {
    const block = question.body?.find((item) => item.type === "media_checklist")
    if (!block || block.type !== "media_checklist") throw new Error("missing media fixture")
    expect(mediaChecklistSelection(block)).toEqual(["hero"])
    expect(mediaChecklistSelection(block, [])).toEqual([])
  })

  test("keeps persisted display value variants readable", () => {
    expect(displayFieldContent({ id: "legacy", type: "display", label: "Legacy", defaultValue: "**Visible**" })).toBe(
      "**Visible**",
    )
    expect(displayFieldContent({ id: "older", type: "display", value: "Still visible" })).toBe("Still visible")
  })

  test("allows explicit vault links and rejects script links", () => {
    expect(safeQuestionActionHref("obsidian://open?vault=Notes")).toBe("obsidian://open?vault=Notes")
    expect(safeQuestionActionHref("javascript:alert(1)")).toBeUndefined()
  })
})
