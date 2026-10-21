import type { DesktopServiceState } from "../preload/types"

export function desktopServiceOverlayView(state: DesktopServiceState) {
  const seconds = Math.max(0, Math.floor((state.elapsedMs ?? 0) / 1000))
  return {
    label: state.label,
    detail: state.detail ?? "",
    actionLabel: state.actionLabel ?? "",
    shortcutVisible: state.phase === "active" && !!state.actionLabel,
    telemetry: state.progress === undefined
      ? `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
      : `${Math.round(state.progress * 100)}%`,
    telemetryVisible: state.progress !== undefined || state.elapsedMs !== undefined,
  }
}
