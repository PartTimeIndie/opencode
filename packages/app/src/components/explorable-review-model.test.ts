import { describe, expect, test } from "bun:test"
import { visibleReviewSections, type ExplorableSection } from "./explorable-review-model"

describe("visibleReviewSections", () => {
  test("flattens duplicate wrapper sections without changing leaf order", () => {
    const sections = [
      {
        id: "root",
        title: "Root",
        content: "Summary",
        children: [
          {
            id: "duplicate",
            title: "Root",
            content: "Summary",
            children: [
              { id: "first", title: "First", content: "One" },
              { id: "second", title: "Second", content: "Two" },
            ],
          },
        ],
      },
    ]

    expect(visibleReviewSections(sections)).toEqual([
      {
        id: "root",
        title: "Root",
        content: "Summary",
        children: [
          { id: "first", title: "First", content: "One" },
          { id: "second", title: "Second", content: "Two" },
        ],
      },
    ])
  })

  test("visits a deep drilldown tree once while flattening duplicate wrappers", () => {
    const depth = 250
    let reads = 0
    const leaf: ExplorableSection = { id: "leaf", title: "Leaf", content: "Content" }
    const nested = Array.from({ length: depth }).reduceRight<ExplorableSection[]>((children, _, index) => {
      const section = { id: `node-${index}`, title: "Group", content: "", children } as ExplorableSection
      Object.defineProperty(section, "children", {
        enumerable: true,
        get() {
          reads += 1
          return children
        },
      })
      return [section]
    }, [leaf])

    const visible = visibleReviewSections(nested)
    expect(visible).toHaveLength(1)
    expect(visible[0]?.children).toEqual([leaf])
    expect(reads).toBe(depth)
  })
})
