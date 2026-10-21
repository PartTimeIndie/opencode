import { expect, test } from "bun:test"
import { compactVirtualItems, extractTimelineRange } from "./virtual-range"

test("compacts sparse virtualizer output before creating lookup maps", () => {
  const first = { key: "first" }
  const second = { key: "second" }
  const sparse: Array<typeof first | undefined> = []
  sparse[1] = first
  sparse[3] = undefined
  sparse[4] = second

  const compact = compactVirtualItems(sparse)
  expect(compact).toEqual([first, second])
  expect(new Map(compact.map((item) => [item.key, item] as const))).toEqual(
    new Map([
      ["first", first],
      ["second", second],
    ]),
  )
})

test("bounds timeline hydration while preserving pinned and active rows", () => {
  expect(
    extractTimelineRange({
      range: { startIndex: 20, endIndex: 24, overscan: 50, count: 100 },
      pinned: [18, 80],
      activeStart: 2,
      activeEnd: 3,
    }),
  ).toEqual([2, 3, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 80])
})

test("does not synthesize active rows for an idle timeline", () => {
  expect(
    extractTimelineRange({
      range: { startIndex: 0, endIndex: 2, overscan: 50, count: 100 },
      pinned: [],
      activeStart: -1,
      activeEnd: -1,
    }),
  ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
})
