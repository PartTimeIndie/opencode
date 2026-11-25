import { app } from "electron"

// `app.isQuitting` is not in the Electron type surface, but it is the
// established idiom for distinguishing a user-initiated close (hide to tray)
// from an app-wide quit (close all windows). Centralising the cast here keeps
// the production before-quit handler and the (feature-flagged) tray close
// handler in sync without scattering `as typeof app & { isQuitting?: boolean }`
// across modules. Both write to the same field on the shared `app` singleton.
type AppWithQuitFlag = typeof app & { isQuitting?: boolean }

export const isAppQuitting = (): boolean => (app as AppWithQuitFlag).isQuitting === true

export const markAppQuitting = (quitting = true): void => {
  ;(app as AppWithQuitFlag).isQuitting = quitting
}
