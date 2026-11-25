import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "../src/config"
import { ConfigV1 } from "../src/v1/config/config"
import { ConfigMigrateV1 } from "../src/v1/config/migrate"
import { boundedToolDetails, reviewerDetails, toolDetailsMetadata } from "../src/util/tool-details"

for (const value of [true, false]) {
  test(`keeps live progress ${value} through the V1/V2 config boundary`, () => {
    const legacy = Schema.decodeUnknownSync(ConfigV1.Info)({ experimental: { tool_live_progress: value } })
    const migrated = ConfigMigrateV1.migrate(legacy)
    const current = Schema.decodeUnknownSync(Config.Info)(migrated)
    expect(current.experimental?.tool_live_progress).toBe(value)
  })
}

test("allowlists shell display fields including warnings and only managed capture references", () => {
  const details = toolDetailsMetadata("bash", {
    output: "first",
    warnings: ["external directory", 12],
    private: "hidden",
    capture: { uri: "https://untrusted.invalid/secret", complete: true },
  })
  expect(details).toEqual({ output: "first", warnings: ["external directory"] })
})

test("handles invalid and duplicate reviewer data without inventing session links", () => {
  // Missing/foreign state values stay visible as "unknown" instead of hiding the row.
  expect(reviewerDetails({ reviewers: [null, { reviewer: { model: "test" }, state: "invalid" }] })).toEqual([
    { model: "test", state: "unknown" },
  ])
  expect(
    reviewerDetails({
      results: [
        {
          reviewer: { model: "same" },
          status: "error",
          task: { state: "error", sessionID: "ses_predicted", text: "failed before spawn" },
        },
      ],
    })[0],
  ).not.toHaveProperty("sessionID")
  const rows = reviewerDetails({
    reviewers: [0, 1].map(() => ({ reviewer: { model: "same" }, state: "running", sessionID: "javascript:bad" })),
  })
  expect(rows).toHaveLength(2)
  expect(rows[0]).not.toHaveProperty("sessionID")
})

test("preserves partial and repaired provenance without leaking arbitrary recovery metadata", () => {
  const base = { reviewer: { model: "test/model" }, task: { state: "error", text: "Schema failure" },
    recovery: { source: "original", original: '{"findings":[]}', issues: ["Missing notes"], findings: [{ title: "Issue" }], secret: "do not forward" } }
  const details = reviewerDetails({ results: [
    { ...base, status: "partial" },
    { ...base, status: "success", recovery: { ...base.recovery, source: "repaired", repaired: '{"findings":[{"title":"Issue"}],"notes":[]}' } },
  ] })
  expect(details.map((item) => item.state)).toEqual(["partial", "repaired"])
  expect(details[0]?.text).toContain("Issue")
  expect(details[0]?.recovery).not.toHaveProperty("secret")
  expect(details[1]?.recovery?.repaired).toContain("Issue")
  const bounded = boundedToolDetails("multi_agent_fanout", { results: [
    { ...base, status: "partial", recovery: { ...base.recovery, original: "x".repeat(100000) } },
  ] })
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(66000)
  expect(reviewerDetails(bounded as Record<string, unknown>)[0]?.recovery?.original).toContain("Preview shortened")
})

test("keeps bounded reviewer identities and readable results alongside an externalized original", () => {
  const raw = {
    workflow: "review",
    results: [
      {
        reviewer: { model: "test/model" },
        sessionID: "ses_actual",
        status: "success",
        task: { state: "completed", text: "x".repeat(300000) },
        result: { findings: [], notes: ["x".repeat(300000)] },
      },
    ],
  }
  const snapshot = boundedToolDetails("multi_agent_fanout", raw)
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(66000)
  const details = toolDetailsMetadata("multi_agent_fanout", {
    $opencode: { type: "content-reference" },
    toolDetails: snapshot,
  })
  expect(details.reviewers).toMatchObject([{ model: "test/model", sessionID: "ses_actual", state: "completed" }])
  expect(reviewerDetails(details)[0]?.text).toContain("[Preview shortened; open the agent session for the full result]")
})
