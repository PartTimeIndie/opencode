import { describe, expect, test } from "bun:test"

type GraphModule = {
  computeGraph: (commits: { hash: string; parents: string[] }[], options?: { firstParent?: boolean }) => {
    nodes: Map<string, { lane: number; inFrom: number[]; out: { to: number; curve: boolean }[] }>
    rows: { hash: string; lane: number; parents: number; before: (string | null)[]; after: (string | null)[] }[]
    columns: (string | null)[]
    openLanes: number[]
    maxLane: number
  }
}

const graph = (await import(new URL("../../../../.opencode/plugins/git-workbench-app/history-graph.js", import.meta.url).href)) as GraphModule

/** Newest-first linear chain, as pages arrive from the history walk. */
const chain = (length: number) => {
  const commits = []
  for (let i = 1; i <= length; i++) {
    commits.push({ hash: `h${i}`, parents: i === length ? [] : [`h${i + 1}`] })
  }
  return commits
}

describe("git workbench history graph", () => {
  test("keeps a linear chain on lane 0", () => {
    const result = graph.computeGraph(chain(5))
    expect([...result.nodes.values()].every((node) => node.lane === 0)).toBe(true)
    expect(result.maxLane).toBe(1)
    expect(result.openLanes).toEqual([])
    expect(result.rows).toHaveLength(5)
  })

  test("draws a side branch fork and merge", () => {
    const commits = [
      { hash: "m", parents: ["b", "s"] },
      { hash: "s", parents: ["b"] },
      { hash: "b", parents: [] },
    ]
    const result = graph.computeGraph(commits)
    expect(result.nodes.get("m")?.lane).toBe(0)
    expect(result.nodes.get("m")?.out.some((edge) => edge.to === 1 && edge.curve)).toBe(true)
    expect(result.nodes.get("s")?.lane).toBe(1)
    expect(result.nodes.get("s")?.out.some((edge) => edge.to === 0 && edge.curve)).toBe(true)
    expect(result.openLanes).toEqual([])
  })

  test("runs simultaneous histories on separate lanes", () => {
    const commits = [
      { hash: "a2", parents: ["a1"] },
      { hash: "b1", parents: ["b0"] },
      { hash: "a1", parents: [] },
      { hash: "b0", parents: [] },
    ]
    const result = graph.computeGraph(commits)
    expect(result.nodes.get("a2")?.lane).toBe(0)
    expect(result.nodes.get("b1")?.lane).toBe(1)
  })

  test("reuses a freed lane for a later root", () => {
    const result = graph.computeGraph([
      { hash: "a1", parents: [] },
      { hash: "b1", parents: [] },
    ])
    expect(result.nodes.get("a1")?.lane).toBe(0)
    expect(result.nodes.get("b1")?.lane).toBe(0)
    expect(result.openLanes).toEqual([])
  })

  test("handles an octopus merge with three parents", () => {
    const commits = [
      { hash: "m", parents: ["a", "b", "c"] },
      { hash: "c", parents: ["base"] },
      { hash: "b", parents: ["base"] },
      { hash: "a", parents: ["base"] },
      { hash: "base", parents: [] },
    ]
    const result = graph.computeGraph(commits)
    const merge = result.nodes.get("m")
    expect(merge?.out.map((edge) => edge.to).sort((x, y) => x - y)).toEqual([0, 1, 2])
    const baseLane = result.nodes.get("base")?.lane
    expect(baseLane).toBeDefined()
    for (const parent of ["a", "b", "c"]) {
      expect(result.nodes.get(parent)?.out.some((edge) => edge.to === baseLane)).toBe(true)
    }
    expect(result.openLanes).toEqual([])
  })

  test("reserves a lane for unloaded parents as the page frontier", () => {
    const commits = [{ hash: "child", parents: ["unloaded-parent"] }]
    const result = graph.computeGraph(commits)
    expect(result.openLanes).toHaveLength(1)
    expect(result.rows[0]?.after.filter(Boolean)).toContain("unloaded-parent")
  })

  test("first-parent mode draws only the first parent edge", () => {
    const commits = [
      { hash: "m", parents: ["b", "s"] },
      { hash: "s", parents: ["b"] },
      { hash: "b", parents: [] },
    ]
    const result = graph.computeGraph(commits, { firstParent: true })
    expect(result.nodes.get("m")?.out).toEqual([{ to: 0, curve: false }])
    // The side commit has no drawn parent edge; it occupies its own lane.
    expect(result.nodes.get("s")?.lane).toBe(1)
  })

  test("closes a previously open edge when the parent arrives on the next page", () => {
    const firstPage = graph.computeGraph([{ hash: "child", parents: ["p"] }])
    expect(firstPage.openLanes).toHaveLength(1)
    const secondPage = graph.computeGraph([
      { hash: "child", parents: ["p"] },
      { hash: "p", parents: [] },
    ])
    const parentLane = secondPage.nodes.get("p")?.lane
    expect(secondPage.nodes.get("child")?.out.some((edge) => edge.to === parentLane)).toBe(true)
    expect(secondPage.openLanes).toEqual([])
  })

  test("rows carry before/after columns for rendering", () => {
    const result = graph.computeGraph([
      { hash: "m", parents: ["b", "s"] },
      { hash: "s", parents: ["b"] },
      { hash: "b", parents: [] },
    ])
    const mergeRow = result.rows.find((row) => row.hash === "m")
    expect(mergeRow?.before.filter(Boolean)).toContain("m")
    expect(mergeRow?.parents).toBe(2)
  })
})
