export const normalizeWheelDelta = (input: { deltaY: number; deltaMode: number; rootHeight: number }) => {
  if (input.deltaMode === 1) return input.deltaY * 40
  if (input.deltaMode === 2) return input.deltaY * input.rootHeight
  return input.deltaY
}

export const shouldMarkBoundaryGesture = (input: {
  delta: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}) => {
  const max = input.scrollHeight - input.clientHeight
  if (max <= 1) return true
  if (!input.delta) return false

  if (input.delta < 0) return input.scrollTop + input.delta <= 0

  const remaining = max - input.scrollTop
  return input.delta > remaining
}

export const shouldRequestStartHistory = (input: {
  delta: number
  rootScrollTop: number
  nested?: {
    scrollTop: number
    scrollHeight: number
    clientHeight: number
  }
}) => {
  if (input.delta >= 0 || input.rootScrollTop >= 200) return false
  if (!input.nested) return true
  return shouldMarkBoundaryGesture({
    delta: input.delta,
    scrollTop: input.nested.scrollTop,
    scrollHeight: input.nested.scrollHeight,
    clientHeight: input.nested.clientHeight,
  })
}
