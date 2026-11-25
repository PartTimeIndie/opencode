import type { QuestionFormField, QuestionFormValue } from "./question-dock-types"

// Field rendering and validation must subscribe only to the requested value.
// Building the full answer here makes every control depend on every other field.
export function questionFormValue(
  values: Record<string, QuestionFormValue> | undefined,
  field: QuestionFormField,
  initial: (field: QuestionFormField) => QuestionFormValue,
) {
  return values?.[field.id] ?? initial(field)
}
