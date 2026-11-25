import type { QuestionControlType, QuestionOption, QuestionV2Info } from "./question-dock-types"
import { hasValueBearingBody } from "./session-question-body"

export type QuestionChatSend = {
  text: string
  label?: string
  description?: string
}

const choiceTypes: QuestionControlType[] = ["pick_one", "pick_many", "confirm", "show_options", "thumbs", "emoji_react"]
const textTypes: QuestionControlType[] = ["ask_text", "ask_code", "ask_file", "ask_image"]

export function controlType(question: QuestionV2Info | undefined): QuestionControlType {
  if (question?.type) return question.type
  return question?.multiple ? "pick_many" : "pick_one"
}

export function choiceControl(type: QuestionControlType | undefined) {
  return type !== undefined && choiceTypes.includes(type)
}

export function textControl(type: QuestionControlType | undefined) {
  return type !== undefined && textTypes.includes(type)
}

export function dangerAnswer(value: string) {
  return /\b(cancel|abort|reject|decline|stop)\b|abbrechen|ablehnen/i.test(value)
}

// The one-click chat approval must answer with exactly the recorded text, so it is
// only offered for controls whose answer is that text: free-text inputs and plain
// choices. Structured bodies, forms, sliders, rankings and reviews serialize the
// answer differently and never carry chatSend.
export function chatSendSupported(question: QuestionV2Info | undefined) {
  if (!question || hasValueBearingBody(question)) return false
  const type = controlType(question)
  return choiceControl(type) || textControl(type)
}

export function questionChatSend(question: QuestionV2Info | undefined): QuestionChatSend | undefined {
  if (!chatSendSupported(question)) return
  const chatSend = question!.chatSend
  // Surrounding whitespace only marks degenerate payloads; the authored text is
  // sent verbatim.
  if (typeof chatSend?.text !== "string" || chatSend.text.trim() === "") return
  return {
    text: chatSend.text,
    ...(chatSend.label ? { label: chatSend.label } : {}),
    ...(chatSend.description ? { description: chatSend.description } : {}),
  }
}

export function requestChatSend(questions: ReadonlyArray<QuestionV2Info | undefined>): QuestionChatSend | undefined {
  for (const question of questions) {
    const send = questionChatSend(question)
    if (send) return send
  }
  return
}

export function recommendedAnswerLabels(
  question: QuestionV2Info | undefined,
  options: QuestionOption[],
): string[] | undefined {
  const type = controlType(question)
  if (!choiceControl(type)) return
  const recommended = question?.recommendedOptions?.length
    ? question.recommendedOptions
    : question?.recommended
      ? [question.recommended]
      : []
  if (recommended.length === 0) return
  if (type !== "pick_many" && recommended.length > 1) return
  const labels = recommended.map((value) => options.find((option) => option.id === value || option.label === value)?.label)
  if (labels.some((label) => !label)) return
  const resolved = labels as string[]
  // One click must never submit a rejecting answer by accident.
  if (resolved.some((label) => dangerAnswer(label))) return
  if (type !== "pick_many" && new Set(resolved).size !== resolved.length) return
  return resolved
}

export function quickApproveAnswers(
  questions: ReadonlyArray<QuestionV2Info | undefined>,
  optionsFor: (question: QuestionV2Info | undefined) => QuestionOption[],
): string[][] | undefined {
  if (questions.length === 0) return
  const answers = questions.map((question) => recommendedAnswerLabels(question, optionsFor(question)))
  if (answers.some((answer) => answer === undefined)) return
  return answers as string[][]
}
