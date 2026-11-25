// The host preflight and local admission adapter use the same explicit Markdown
// bindings. Parsing is not authorization: host receipts and Coordinator checks
// must still bind the unchanged snapshot before any work is admitted.
export function dailyReviewSnapshotBindings(markdown: string) {
  const values = new Map<string, string>()
  const acceptedItems = new Map<string, string>()
  const acceptedApprovalIds = new Set<string>()
  let inAcceptedSection = false
  let currentItemId = ""
  let awaitingItemId = false
  let acceptedTable = false
  let invalid = false
  for (const sourceLine of markdown.split(/\r?\n/)) {
    // Markdown emphasis changes presentation, not the explicit binding key.
    const line = sourceLine.replace(/^(\s*-\s+)\*\*((?:runId|runDate|planId|morningRunId|itemId|approvalId):)\*\*(\s+)/, "$1$2$3")
    const section = line.match(/^##\s+(.+?)\s*$/)
    if (section) {
      if (currentItemId || awaitingItemId) invalid = true
      inAcceptedSection = /^(?:Angenommene?\b|Weitere\s+\d+\s+angenommene\s+Punkte\b)/i.test(section[1])
      currentItemId = ""
      awaitingItemId = false
      acceptedTable = false
      continue
    }
    if (!inAcceptedSection) {
      const header = line.match(/^\s*-\s+(runId|runDate|planId|morningRunId):\s+`([^`]+)`\s*$/)
      if (header) {
        if (values.has(header[1])) invalid = true
        values.set(header[1], header[2])
      }
      continue
    }
    const itemHeading = line.match(/^###\s+itemId\s+`([^`]+)`\s*(?:—.*)?$/)
    if (/^###\s+/.test(line)) {
      if (currentItemId || awaitingItemId) invalid = true
      currentItemId = itemHeading?.[1] ?? ""
      awaitingItemId = !itemHeading
      continue
    }
    const itemField = line.match(/^\s*-\s+itemId:\s+`([^`]+)`\s*$/)
    if (itemField) {
      if (currentItemId) invalid = true
      currentItemId = itemField[1]
      awaitingItemId = false
      continue
    }
    // Human-readable version notes do not change the explicit approval ID.
    const itemApproval = line.match(/^\s*-\s+approvalId:\s+`([a-f0-9]{64})`(?:\s+\([^`\r\n]*\))?\s*$/)
    if (itemApproval && !currentItemId) invalid = true
    if (currentItemId && itemApproval) {
      if (acceptedItems.has(currentItemId) || acceptedApprovalIds.has(itemApproval[1])) invalid = true
      else {
        acceptedItems.set(currentItemId, itemApproval[1])
        acceptedApprovalIds.add(itemApproval[1])
      }
      currentItemId = ""
      continue
    }
    const cells = line.startsWith("|") ? line.split("|").slice(1, -1).map((cell) => cell.trim()) : []
    if (cells[0] === "itemId" && cells[cells.length - 1] === "approvalId") {
      acceptedTable = true
      continue
    }
    if (acceptedTable && cells.length >= 3) {
      const itemId = cells[0].replace(/^`|`$/g, "")
      const approvalId = cells[cells.length - 1].replace(/\s+\([^`\r\n]*\)$/, "").replace(/^`|`$/g, "")
      if (/^-+$/.test(itemId.replace(/\s/g, "")) || /^-+$/.test(approvalId.replace(/\s/g, ""))) continue
      if (!itemId || !/^[a-f0-9]{64}$/.test(approvalId) || acceptedItems.has(itemId) || acceptedApprovalIds.has(approvalId)) invalid = true
      else {
        acceptedItems.set(itemId, approvalId)
        acceptedApprovalIds.add(approvalId)
      }
      continue
    }
    if (acceptedTable && !line.startsWith("|")) acceptedTable = false
  }
  if (currentItemId || awaitingItemId || invalid || ["runId", "runDate", "planId", "morningRunId"].some((key) => !values.get(key)) || !acceptedItems.size)
    return undefined
  return {
    runId: values.get("runId")!,
    runDate: values.get("runDate")!,
    planId: values.get("planId")!,
    morningRunId: values.get("morningRunId")!,
    acceptedItems,
  }
}

export const dailyReviewPlanFormatError = [
  "Daily Review plan format is unreadable; correct the plan with plan_document before requesting confirmation.",
  "Use separate list fields with backtick-quoted values: - runId: `...`, - runDate: `...`, - planId: `...`, - morningRunId: `...`.",
  "Under ## Angenommene Punkte, give each item its own ### heading followed by separate - itemId: `...` and - approvalId: `...` fields (approvalId: 64 lowercase hex characters).",
  "Do not combine itemId and approvalId on one line. Preserve the exact saved accepted set and IDs; do not infer missing bindings or change historical answers/receipts.",
].join(" ")
