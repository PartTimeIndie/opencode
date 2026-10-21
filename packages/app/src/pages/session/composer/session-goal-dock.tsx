import { Button } from "@opencode-ai/ui/button"
import { DockTray } from "@opencode-ai/ui/dock-surface"

export function goalDockSpacing(running: boolean) {
  return running ? { marginBottom: "0", paddingBottom: "0.5rem" } : { marginBottom: "-0.875rem", paddingBottom: "1.75rem" }
}

export function SessionGoalDock(props: {
  goal: string
  onClear: () => void
  running?: boolean
}) {
  const spacing = () => goalDockSpacing(!!props.running)
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
        <span class="min-w-0 flex-1 truncate text-13-regular text-text-strong">{props.goal}</span>
        <Button size="small" variant="ghost" class="shrink-0" onClick={props.onClear}>
          Cancel
        </Button>
      </div>
    </DockTray>
  )
}
