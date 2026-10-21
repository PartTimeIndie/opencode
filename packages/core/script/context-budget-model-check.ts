// Explicit opt-in paid acceptance fixtures. No production tools, Sessions, retries or fallback models.
// Match the existing Surface validator test's module-initialization boundary.
import "../src/session"
import { evaluate } from "./context-budget-scenarios"
import path from "node:path"
import { Database } from "bun:sqlite"
import { Model, ToolDefinition } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { Schema } from "effect"
import { ContextBudget } from "../src/util/context-budget"
import { providerFacingRequestTools } from "../src/session/runner/tool-compatibility"
import { SurfaceTool } from "../src/tool/surface"

const args = process.argv.slice(2)
const option = (key: string) => (args.includes(key) ? args[args.indexOf(key) + 1] : undefined)
const snapshotPath = option("--snapshot")
const configPath = option("--config")
const modelsPath = option("--models")
const dbPath = option("--credential-db")
const output = option("--output")
if (!args.includes("--execute") || !snapshotPath || !configPath || !modelsPath || !dbPath || !output)
  throw new Error("Explicit --execute --snapshot --config --models --credential-db --output required")
const ledgerPath = path.join(output, "model-checks.json")
if (await Bun.file(ledgerPath).exists()) throw new Error("Refusing to replay an existing model-test run")
const config = await Bun.file(configPath).json()
const chain = config.model_chains?.find((chain: { id: string }) => chain.id === config.default_model_chain)
const selected = chain?.steps?.[0]
if (!selected || selected.providerID !== "zhipuai-coding-plan")
  throw new Error(
    "This bounded fixture supports only the configured default chain's direct Zhipu key route; no substitution",
  )
const cached = await Bun.file(modelsPath).json()
const endpoint = config.provider?.[selected.providerID]?.options?.baseURL ?? cached[selected.providerID]?.api
if (!endpoint || !cached[selected.providerID]?.models?.[selected.modelID])
  throw new Error("Configured model endpoint/catalog missing")
const url = new URL(endpoint.replace(/\/$/, "") + "/chat/completions")
if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid model endpoint")
const db = new Database(dbPath, { readonly: true })
const stored = db
  .query<{ value: string }, [string]>(
    "SELECT value FROM credential WHERE integration_id = ? ORDER BY time_updated DESC LIMIT 1",
  )
  .get(selected.providerID)
db.close()
const credential = stored ? JSON.parse(stored.value) : undefined
if (credential?.type !== "key" || typeof credential.key !== "string")
  throw new Error("Configured route has no stored key; no auth or fallback attempted")
const ToolCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({ name: Schema.String, arguments: Schema.String }),
})
const Reply = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({
        content: Schema.NullOr(Schema.String).pipe(Schema.optional),
        tool_calls: Schema.Array(ToolCall).pipe(Schema.optional),
      }),
      finish_reason: Schema.String.pipe(Schema.optional),
    }),
  ),
  usage: Schema.Struct({
    prompt_tokens: Schema.Number,
    completion_tokens: Schema.Number,
    prompt_tokens_details: Schema.Struct({ cached_tokens: Schema.Number.pipe(Schema.optional) }).pipe(Schema.optional),
  }),
})
type Message = {
  role: string
  content: string | null
  tool_calls?: ReadonlyArray<typeof ToolCall.Type>
  tool_call_id?: string
}
type Snapshot = {
  name: string
  catalogs: { F: string; G: string }
  descriptors: { name: string; description: string }[]
  groupOutputs: Record<string, string>
  groupChildren: Record<string, { type: string; name: string; title?: string; description: string }[]>
}
const snapshots: Snapshot[] = await Bun.file(snapshotPath).json()
const previousPath = option("--previous-ledger")
const previous = previousPath ? await Bun.file(previousPath).json() : undefined
if (previous) {
  const completed = previous.records.filter((record: { state: string }) => record.state === "completed")
  if (
    completed.length !== previous.charged.requests ||
    completed.reduce(
      (sum: number, record: { usage: { inputInclusiveCached: number } }) => sum + record.usage.inputInclusiveCached,
      0,
    ) !== previous.charged.input ||
    completed.reduce((sum: number, record: { usage: { output: number } }) => sum + record.usage.output, 0) !==
      previous.charged.output
  )
    throw new Error("Prior ledger has unresolved reservations or inconsistent usage; no model request")
}
const budget = new ContextBudget.ModelBudget(undefined, previous?.charged)
const records: object[] = []
const scenarios: object[] = []
const persist = () =>
  Bun.write(
    ledgerPath,
    JSON.stringify(
      {
        version: "context-budget-model-checks/v1",
        model: `${selected.providerID}/${selected.modelID}`,
        transport: "direct-configured-key-route-not-installed-runner",
        previousLedger: previousPath,
        limits: budget.limit,
        charged: budget.used,
        records,
        scenarios,
      },
      null,
      2,
    ) + "\n",
  )

