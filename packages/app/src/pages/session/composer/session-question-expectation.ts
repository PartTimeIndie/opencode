import type { QuestionControlType, QuestionFormLayoutNode, QuestionV2Info } from "./question-dock-types"

const prefix = /^\s*Erwartet:\s*\S/i

export function questionExpectation(question: QuestionV2Info | undefined, type: QuestionControlType | undefined) {
  if (question?.showExpectation === false) return
  if (type === "form") return `Erwartet: ${question?.form?.submitLabel ?? "Formular ausfüllen und absenden"}`
  if (type === "pick_many" || question?.multiple === true)
    return "Erwartet: Eine oder mehrere Optionen auswählen und bestätigen."
  if (type === "ask_text" || type === "ask_code" || type === "ask_file" || type === "ask_image")
    return "Erwartet: Eine Antwort eingeben und bestätigen."
  if (type === "slider" || type === "rate") return "Erwartet: Einen Wert festlegen und bestätigen."
  if (type === "rank") return "Erwartet: Die Reihenfolge festlegen und bestätigen."
  if (type === "show_diff" || type === "show_plan" || type === "review_section")
    return "Erwartet: Die Prüfung abschließen und bestätigen."
  return "Erwartet: Eine Option auswählen und bestätigen."
}

export function questionAriaLabel(summary: string, expectation: string | undefined) {
  if (!expectation) return summary
  return `${summary}. ${expectation}`
}

export function isFormExpectation(node: QuestionFormLayoutNode) {
  return (
    isFormExpectationText(node) &&
    !node.title &&
    !node.markdown &&
    !node.content &&
    !node.sections?.length &&
    !node.children?.length
  )
}

export function isFormExpectationText(node: QuestionFormLayoutNode) {
  return node.type === "text" && typeof node.text === "string" && prefix.test(node.text)
}
