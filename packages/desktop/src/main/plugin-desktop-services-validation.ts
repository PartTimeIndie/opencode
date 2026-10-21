import type { DesktopServiceRegistrationInput, DesktopServiceState } from "../preload/types"
import { parseDesktopAccelerator } from "./desktop-accelerator"

export function registrationError(input: DesktopServiceRegistrationInput) {
  if (!input || typeof input !== "object") return "Invalid desktop service registration."
  if (typeof input.pluginID !== "string") return "Invalid plugin ID."
  if (typeof input.serviceID !== "string") return "Invalid desktop service ID."
  if (typeof input.accelerator !== "string") return "Invalid global shortcut."
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]{0,127}$/i.test(input.pluginID)) return "Invalid plugin ID."
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(input.serviceID)) return "Invalid desktop service ID."
  if (!input.accelerator.trim() || input.accelerator.length > 128) return "Invalid global shortcut."
  if (!parseDesktopAccelerator(input.accelerator)) return "Invalid global shortcut."
}

export function stateError(state: DesktopServiceState) {
  if (!state || typeof state !== "object") return "Invalid desktop service state."
  if (!["active", "success", "cancelled", "error"].includes(state.phase)) return "Invalid desktop service phase."
  if (typeof state.label !== "string" || !state.label.trim() || state.label.length > 512) return "Invalid desktop service label."
  if (state.elapsedMs !== undefined && (!Number.isFinite(state.elapsedMs) || state.elapsedMs < 0 || state.elapsedMs > 60 * 60 * 1000))
    return "Invalid elapsed time."
  if (state.progress !== undefined && (!Number.isFinite(state.progress) || state.progress < 0 || state.progress > 1))
    return "Invalid desktop service progress."
  if (state.detail !== undefined && (typeof state.detail !== "string" || state.detail.length > 512))
    return "Invalid desktop service detail."
  if (state.actionLabel !== undefined && (typeof state.actionLabel !== "string" || !state.actionLabel.trim() || state.actionLabel.length > 64))
    return "Invalid desktop service action label."
}
