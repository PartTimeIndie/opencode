export function resolvePartText(text: string, accumulated: string | undefined) {
  if (!accumulated) return { text, keepAccumulated: false }
  if (text === accumulated) return { text, keepAccumulated: false }
  if (accumulated.startsWith(text)) return { text: accumulated, keepAccumulated: true }
  if (text.includes(accumulated) || text.startsWith(accumulated)) return { text, keepAccumulated: false }
  return { text, keepAccumulated: false }
}

export function readPartText(
  accum: Record<string, string | undefined> | undefined,
  part: { id: string; text?: string },
): string {
  return resolvePartText(part.text ?? "", accum?.[part.id]).text.trim()
}
