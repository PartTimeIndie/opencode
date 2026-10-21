import path from "node:path"
import { mkdir } from "node:fs/promises"
import { Schema } from "effect"
import { ContextBudget } from "../src/util/context-budget"

const Tool = Schema.Struct({
  name: Schema.String,
  description: Schema.String.pipe(Schema.optional),
  inputSchema: Schema.Unknown.pipe(Schema.optional),
  outputSchema: Schema.Unknown.pipe(Schema.optional),
})
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const Fixture = Schema.Struct({
  agents: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      boundary: Schema.Literals(["materialized-definitions", "prepared-runner", "captured-provider-body"]),
      components: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
      tools: Schema.Array(Tool),
      capturedBody: Schema.String.pipe(Schema.optional),
      usage: Schema.Struct({ input: Count, cachedInput: Count, output: Count }).pipe(Schema.optional),
    }),
  ),
})
const args = process.argv.slice(2)
const input = args[args.indexOf("--fixture") + 1]
const output = args[args.indexOf("--output") + 1]
if (!args.includes("--fixture") || !args.includes("--output") || !input || !output)
  throw new Error("Usage: bun script/context-budget-audit.ts --fixture <json> --output <directory>")
const fixture = Schema.decodeUnknownSync(Fixture)(await Bun.file(input).json())
await mkdir(output, { recursive: true })
await Bun.write(
  path.join(output, "context-budget-audit.json"),
  JSON.stringify(ContextBudget.audit(fixture), null, 2) + "\n",
)
console.log(
  `Context audit written to ${path.join(output, "context-budget-audit.json")}; no raw prompts or schemas stored.`,
)
