type ViewportHost = Pick<Window, "innerHeight" | "innerWidth"> & {
  visualViewport: Pick<VisualViewport, "height" | "offsetLeft" | "offsetTop" | "width"> | null
}

export function visualViewportBounds(host: ViewportHost) {
  const left = host.visualViewport?.offsetLeft ?? 0
  const top = host.visualViewport?.offsetTop ?? 0
  const width = host.visualViewport?.width ?? host.innerWidth
  const height = host.visualViewport?.height ?? host.innerHeight
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  }
}
