const windowsCaptionControlsWidth = 138

export function videoPreviewRatio(width: number, height: number) {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? width / height : 16 / 9
}

export function shouldCloseVideoFullscreenOnEscape(input: {
  key: string
  defaultPrevented: boolean
  focusOwner: "fullscreen" | "trigger" | "other"
}) {
  return input.key === "Escape" && !input.defaultPrevented && input.focusOwner !== "other"
}

export function fullscreenCloseButtonRight(input: { windowsDesktop: boolean; zoom: number }) {
  if (!input.windowsDesktop) return "1rem"
  return `calc(${windowsCaptionControlsWidth / Math.max(input.zoom, 1)}px + 1rem)`
}
