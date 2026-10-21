export type ControlPanelPresentationControl = {
  id: string
  type: string
  label: string
  markdown?: string
  content?: string
}

const informationTypes = new Set([
  "show_diff",
  "show_plan",
  "review_section",
  "details",
  "accordion",
  "tabs",
  "object_tree",
  "table",
  "image_preview",
  "video_preview",
  "audio_preview",
])

export function splitControlPanelControls<T extends ControlPanelPresentationControl>(controls: T[]) {
  const seen = new Set<string>()
  const information = controls.filter((control) => {
    if (!informationTypes.has(control.type)) return false
    const key = JSON.stringify(Object.fromEntries(Object.entries(control).filter(([key]) => key !== "id")))
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return {
    information,
    actions: controls.filter((control) => !informationTypes.has(control.type)),
  }
}

export function controlPanelExpectation(controls: ControlPanelPresentationControl[]) {
  const actions = splitControlPanelControls(controls).actions
  if (actions.length === 0) return "Erwartet: Keine Aktion nötig"
  return `Erwartet: ${actions.map((control) => control.label).join(" · ")}`
}

export function controlPanelTitle(title: string | undefined, hasHandoff: boolean) {
  if (!hasHandoff) return title
  return title ?? "Agent switch request"
}

export function shouldDockControlPanel(input: { dock?: boolean; pinned?: boolean }) {
  return input.dock === true || input.pinned === true
}
