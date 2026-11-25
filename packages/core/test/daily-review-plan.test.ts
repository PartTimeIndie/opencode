import { expect, test } from "bun:test"
import { dailyReviewSnapshotBindings } from "../src/tool/daily-review-plan"

const bindings = [
  "- runId: `morning-run`",
  "- runDate: `2026-10-05`",
  "- planId: `plan-1`",
  "- morningRunId: `morning-run`",
].join("\n")
const accepted = [
  "## Angenommene Punkte",
  "### itemId `item-1`",
  `- approvalId: \`${"a".repeat(64)}\``,
  "autoApply=false; implementation status: blocked",
  "### A second accepted item",
  "- **itemId:** `item-2`",
  `- **approvalId:** \`${"b".repeat(64)}\` (approvalVersion 2)`,
].join("\n")
const markdown = `${bindings}\n${accepted}`

test("reads explicit bindings in stable order, retaining blocked and manual accepted items", () => {
  const result = dailyReviewSnapshotBindings(markdown)
  expect(result).toMatchObject({ runId: "morning-run", runDate: "2026-10-05", planId: "plan-1", morningRunId: "morning-run" })
  expect([...result!.acceptedItems]).toEqual([["item-1", "a".repeat(64)], ["item-2", "b".repeat(64)]])
  expect(dailyReviewSnapshotBindings(markdown.replace(/\n/g, "\r\n"))).toEqual(result)
  expect(dailyReviewSnapshotBindings(markdown.replace(/- (runId|runDate|planId|morningRunId):/g, "- **$1:**"))).toEqual(result)
})

test("does not infer missing bindings from an otherwise readable morning plan", () => {
  const invalid = [
    bindings.replace(/- /g, "").replace(/`/g, "") + "\n" + accepted,
    `${bindings}\n## Angenommen (1)\n- itemId: item-1 | approvalId: ${"a".repeat(64)}`,
    markdown.replace("`" + "a".repeat(64) + "`", "not-an-approval"),
    markdown.replace("- **itemId:** `item-2`", ""),
    markdown.replace("### itemId `item-1`", "### itemId `item-2`"),
    markdown.replace("b".repeat(64), "a".repeat(64)),
    `- runId: \`another-run\`\n${markdown}`,
    `${markdown}\n### Item without an approval`,
  ]
  for (const candidate of invalid) expect(dailyReviewSnapshotBindings(candidate)).toBeUndefined()
})

test("only accepted sections supply item bindings, including the supported table format", () => {
  const table = [
    bindings,
    "## Angenommen (1)",
    "| itemId | Änderung | approvalId |",
    "| --- | --- | --- |",
    `| item-1 | Accepted | \`${"a".repeat(64)}\` |`,
  ].join("\n")
  expect([...dailyReviewSnapshotBindings(table)!.acceptedItems]).toEqual([["item-1", "a".repeat(64)]])
  for (const heading of ["Abgelehnt", "Zurückgestellt", "Blockiert", "Terminal fehlgeschlagen", "Alternativen"]) {
    const excluded = `## ${heading}\n### itemId \`other-item\`\n- approvalId: \`${"c".repeat(64)}\``
    expect(dailyReviewSnapshotBindings(`${markdown}\n${excluded}`)?.acceptedItems.size).toBe(2)
    expect(dailyReviewSnapshotBindings(`${bindings}\n${excluded}`)).toBeUndefined()
  }
})
