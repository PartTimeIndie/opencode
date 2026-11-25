# Desktop paint recovery

The Windows desktop window has intermittently turned black and recovered when the user moved or resized it. The cause is not established. Neither a renderer animation callback nor a successful `webContents.invalidate()` call confirms that Windows presented a frame.

## Recovery contract

- `packages/desktop/src/main/paint-recovery.ts` requests a repaint for show, focus and restore events, and for visible renderer stall reports with a four-second monotonic-clock report cooldown on registered windows. It does not move or resize windows, reload content, or run a periodic main-process repair timer. The guarded fallback for an unregistered sender has no main-process cooldown or recovery log.
- Hidden, minimized or destroyed windows are skipped. Closing a registered window detaches listeners and makes retained recovery actions inert. Reports are routed to their sender's window.
- `packages/desktop/src/main/index.ts` requests repaints on system resume and display metric changes, and once 1.5 seconds after a GPU process loss. These requests do not acknowledge successful presentation.
- `packages/app/src/components/presentation-watchdog.tsx` checks animation callback liveness every two seconds and reports a visible stall after eight seconds. It is not a screen-presentation detector. The absence of a stall report does not prove the renderer, GPU or compositor was healthy.
- Hardware acceleration remains enabled. Do not add automatic bounds changes, reloads, or blind repair cycles to mask an unproven cause.

## Evidence and upstream leads

- The repository pins Electron 42.11.18 (raised from 42.3.3 on 2026-11-07 after repeated access-violation crashes of the desktop server sidecar; the diagnosed installed build `20261106T082031Z-885d78d8` shipped Electron 42.3.3 and keeps running it until the next approved deploy). [Electron 42.11.18](https://releases.electronjs.org/release/v42.11.18) marks the 42.x line end-of-support. Assess a supported upgrade separately, including compatibility and deployment approval; a newer version alone does not establish a fix, and the bump is a mitigation pending production soak rather than a demonstrated root-cause fix.
- [Electron #52844](https://github.com/electron/electron/pull/52844), [backported to 42](https://github.com/electron/electron/pull/52865), fixes a hidden `WebContentsView` remaining blank until resized after `setBackgroundThrottling(false)`. OpenCode calls that API for desktop service registrations, but its main window is a `BrowserWindow`; the upstream commit explicitly says BrowserWindow is immune to that specific initial-hidden path. This is not evidence that the reported Windows incident has the same cause.
- Electron describes a different [DirectComposition resize defect](https://www.electronjs.org/blog/tech-talk-window-resize-behavior), fixed from 39.2.6, involving stale or black partial areas during resizing. It does not establish the cause of a spontaneous whole-window black screen on 42.3.3.
- Inspected application logs show recovery requests, not their success. A recorded server Utility process crash is not a GPU crash. Missing stall or GPU-crash messages do not rule out presentation, occlusion or driver faults.

## Verification boundaries

Run `bun test ./src/main/paint-recovery.test.ts` and `bun typecheck` from `packages/desktop`. The unit tests exercise event routing, lifecycle guards, cooldowns and the absence of bounds mutations or a repair timer; mocks cannot prove native display behavior.

The sporadic black screen has not been reproduced or shown to be fixed. The user will perform the later manual Windows check. Source changes are not an installed fix; production deployment and restart require separate explicit approval.
