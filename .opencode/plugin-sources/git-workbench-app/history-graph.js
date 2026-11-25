/**
 * Deterministic commit graph layout for the Git Workbench history list.
 *
 * Input is a topologically ordered page of commits (newest first) with their
 * original parent OIDs. Lanes are derived from real parent edges only — never
 * from ref names. The layout is incremental across pages: a parent that is not
 * loaded yet reserves its lane so the next page can close the edge instead of
 * re-shuffling history.
 */

const MAX_LANES = 24

export function computeGraph(commits, options = {}) {
  const firstParentOnly = options.firstParent === true
  const columns = []
  const nodes = new Map()
  const rows = []
  let maxLane = 0
  const indexOf = (hash) => columns.indexOf(hash)
  const allocate = (hash, searchFrom = 0) => {
    for (let i = Math.max(0, searchFrom); i < columns.length; i++) {
      if (columns[i] === null) {
        columns[i] = hash
        return i
      }
    }
    columns.push(hash)
    return columns.length - 1
  }
  const free = (lane) => {
    if (lane >= 0 && lane < columns.length) columns[lane] = null
  }

  for (const commit of commits) {
    if (!commit || typeof commit.hash !== "string") continue
    const parents = firstParentOnly ? (commit.parents || []).slice(0, 1) : commit.parents || []
    let lane = indexOf(commit.hash)
    if (lane === -1) lane = allocate(commit.hash)
    if (lane + 1 > maxLane) maxLane = lane + 1
    const before = columns.slice()

    // A merge may have reserved extra columns that point at this commit;
    // their lines curve into the node and are freed afterwards.
    const inFrom = []
    for (let c = 0; c < columns.length; c++) {
      if (c !== lane && columns[c] === commit.hash) {
        inFrom.push(c)
        columns[c] = null
      }
    }

    const out = []
    if (parents.length === 0) {
      free(lane)
    } else {
      const [first, ...rest] = parents
      const existingFirst = indexOf(first)
      if (existingFirst !== -1) {
        out.push({ to: existingFirst, curve: existingFirst !== lane })
        if (existingFirst !== lane) free(lane)
      } else {
        columns[lane] = first
        out.push({ to: lane, curve: false })
      }
      for (const parent of rest) {
        const target = indexOf(parent)
        if (target !== -1) {
          out.push({ to: target, curve: true })
          continue
        }
        if (columns.length >= MAX_LANES) {
          out.push({ to: lane, curve: false, clipped: true })
          continue
        }
        const targetLane = allocate(parent, lane - 1)
        if (targetLane === lane) {
          out.push({ to: lane, curve: false })
          continue
        }
        columns[targetLane] = parent
        out.push({ to: targetLane, curve: true })
        if (targetLane + 1 > maxLane) maxLane = targetLane + 1
      }
    }
    nodes.set(commit.hash, { lane, inFrom, out })
    rows.push({ hash: commit.hash, lane, parents: parents.length, before, after: columns.slice() })
  }
  const openLanes = []
  columns.forEach((hash, lane) => {
    if (hash !== null) openLanes.push(lane)
  })
  return { nodes, rows, columns: columns.slice(), openLanes, maxLane }
}
