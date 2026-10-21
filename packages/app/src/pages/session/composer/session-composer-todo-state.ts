export const todoState = (input: {
  count: number
  done: boolean
  live: boolean
  turnStatus?: "done" | "incomplete" | "unknown"
}): "hide" | "clear" | "open" | "close" => {
  if (input.count === 0) return "hide"
  if (!input.live && input.turnStatus) return "open"
  if (!input.live) return "clear"
  if (!input.done) return "open"
  return "close"
}
