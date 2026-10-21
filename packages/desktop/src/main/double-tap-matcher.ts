export type DoubleTapEvent = { type: "reset" } | { type: "tap"; time: number; window: string }

export function createDoubleTapMatcher() {
  let pending: Extract<DoubleTapEvent, { type: "tap" }> | undefined
  return (event: DoubleTapEvent) => {
    if (event.type === "reset") {
      pending = undefined
      return false
    }
    const matched = !!pending && event.window === pending.window && event.time >= pending.time && event.time - pending.time <= 450
    pending = matched ? undefined : event
    return matched
  }
}
