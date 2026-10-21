const revisions = new WeakMap<object, { current: number; questions: Map<string, number> }>()

function tracker(store: object) {
  const existing = revisions.get(store)
  if (existing) return existing
  const next = { current: 0, questions: new Map<string, number>() }
  revisions.set(store, next)
  return next
}

export function questionRevision(store: object) {
  return tracker(store).current
}

export function markQuestionChanged(store: object, questionID: string) {
  const state = tracker(store)
  state.current += 1
  state.questions.set(questionID, state.current)
}

export function questionChangedAfter(store: object, questionID: string, revision: number) {
  return (tracker(store).questions.get(questionID) ?? 0) > revision
}
