import type {
  QuestionFormField,
  QuestionMediaChecklistBlock,
  QuestionV2Info,
} from "./question-dock-types"

export type QuestionBodySelections = Record<string, string[]>

export function hasValueBearingBody(question: QuestionV2Info | undefined) {
  return question?.body?.some((block) => block.type === "media_checklist") === true
}

export function mediaChecklistSelection(block: QuestionMediaChecklistBlock, current?: string[]) {
  return current ?? block.items.filter((item) => item.defaultChecked === true).map((item) => item.id)
}

export function structuredQuestionAnswer(
  question: QuestionV2Info,
  selectedLabels: string[],
  values: QuestionBodySelections,
  feedback?: string,
) {
  if (!hasValueBearingBody(question)) return
  const selected = new Set(selectedLabels)
  const selectedOptionIDs = (question.options ?? [])
    .filter((option) => selected.has(option.label))
    .map((option) => option.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
  const bodyValues = Object.fromEntries(
    (question.body ?? []).flatMap((block) =>
      block.type === "media_checklist"
        ? [[block.id, { selectedItemIDs: mediaChecklistSelection(block, values[block.id]) }]]
        : [],
    ),
  )
  const text = feedback?.trim()
  return JSON.stringify({
    version: 1,
    type: "opencode.question.answer",
    selectedOptionIDs,
    values: bodyValues,
    ...(text ? { feedback: text } : {}),
  })
}

export function displayFieldContent(field: QuestionFormField) {
  const value = field.description ?? field.value ?? field.defaultValue
  if (typeof value === "string") return value.trim() || undefined
  if (value === undefined || value === null) return
  return JSON.stringify(value, null, 2)
}

export function safeQuestionActionHref(value: string) {
  try {
    const href = new URL(value.trim())
    return ["http:", "https:", "obsidian:"].includes(href.protocol) ? href.toString() : undefined
  } catch {
    return
  }
}