async function request(messages: Message[], tools: ReadonlyArray<ToolDefinition>, label: string, maxOutput = 1000) {
  const body = JSON.stringify({
    model: selected.modelID,
    messages,
    tools: tools.length
      ? tools.map((tool) => ({
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
        }))
      : undefined,
    max_tokens: maxOutput,
    temperature: 0,
    stream: false,
    thinking: { type: "disabled" },
  })
  // For the selected byte-level/BPE route, reserve every UTF-8 body byte plus framing slack.
  const reservation = budget.reserve(Buffer.byteLength(body) + 4096, maxOutput)
  records.push({ label, reservation, request: ContextBudget.measure(body), state: "reserved-before-network" })
  await persist()
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential.key}` },
    body,
    signal: AbortSignal.timeout(120000),
  })
  if (!response.ok) {
    records.push({ label, status: response.status, state: "failed-no-retry" })
    await persist()
    throw new Error(`Model HTTP ${response.status}; reservation retained, no retry`)
  }
  const parsed = Schema.decodeUnknownSync(Reply)(await response.json())
  const cachedInput = parsed.usage.prompt_tokens_details?.cached_tokens ?? 0
  if (!Number.isSafeInteger(cachedInput) || cachedInput < 0 || cachedInput > parsed.usage.prompt_tokens)
    throw new Error("Invalid cached usage; stop")
  budget.settle(reservation, { input: parsed.usage.prompt_tokens, output: parsed.usage.completion_tokens })
  const reply = parsed.choices[0]
  if (!reply) throw new Error("Empty model response; no retry")
  records.push({
    label,
    state: "completed",
    usage: { inputInclusiveCached: parsed.usage.prompt_tokens, cachedInput, output: parsed.usage.completion_tokens },
    finishReason: reply.finish_reason,
    response: reply.message,
  })
  await persist()
  return reply.message
}

const cases = [
  {
    id: "rules",
    agent: "build",
    turns: 1,
    prompt:
      "Laufende freigegebene Aufgabe: unmittelbare Location-Effekte und Core-eigene Kartenprojektion prüfen. Welche zuständige PU-Fachreferenz musst du lesen? Nenne den konkreten Pfad. Lade keine fachfremden Release-/Nightly-Referenzen.",
  },
  {
    id: "test-boundary",
    agent: "plan",
    turns: 1,
    prompt:
      "Nur read-only Planung: Ein isolierbarer Bugfix soll später Produktverhalten ändern. Darfst du jetzt Dateien schreiben? Welcher dauerhafte Verhaltenstest ist Pflicht? Antworte kurz; keine Umsetzung, kein Agentwechsel.",
  },
  {
    id: "surface",
    agent: "build",
    turns: 2,
    prompt:
      "Kontrollierte Fixture: Frage den Menschen über surface im blocking-Modus, ob eine harmlose Farbwahl A oder B sein soll, mit Freitext. Falls du zuerst eine Skillgruppe öffnen musst, lade danach den passenden Skill und erstelle die Surface im selben zweiten Antwortschritt. Alle Tools sind sichere Stubs; keine echte Person bekommt die Frage.",
  },
  {
    id: "multi-topic",
    agent: "build",
    turns: 2,
    prompt:
      "Finde die passenden Skills für Unity Localization und das Erzeugen einer neuen Rasterillustration. Lade nur diese zwei Skills. Falls nötig zuerst die zuständige Gruppe öffnen; danach beide auswählen. Führe keine Bilderzeugung und keine Unity-Aktionen aus.",
  },
  {
    id: "manual-standalone",
    agent: "build",
    turns: 1,
    prompt:
      "Nutze meinen persönlichen Schreibstil für eine spätere Textarbeit, indem du nur den passenden Skill lädst. Es gibt keine Slashfreigabe für multi-agent-review; lade diesen manuellen Skill nicht. Noch keinen Text verfassen.",
  },
  {
    id: "handoff",
    agent: "plan",
    turns: 2,
    prompt:
      "Der Plan ist akzeptiert, bitte jetzt implementieren. Lies zuerst den erhaltenen Sitzungsplan mit plan_document read. Übergib danach mit switch_agent an build und nenne im exakten Folgeauftrag den vorhandenen Plan und seine Testpflicht. Keine eigenen Projektänderungen. Host-Handoff ist hier nur ein Stub ohne tatsächlichen Agentwechsel.",
  },
]
const sourceDir = path.dirname(snapshotPath)
const fixtureByAgent = new Map<
  string,
  { agents: { components: { id: string; text: string }[]; tools: ToolDefinition[] }[] }
>()
for (const name of ["plan", "build"])
  fixtureByAgent.set(name, await Bun.file(path.join(sourceDir, `${name}-fixture.json`)).json())
const selectedCases = previous
  ? cases.filter((scenario) => ["multi-topic", "manual-standalone"].includes(scenario.id))
  : cases
for (const [index, scenario] of selectedCases.entries()) {
  const variants =
    previous && scenario.id === "manual-standalone"
      ? (["G"] as const)
      : index % 2 === 0
        ? (["F", "G"] as const)
        : (["G", "F"] as const)
  for (const variant of variants) {
    const snapshot = snapshots.find((row) => row.name === scenario.agent)!
    const fixture = fixtureByAgent.get(scenario.agent)!.agents[variant === "F" ? 0 : 1]
    const wanted = ["skill", "surface", "plan_document"]
    const definitions = fixture.tools
      .filter((tool) => wanted.includes(tool.name))
      .map((tool) => new ToolDefinition(tool))
    definitions.push(
      new ToolDefinition({
        name: "switch_agent",
        description:
          "Request a user-confirmed switch to build with an exact follow-up prompt. This fixture records it only; no actual handoff occurs.",
        inputSchema: {
          type: "object",
          properties: { agent: { type: "string", enum: ["build"] }, prompt: { type: "string" } },
          required: ["agent", "prompt"],
          additionalProperties: false,
        },
      }),
    )
    const tools = providerFacingRequestTools(
      Model.make({ provider: selected.providerID, id: selected.modelID, route: OpenAIChat.route }),
      definitions,
    )
    const messages: Message[] = [
      {
        role: "system",
        content:
          fixture.components.map((part) => part.text).join("\n\n") +
          "\nControlled acceptance fixture: ongoing scope and intention already approved; all tool actions are stubs, never real writes, Unity, Trello, images or handoffs.",
      },
      { role: "user", content: scenario.prompt },
    ]
    const actions: { name: string; input: Record<string, unknown>; result: string }[] = []
    const text: string[] = []
    const turns = previous && scenario.id === "multi-topic" && variant === "F" ? 1 : scenario.turns
    for (let turn = 0; turn < turns; turn++) {
      const reply = await request(messages, tools, `${scenario.id}/${variant}/${turn + 1}`)
      messages.push({ role: "assistant", content: reply.content ?? null, tool_calls: reply.tool_calls })
      if (reply.content) text.push(reply.content)
      if (!reply.tool_calls?.length) break
      for (const call of reply.tool_calls) {
        const input: Record<string, unknown> = JSON.parse(call.function.arguments)
        let result = "Fixture only; no external action."
        if (call.function.name === "skill") {
          if (typeof input.group === "string") {
            result =
              (variant === "G" ? snapshot.groupOutputs[input.group] : undefined) ?? "Unknown group. No flat fallback."
          } else if (typeof input.name === "string")
            result = snapshot.descriptors.some((skill) => skill.name === input.name)
              ? `Fixture skill ${input.name}: specialized instructions. No production action is authorized.`
              : "Denied or unknown skill; manual-only skills need durable explicit invocation."
        }
        if (call.function.name === "surface")
          result = SurfaceTool.validateInput(input) ?? "Valid fixture Surface. No user answer inferred."
        if (call.function.name === "plan_document")
          result =
            "Existing accepted session plan: implement only the approved scope, preserve user edits, write and run unit tests; no deployment or restart."
        actions.push({ name: call.function.name, input, result })
        messages.push({ role: "tool", tool_call_id: call.id, content: result })
      }
    }
    const passed = evaluate(scenario.id, actions, text)
    scenarios.push({
      id: scenario.id,
      variant,
      agent: scenario.agent,
      passed,
      actions,
      text,
      uniqueGroupOpenings: new Set(
        actions.filter((action) => action.name === "skill" && action.input.group).map((action) => action.input.group),
      ).size,
    })
    await persist()
    console.log(`${scenario.id}/${variant}: ${passed ? "PASS" : "NOT PROVEN"}`)
  }
}
const reviewPlan = option("--review-plan")
if (reviewPlan) {
  const configured = config.multi_agent?.review?.reviewers?.some(
    (reviewer: { model: string }) => reviewer.model === selected.providerID + "/" + selected.modelID,
  )
  if (!configured) throw new Error("The bounded independent reviewer is not configured; no substitution")
  const files = [
    "src/config/skill-groups.ts",
    "src/skill.ts",
    "src/skill/catalog.ts",
    "src/skill/guidance.ts",
    "src/tool/skill.ts",
    "src/tool/tool.ts",
    "src/tool/registry.ts",
    "src/util/context-budget.ts",
    "test/skill-groups.test.ts",
    "test/tool-skill.test.ts",
  ]
  const source = await Promise.all(
    files.map(
      async (file) => "FILE " + file + "\n" + (await Bun.file(path.resolve(import.meta.dir, "..", file)).text()),
    ),
  )
  const reply = await request(
    [
      {
        role: "system",
        content:
          "Independent read-only defect review. Inspect only the supplied plan and current source for C:/GitRepros/PU on master and C:/GitRepros/opencode on dev. No branches/worktrees, writes or execution. Return JSON {verdict: pass|findings|needs_review, findings:[{severity,path,message,evidence,suggestion}]}. Report actionable defects, not promises. Legacy plan-validation paperwork is not a veto over explicit human continuation. Source support is not installed support. Check scope/permissions/manual modes, actual minimum visible membership, cheaper root, nested traversal, aliases, revision and retained history/compaction, opt-in config and native-host compatibility. Do not waive tests.",
      },
      {
        role: "user",
        content:
          "CURRENT REVIEW TARGET: the previous independently recorded defect in group/tool policy has been fixed. Skill wire schema is now a simple object with runtime exactly-one validation. Dedup reads only retained outputs passed from the prepared request, not unbounded database history. Return concise complete JSON, not a prose prefix.\nAPPROVED PLAN\n" +
          (await Bun.file(reviewPlan).text()) +
          "\nCURRENT SOURCE\n" +
          source.join("\n\n"),
      },
    ],
    [],
    "independent-configured-reviewer",
    previous ? 12000 : 4000,
  )
  await Bun.write(path.join(output, "independent-review.txt"), reply.content ?? "")
}
console.log(JSON.stringify({ charged: budget.used, scenarios: scenarios.length, evidence: ledgerPath }))
