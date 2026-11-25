import { Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { DockTray } from "@opencode-ai/ui/dock-surface"
import { goalControlAction, goalStatusLabel, type GoalStatus } from "@/utils/session-goal-state"
import type { SessionGoalControlAction } from "@/utils/session-goal-control"

export function goalDockSpacing(running: boolean) {
  return running ? { marginBottom: "0", paddingBottom: "0.5rem" } : { marginBottom: "-0.875rem", paddingBottom: "1.75rem" }
}

export function SessionGoalDock(props: {
  goal: string
  onClear: () => void
  running?: boolean
  status?: GoalStatus
  onControl?: (action: SessionGoalControlAction) => void
  controlPending?: boolean
  controlUnavailableReason?: string
}) {
  const spacing = () => goalDockSpacing(!!props.running)
  const decision = () => goalControlAction(props.status)
  const controlDisabled = () =>
    props.controlPending === true || decision().kind === "unavailable" || !!props.controlUnavailableReason
  const controlTitle = () => {
    if (props.controlUnavailableReason) return props.controlUnavailableReason
    const current = decision()
    return current.kind === "unavailable" ? current.reason : undefined
  }
  const controlAriaLabel = () => {
    if (props.controlUnavailableReason) return props.controlUnavailableReason
    const current = decision()
    return current.kind === "available" ? current.label : current.reason
  }
  const controlDataAction = () => {
    if (props.controlUnavailableReason) return "session-goal-control-unavailable"
    const current = decision()
    return current.kind === "available" ? `session-goal-${current.action}` : "session-goal-control-unavailable"
  }
  return (
    <DockTray
      data-component="session-goal-dock"
      style={{
        "margin-bottom": spacing().marginBottom,
        "border-bottom-left-radius": 0,
        "border-bottom-right-radius": 0,
      }}
    >
      <div class="flex min-w-0 items-center gap-2 px-3 py-2" style={{ "padding-bottom": spacing().paddingBottom }}>
        <span class="shrink-0 rounded bg-surface-base px-1.5 py-0.5 text-11-regular uppercase tracking-wide text-text-weak">
          Goal
        </span>
        <Show when={props.status}>
          {(status) => (
            <span class="shrink-0 rounded bg-surface-base px-1.5 py-0.5 text-11-regular text-text-weak">
              {goalStatusLabel(status())}
            </span>
          )}
        </Show>
        <span class="min-w-0 flex-1 truncate text-13-regular text-text-strong">{props.goal}</span>
        <Show when={props.onControl}>
          {(onControl) => (
            <Button
              size="small"
              variant="ghost"
              class="shrink-0"
              disabled={controlDisabled()}
              title={controlTitle()}
              aria-label={controlAriaLabel()}
              data-action={controlDataAction()}
              onClick={() => {
                const current = decision()
                if (current.kind === "available" && !props.controlUnavailableReason) onControl()(current.action)
              }}
            >
              {decision().label}
            </Button>
          )}
        </Show>
        <Button size="small" variant="ghost" class="shrink-0" onClick={props.onClear}>
          Cancel
        </Button>
      </div>
    </DockTray>
  )
}
