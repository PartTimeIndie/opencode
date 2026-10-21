export function compactComposerToolbar(input: { width: number; required: number; compact: boolean }) {
  if (input.width < 640) return true
  return input.width < input.required + (input.compact ? 12 : 0)
}
