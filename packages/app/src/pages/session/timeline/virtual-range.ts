import { defaultRangeExtractor, type Range } from "@tanstack/solid-virtual"

const timelineRenderOverscan = 6

export function compactVirtualItems<T>(items: readonly (T | undefined)[]) {
  return items.filter((item): item is T => item !== undefined)
}

export function extractTimelineRange(input: {
  range: Range
  pinned: number[]
  activeStart: number
  activeEnd: number
}) {
  const active =
    input.activeStart < 0 || input.activeEnd < input.activeStart
      ? []
      : Array.from({ length: input.activeEnd - input.activeStart + 1 }, (_, index) => input.activeStart + index)
  const indexes = defaultRangeExtractor({ ...input.range, overscan: timelineRenderOverscan })
  return [...new Set([...input.pinned, ...indexes, ...active])].sort((a, b) => a - b)
}
