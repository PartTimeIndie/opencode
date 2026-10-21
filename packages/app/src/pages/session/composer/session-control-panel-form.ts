import type { SurfaceBlockingRequest } from "@opencode-ai/sdk/v2/client"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function controlPanelFormRequest(panel: {
  requestID?: string
  requestRevision?: number
  toolID?: string
  toolRevision?: number
  sessionID: string
  title?: string
  controlID: string
  data: unknown
}): SurfaceBlockingRequest | undefined {
  const id = panel.requestID ?? (panel.toolID ? `que_surface_tool_${panel.toolID.replace(/[^A-Za-z0-9]/g, "_")}` : undefined)
  const revision = panel.requestRevision ?? panel.toolRevision
  if (!id || !revision || !isRecord(panel.data) || !Array.isArray(panel.data.controls)) return
  const values = isRecord(panel.data.values) ? panel.data.values : {}
  const questions = panel.data.controls.flatMap((control) => {
    if (!isRecord(control) || !isRecord(control.form) || control.form.version !== 1) return []
    const label = typeof control.label === "string" ? control.label : panel.title || panel.controlID
    const fields = Array.isArray(control.form.fields)
      ? control.form.fields.map((field) =>
          isRecord(field) && typeof field.id === "string" && values[field.id] !== undefined
            ? { ...field, defaultValue: values[field.id] }
            : field,
        )
      : []
    return [{ type: "form" as const, question: label, header: label, form: { ...control.form, fields } }]
  })
  if (!questions.length) return
  return {
    id,
    sessionID: panel.sessionID,
    revision,
    actions: [],
    mode: "blocking",
    questions: questions as SurfaceBlockingRequest["questions"],
    detached: true,
  }
}
