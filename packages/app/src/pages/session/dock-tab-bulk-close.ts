// Selection is not work state. Only close panes whose own source can attest
// that no work or user decision remains; missing/hydrating state stays open.
export function inactiveDockPaneIds(panes: readonly { id: string; inactive?: () => boolean }[]) {
  return panes.filter((pane) => pane.inactive?.() === true).map((pane) => pane.id)
}

export function sessionTabIsInactive(input: {
  status?: string
  working: boolean
  question: boolean
  permission: boolean
}) {
  return input.status === "idle" && !input.working && !input.question && !input.permission
}
