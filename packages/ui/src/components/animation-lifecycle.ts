export function scheduleAnimations(start: () => Array<{ stop(): void }>) {
  let active = true
  let animations: Array<{ stop(): void }> = []
  const frame = requestAnimationFrame(() => {
    if (active) animations = start()
  })
  return () => {
    if (!active) return
    active = false
    cancelAnimationFrame(frame)
    for (const animation of animations) animation.stop()
    animations = []
  }
}
