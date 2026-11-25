import { describe, expect, test } from "bun:test"
import type { QuestionOption, QuestionV2Info } from "./question-dock-types"
import {
  chatSendSupported,
  choiceControl,
  controlType,
  dangerAnswer,
  questionChatSend,
  quickApproveAnswers,
  recommendedAnswerLabels,
  requestChatSend,
} from "./session-question-approve"

const options: QuestionOption[] = [
  { id: "yes", label: "Ja (Recommended)" },
  { id: "no", label: "Nein" },
]

const choiceQuestion = {
  question: "Freigeben?",
  options,
  recommended: "yes",
} as QuestionV2Info

describe("controlType", () => {
  test("defaults untyped single-choice questions to pick_one", () => {
    expect(controlType({ question: "Freigeben?" } as QuestionV2Info)).toBe("pick_one")
    expect(controlType({ question: "Freigeben?", multiple: true } as QuestionV2Info)).toBe("pick_many")
    expect(controlType({ question: "Freigeben?", type: "ask_text" } as QuestionV2Info)).toBe("ask_text")
  })

  test("keeps the choice family that a one-click approval may answer", () => {
    expect(choiceControl("pick_one")).toBe(true)
    expect(choiceControl("confirm")).toBe(true)
    expect(choiceControl("ask_text")).toBe(false)
    expect(choiceControl("form")).toBe(false)
  })
})

describe("questionChatSend", () => {
  test("sends the authored text verbatim and keeps label and description", () => {
    expect(
      questionChatSend({
        question: "Skill freigeben?",
        chatSend: { text: "  /multi-agent-review  ", label: "Review starten", description: "Startet das Review" },
      } as QuestionV2Info),
    ).toEqual({ text: "  /multi-agent-review  ", label: "Review starten", description: "Startet das Review" })
    expect(questionChatSend({ question: "Weiter?", chatSend: { text: "/visual-qa-testing" } } as QuestionV2Info)).toEqual({
      text: "/visual-qa-testing",
    })
  })

  test("ignores empty or missing chat approvals", () => {
    expect(questionChatSend(undefined)).toBeUndefined()
    expect(questionChatSend({ question: "Freigeben?" } as QuestionV2Info)).toBeUndefined()
    expect(questionChatSend({ question: "Freigeben?", chatSend: { text: "   " } } as QuestionV2Info)).toBeUndefined()
  })

  test("restricts chat approvals to controls that answer with exactly the text", () => {
    expect(chatSendSupported({ question: "Freigeben?", type: "pick_one" } as QuestionV2Info)).toBe(true)
    expect(chatSendSupported({ question: "Freigeben?", type: "confirm" } as QuestionV2Info)).toBe(true)
    expect(chatSendSupported({ question: "Text?", type: "ask_text" } as QuestionV2Info)).toBe(true)
    expect(chatSendSupported({ question: "Wert?", type: "slider" } as QuestionV2Info)).toBe(false)
    expect(chatSendSupported({ question: "Plan?", type: "show_plan" } as QuestionV2Info)).toBe(false)
    expect(chatSendSupported({ question: "Form?", type: "form" } as QuestionV2Info)).toBe(false)
    expect(
      chatSendSupported({
        question: "Strukturiert?",
        body: [
          {
            id: "checks",
            type: "media_checklist",
            items: [{ id: "shot", label: "Screenshot", mediaType: "image", src: "file:///shot.png" }],
          },
        ],
      } as unknown as QuestionV2Info),
    ).toBe(false)
  })

  test("finds the request-wide chat approval across tabs", () => {
    expect(
      requestChatSend([
        { question: "Erstes?" } as QuestionV2Info,
        { question: "Skill?", chatSend: { text: "/x" } } as QuestionV2Info,
      ]),
    ).toEqual({ text: "/x" })
    expect(requestChatSend([{ question: "Erstes?" } as QuestionV2Info])).toBeUndefined()
  })
})

describe("recommendedAnswerLabels", () => {
  test("resolves a recommended option id to its visible label", () => {
    expect(recommendedAnswerLabels(choiceQuestion, options)).toEqual(["Ja (Recommended)"])
  })

  test("resolves a recommended label directly and supports pick_many recommendation sets", () => {
    expect(
      recommendedAnswerLabels({ question: "Route?", options, recommended: "Nein" } as QuestionV2Info, options),
    ).toEqual(["Nein"])
    expect(
      recommendedAnswerLabels(
        { question: "Pakete?", multiple: true, options, recommendedOptions: ["yes", "no"] } as QuestionV2Info,
        options,
      ),
    ).toEqual(["Ja (Recommended)", "Nein"])
  })

  test("declines recommendations that do not resolve, need free input, or read as rejecting", () => {
    expect(recommendedAnswerLabels({ question: "Route?", recommended: "vielleicht" } as QuestionV2Info, options)).toBeUndefined()
    expect(
      recommendedAnswerLabels({ question: "Text?", type: "ask_text", recommended: "yes" } as QuestionV2Info, options),
    ).toBeUndefined()
    expect(
      recommendedAnswerLabels({ question: "Wirklich stoppen?", options: [{ label: "Stop" }], recommended: "Stop" } as QuestionV2Info, [
        { label: "Stop" },
      ]),
    ).toBeUndefined()
    expect(
      recommendedAnswerLabels(
        { question: "Route?", type: "pick_one", recommendedOptions: ["yes", "no"] } as QuestionV2Info,
        options,
      ),
    ).toBeUndefined()
  })

  test("never quick-approves a danger-labeled answer", () => {
    expect(dangerAnswer("Abbrechen")).toBe(true)
    expect(dangerAnswer("Ja (Recommended)")).toBe(false)
  })
})

describe("quickApproveAnswers", () => {
  test("collects the recommended answer for every question in one request", () => {
    expect(
      quickApproveAnswers([choiceQuestion, { question: "Thumbs?", options, recommended: "no" } as QuestionV2Info], () => options),
    ).toEqual([["Ja (Recommended)"], ["Nein"]])
  })

  test("declines the one-click approval when any question needs manual input", () => {
    expect(
      quickApproveAnswers([choiceQuestion, { question: "Was genau?" } as QuestionV2Info], () => options),
    ).toBeUndefined()
    expect(quickApproveAnswers([], () => options)).toBeUndefined()
  })
})
