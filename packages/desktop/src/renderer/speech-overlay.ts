export {}

import { desktopServiceOverlayView } from "./speech-overlay-state"
import type { DesktopServiceState } from "../preload/types"

type OverlayState = DesktopServiceState & { application: string; accelerator: string }

const overlay = document.getElementById("overlay")
const statusElement = document.getElementById("status")
const elapsed = document.getElementById("elapsed")
const application = document.getElementById("application")
const detail = document.getElementById("detail")
const separator = document.getElementById("detail-separator")
const hint = document.getElementById("hint")
const shortcut = document.getElementById("shortcut")
const accelerator = document.getElementById("accelerator")

window.speechOverlay.subscribe((state) => {
  if (!overlay || !statusElement || !elapsed || !application || !detail || !separator || !hint || !shortcut || !accelerator) return
  const view = desktopServiceOverlayView(state)
  overlay.dataset.phase = state.phase
  statusElement.textContent = view.label
  statusElement.title = view.label
  elapsed.textContent = view.telemetry
  elapsed.hidden = !view.telemetryVisible
  application.textContent = state.application
  detail.textContent = view.detail
  separator.hidden = !view.detail
  detail.hidden = !view.detail
  hint.textContent = view.actionLabel
  accelerator.textContent = state.accelerator
  shortcut.hidden = !view.shortcutVisible
})

declare global {
  interface Window {
    speechOverlay: {
      subscribe(callback: (state: OverlayState) => void): () => void
    }
  }
}
