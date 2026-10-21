#!/usr/bin/env bun

import { ControlSurface } from "@opencode-ai/core/control-surface"
import { QuestionV2 } from "@opencode-ai/core/question"

const file = Bun.argv[2]

if (!file || file === "--help" || file === "-h") {
  console.log("Usage: bun run validate:control-surface <surface.json>")
  console.log("Validates Surface tool inputs, form definitions, or Control data.")
  process.exit(file ? 0 : 1)
}

const input = await Bun.file(file).json()
const diagnostics = validate(input)

if (diagnostics.length === 0) {
  console.log("Control surface is valid.")
  process.exit(0)
}

for (const diagnostic of diagnostics) {
  console.error(`${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}`)
}
process.exit(1)

function validate(input: unknown): ControlSurface.Diagnostic[] {
  if (isRecord(input) && Array.isArray(input.questions)) {
    const allowed = new Set(["mode", "questions", "phase"])
    const key = Object.keys(input).find((candidate) => !allowed.has(candidate))
    if (key)
      return [{
        code: "SURFACE_TOOL_INPUT",
        path: `[${JSON.stringify(key)}]`,
        message: key === "actions"
          ? 'Blocking Surface inputs cannot declare actions. Use question.form.actions for form events, or use mode "interactive" with the Control.PartData action contract.'
          : `Unexpected field [${JSON.stringify(key)}]. Allowed fields: mode, phase, questions.`,
      }]
    const toolError = QuestionV2.validateToolInput({
      questions: input.questions,
      ...(input.phase ? { phase: input.phase } : {}),
    })
    if (toolError) return [{ code: "SURFACE_TOOL_INPUT", path: "input", message: toolError }]
    return input.questions.flatMap((question, index) =>
      isRecord(question) && question.form
        ? ControlSurface.validateFormDefinition(question.form).map((diagnostic) => ({ ...diagnostic, path: `questions[${index}].${diagnostic.path}` }))
        : [],
    )
  }
  if (isRecord(input) && input.form) return ControlSurface.validateFormDefinition(input.form)
  if (isRecord(input) && Array.isArray(input.fields)) return ControlSurface.validateFormDefinition(input)
  return ControlSurface.validatePartData(input)
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
