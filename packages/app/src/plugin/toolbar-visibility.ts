import { directoryKey } from "@/utils/path-key"

export type ToolbarVisibilityOverride = "inherit" | "show" | "hide"

export type ToolbarVisibilityState = {
  version: 1
  global: Record<string, boolean>
  projects: Record<string, Record<string, boolean>>
}

export function toolbarProjectKey(server: string, directory: string) {
  return `${server}\0${directoryKey(directory)}`
}

export function globalToolbarItemVisible(
  state: ToolbarVisibilityState,
  id: string,
  defaultVisible = false,
) {
  return state.global[id] ?? defaultVisible
}

export function toolbarItemOverride(state: ToolbarVisibilityState, project: string, id: string): ToolbarVisibilityOverride {
  const value = state.projects[project]?.[id]
  if (value === true) return "show"
  if (value === false) return "hide"
  return "inherit"
}

export function toolbarItemVisible(
  state: ToolbarVisibilityState,
  id: string,
  project?: string,
  defaultVisible = false,
) {
  if (!project) return globalToolbarItemVisible(state, id, defaultVisible)
  return state.projects[project]?.[id] ?? globalToolbarItemVisible(state, id, defaultVisible)
}
