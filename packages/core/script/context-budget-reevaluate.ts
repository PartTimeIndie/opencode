// Deterministic re-evaluation only. Original provider ledgers are never rewritten.
import "../src/session"
import path from "node:path"
import { Schema } from "effect"
import { evaluate } from "./context-budget-scenarios"
import { ContextBudget } from "../src/util/context-budget"

const args = process.argv.slice(2)
const ledgers = args.flatMap((arg, index) => (arg === "--ledger" && args[index + 1] ? [args[index + 1]] : []))
const output = args.includes("--output") ? args[args.indexOf("--output") + 1] : undefined
if (!ledgers.length || !output)
  throw new Error("Usage: --ledger <original.json> [--ledger <original.json>] --output <new.json>")
if ((await Bun.file(output).exists()) || ledgers.some((file) => path.resolve(file) === path.resolve(output)))
  throw new Error("Refusing to overwrite evidence")
const Ledger = Schema.Struct({
  scenarios: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      variant: Schema.String,
      passed: Schema.Boolean,
      actions: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          input: Schema.Record(Schema.String, Schema.Unknown),
          result: Schema.String,
        }),
      ),
      text: Schema.Array(Schema.String),
    }),
  ),
})
const results = await Promise.all(
  ledgers.map(async (file) => {
    const raw = await Bun.file(file).text()
    const ledger = Schema.decodeUnknownSync(Schema.fromJsonString(Ledger))(raw)
    return {
      source: file,
      sha256: ContextBudget.measure(raw).sha256,
      scenarios: ledger.scenarios.map((scenario) => ({
        id: scenario.id,
        variant: scenario.variant,
        originalPassed: scenario.passed,
        reevaluatedPassed: evaluate(scenario.id, [...scenario.actions], [...scenario.text]),
      })),
    }
  }),
)
await Bun.write(
  output,
  JSON.stringify(
    {
      kind: "offline-assertion-reevaluation-not-new-model-runs",
      reason:
        "Count concrete successful skill loads, not group openings; excluded reference mentions are not reads. Denied, unknown and malformed skill calls remain red.",
      results,
    },
    null,
    2,
  ) + "\n",
)
console.log(
  JSON.stringify(
    results.map((result) => ({
      source: result.source,
      passed: result.scenarios.filter((scenario) => scenario.reevaluatedPassed).length,
      total: result.scenarios.length,
    })),
  ),
)
