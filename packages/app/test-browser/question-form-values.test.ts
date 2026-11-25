import { expect, test } from "bun:test"
import { batch, createComputed, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { questionFormValue } from "../src/pages/session/composer/session-question-form-values"
import type { QuestionFormField, QuestionFormValue } from "../src/pages/session/composer/question-dock-types"

const initial = (field: QuestionFormField): QuestionFormValue => String(field.defaultValue ?? "")

test("one changed value invalidates only its field in a 500-field form", () => {
  createRoot((dispose) => {
    const fields: QuestionFormField[] = Array.from({ length: 500 }, (_, i) => ({ id: `f${i}`, type: "text", defaultValue: `initial${i}` }))
    const [state, setState] = createStore<{ values: Record<string, QuestionFormValue> }>({ values: {} })
    const runs = fields.map(() => 0)
    fields.forEach((field, i) => createComputed(() => {
      questionFormValue(state.values, field, initial)
      runs[i]++
    }))
    setState("values", "f23", "edited")
    expect(runs[23]).toBe(2)
    expect(runs.filter(n => n === 1)).toHaveLength(499)
    expect(questionFormValue(state.values, fields[23]!, initial)).toBe("edited")
    dispose()
  })
})

test("false, zero and empty edits are preserved; reset uses the current defaults", () => {
  const field: QuestionFormField = { id: "value", type: "text", defaultValue: "default" }
  for (const value of [false, 0, "", ["a"], { start: 1, end: 2 }]) {
    expect(questionFormValue({ value }, field, initial)).toEqual(value)
  }
  expect(questionFormValue(undefined, field, initial)).toBe("default")
  expect(questionFormValue({}, { ...field, defaultValue: "new" }, initial)).toBe("new")
})

test("linear validation reads each value once, with no enumeration of other values", () => {
  const fields: QuestionFormField[] = Array.from({ length: 500 }, (_, i) => ({ id: `f${i}`, type: "text" }))
  let reads = 0
  const values = new Proxy<Record<string, QuestionFormValue>>({}, {
    get: () => { reads++; return "value" },
    ownKeys: () => { throw new Error("full form enumeration") },
  })
  expect(fields.every(field => questionFormValue(values, field, initial) === "value")).toBe(true)
  expect(reads).toBe(500)
})

test("batched edits preserve a frozen source snapshot and publish one reactive result", () => {
  createRoot((dispose) => {
    const [state, setState] = createStore({ values: { first: "A", second: "B", third: "C" } })
    const seen: string[][] = []
    createComputed(() => seen.push(Object.values(state.values)))
    const before = { ...state.values }
    batch(() => {
      setState("values", "first", before.second)
      setState("values", "second", before.third)
      setState("values", "third", "")
    })
    expect(seen).toEqual([["A", "B", "C"], ["B", "C", ""]])
    dispose()
  })
})
