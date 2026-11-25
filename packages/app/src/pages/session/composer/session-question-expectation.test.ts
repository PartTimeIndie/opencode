import { describe, expect, test } from "bun:test"
import type { QuestionV2Info } from "./question-dock-types"
import {
  isFormExpectation,
  isFormExpectationText,
  questionAriaLabel,
  questionExpectation,
} from "./session-question-expectation"

describe("questionExpectation", () => {
  test("gives standard choices a concrete visible action", () => {
    expect(
      questionExpectation(
        {
          question: "Which path?",
          options: [{ label: "A" }, { label: "B" }],
        } as QuestionV2Info,
        "pick_one",
      ),
    ).toBe("Erwartet: Eine Option auswählen und bestätigen.")
  })

  test("omits redundant host guidance from visible and accessible labels when explicitly disabled", () => {
    const question = {
      question: "Soll der Review-Punkt umgesetzt werden?",
      showExpectation: false,
      options: [{ label: "Ja" }, { label: "Nein" }],
    } as QuestionV2Info
    expect(questionExpectation(question, "review_section")).toBeUndefined()
    expect(questionAriaLabel("Projekt - Review-Punkt", questionExpectation(question, "review_section"))).toBe(
      "Projekt - Review-Punkt",
    )
  })

  test("keeps the host expectation authoritative while suppressing a legacy form copy", () => {
    const node = { type: "text" as const, text: "Erwartet: Empfänger prüfen und Aktion wählen." }
    expect(
      questionExpectation(
        {
          type: "form",
          question: "Review",
          form: {
            version: 1,
            fields: [],
            layout: { type: "vstack", children: [node] },
          },
        } as QuestionV2Info,
        "form",
      ),
    ).toBe("Erwartet: Formular ausfüllen und absenden")
    expect(isFormExpectation(node)).toBe(true)
  })

  test("uses the form submit label when no explicit expectation exists", () => {
    expect(
      questionExpectation(
        {
          type: "form",
          question: "Review",
          form: { version: 1, fields: [], submitLabel: "Entwurf freigeben" },
        } as QuestionV2Info,
        "form",
      ),
    ).toBe("Erwartet: Entwurf freigeben")
  })

  test("keeps rich legacy form content without adopting its authored expectation", () => {
    const node = {
      type: "text" as const,
      text: "Erwartet: Auswahl prüfen.",
      markdown: "Zusätzliche **Details**",
    }
    expect(
      questionExpectation(
        {
          type: "form",
          question: "Review",
          form: {
            version: 1,
            fields: [],
            layout: { type: "vstack", children: [node] },
          },
        } as QuestionV2Info,
        "form",
      ),
    ).toBe("Erwartet: Formular ausfüllen und absenden")
    expect(isFormExpectation(node)).toBe(false)
    expect(isFormExpectationText(node)).toBe(true)
  })

  test("names the one-click chat approval for questions that carry chatSend", () => {
    expect(
      questionExpectation(
        { question: "Skill freigeben?", chatSend: { text: "/visual-qa-testing" } } as QuestionV2Info,
        "pick_one",
      ),
    ).toBe("Erwartet: Freigabe-Klick sendet den hinterlegten Text in den Chat und bestätigt die Frage.")
    expect(
      questionExpectation({ question: "Weiter?" } as QuestionV2Info, "pick_one"),
    ).toBe("Erwartet: Eine Option auswählen und bestätigen.")
  })
})
