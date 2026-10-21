#!/usr/bin/env bun

/**
 * Multi-model benchmark runner.
 * Runs code-analysis prompts against different model configs,
 * measures timing, and scores answer quality with keyword matching.
 *
 * Usage:
 *   cd packages/opencode
 *   bun run script/benchmark-models.ts
 *
 * Filter models:  FILTER_MODEL="Big Pickle,Nemotron 3"
 * Filter groups:  FILTER_GROUP=ZEN
 * Timeout per run (ms): TIMEOUT=120000
 * Fast mode (1 question only): FAST=1
 */

import { join } from "path"
import { spawnSync } from "child_process"

// ── Config ──────────────────────────────────────────────────────────────────

interface ModelEntry {
  label: string
  model: string
  variant?: string
  group: string
}

interface Question {
  id: string
  title: string
  prompt: string
  keyTerms: string[]
}

const MODELS: ModelEntry[] = [
  { label: "GPT-5.5 Low",     model: "openai/gpt-5.5",            variant: "low",    group: "Codex GPT-5.5" },
  { label: "GPT-5.5 Medium",  model: "openai/gpt-5.5",            variant: "medium", group: "Codex GPT-5.5" },
  { label: "GPT-5.5 High",    model: "openai/gpt-5.5",            variant: "high",   group: "Codex GPT-5.5" },
  { label: "GPT-5.5 XHigh",   model: "openai/gpt-5.5",            variant: "xhigh",  group: "Codex GPT-5.5" },
  { label: "Spark Medium",    model: "openai/gpt-5.3-codex-spark", variant: "medium", group: "Codex Spark" },
  { label: "Spark XHigh",     model: "openai/gpt-5.3-codex-spark", variant: "xhigh",  group: "Codex Spark" },
  { label: "Big Pickle",      model: "opencode/big-pickle",                        group: "ZEN" },
  { label: "DeepSeek V4",     model: "opencode/deepseek-v4-flash-free",             group: "ZEN" },
  { label: "MiMo V2.5",       model: "opencode/mimo-v2.5-free",                    group: "ZEN" },
  { label: "Nemotron 3",      model: "opencode/nemotron-3-ultra-free",              group: "ZEN" },
  { label: "Free GPT Mini",   model: "openrouter/~openai/gpt-mini-latest",         group: "OpenRouter" },
  { label: "Free Sonnet",     model: "openrouter/~anthropic/claude-sonnet-latest",  group: "OpenRouter" },
]

// ── Questions (keep prompts short enough for limited-context models) ────────

const QUESTIONS: Question[] = [
  {
    id: "q1-rate-limiter",
    title: "Rate limiter algorithm analysis",
    prompt: `Analyze this TypeScript rate limiter:

\`\`\`typescript
class RateLimiter {
  private hits: Map<string, number[]> = new Map()
  constructor(private maxRequests: number, private windowMs: number) {}
  check(key: string): boolean {
    const now = Date.now()
    const timestamps = (this.hits.get(key) ?? []).filter(t => now - t < this.windowMs)
    if (timestamps.length >= this.maxRequests) return false
    timestamps.push(now)
    this.hits.set(key, timestamps)
    return true
  }
}
\`\`\`

Identify the bug in this implementation and explain why it's a problem. Write "BUG:" followed by your answer.`,
    keyTerms: ["race", "atomic", "concurrent", "async", "not thread safe"],
  },
  {
    id: "q2-session-input",
    title: "SessionV2 equivalent() logic",
    prompt: `Analyze this TypeScript code:

\`\`\`typescript
const equivalent = (input: Admitted, expected: { sessionID: string; prompt: Prompt; delivery: Delivery }) =>
  input.delivery === expected.delivery && matchesPrompt(input, expected)

const matchesPrompt = (input: Admitted, expected: { sessionID: string; prompt: Prompt }) =>
  input.sessionID === expected.sessionID &&
  JSON.stringify(encodePrompt(input.prompt)) === JSON.stringify(encodePrompt(expected.prompt))
\`\`\`

If the \`delivery\` field is \`"steer"\` on both sides but \`sessionID\` differs, what does \`equivalent()\` return and why? Walk through the evaluation step by step.`,
    keyTerms: ["sessionID", "delivery", "steer", "matchesPrompt", "JSON.stringify", "false"],
  },
  {
    id: "q3-effect-bridge",
    title: "Effect.promise bridge explanation",
    prompt: `Explain how \`Effect.promise()\` bridges a Promise-returning callback into an Effect workflow. 

Specifically: when a plugin's \`execute()\` function calls \`Effect.promise(() => def.execute(args, ctx))\`, what happens to any Effect services (permissions, session state) that the \`ctx.ask()\` callback needs to access? How does the bridge ensure those services are available inside the Promise callback?

Compare this with \`EffectBridge.make()\` from the opencode codebase which additionally captures \`InstanceRef\` and \`WorkspaceRef\`.`,
    keyTerms: ["Effect.provide", "context", "capture", "runPromise", "fiber"],
  },
]

// ── Runner ───────────────────────────────────────────────────────────────────

interface RunResult {
  model: ModelEntry
  question: string
  elapsed: number
  text: string
  error?: string
}

const PER_RUN_TIMEOUT_MS = parseInt(process.env.TIMEOUT ?? "180000", 10)

function runModelSync(model: ModelEntry, question: Question): RunResult {
  const PKG = "C:/GitRepros/opencode/packages/opencode"
  const args = [
    "run", "--conditions=browser",
    join(PKG, "src/index.ts"),
    "run", question.prompt,
    "--model", model.model,
    "--format", "json",
  ]
  if (model.variant) args.push("--variant", model.variant)

  const start = performance.now()
  const result = spawnSync("bun", args, {
    cwd: PKG,
    encoding: "utf-8",
    timeout: PER_RUN_TIMEOUT_MS,
    maxBuffer: 100 * 1024 * 1024,
  })

  const elapsed = performance.now() - start
  const stdout = result.stdout ?? ""
  const stderr = result.stderr ?? ""

  if (result.status !== 0 || result.error) {
    if (stdout) {
      const text = parseTextEvents(stdout)
      if (text) return { model, question: question.id, elapsed, text }
    }
    const msg = result.error?.message?.slice(0, 300) || stderr.slice(0, 300) || `Exit code ${result.status}`
    return { model, question: question.id, elapsed, text: "", error: msg }
  }

  const text = parseTextEvents(stdout)
  if (!text) return { model, question: question.id, elapsed, text: "", error: "No text in output" }
  return { model, question: question.id, elapsed, text }
}

function parseTextEvents(jsonl: string): string {
  const parts: string[] = []
  for (const line of jsonl.split("\n").filter(Boolean)) {
    try {
      const ev = JSON.parse(line)
      if (ev.type === "text" && typeof ev.part?.text === "string") parts.push(ev.part.text)
    } catch { /* skip */ }
  }
  return parts.join("\n")
}

function scoreQuality(text: string, keyTerms: string[]): { score: number; found: string[]; missing: string[] } {
  const lower = text.toLowerCase()
  const found: string[] = []
  const missing: string[] = []
  for (const term of keyTerms) {
    const needle = term.toLowerCase()
    if (lower.includes(needle)) found.push(term)
    else missing.push(term)
  }
  return { score: keyTerms.length > 0 ? found.length / keyTerms.length : 1, found, missing }
}

// ── Output ───────────────────────────────────────────────────────────────────

function pad(s: string, n: number, char = " "): string {
  const str = String(s)
  return str.length >= n ? str.slice(0, n) : str + char.repeat(n - str.length)
}

function table(results: RunResult[]) {
  const qIDs = [...new Set(results.map((r) => r.question))]
  for (const qID of qIDs) {
    const q = QUESTIONS.find((x) => x.id === qID)!
    console.log(`\n## ${q.title}`)
    console.log()
    console.log(`${pad("Model", 24)} ${pad("Group", 18)} ${pad("Time", 8)} ${pad("Score", 7)} ${pad("Tokens", 8)}  Missing Terms`)
    console.log(`${pad("", 24, "─")} ${pad("", 18, "─")} ${pad("", 8, "─")} ${pad("", 7, "─")} ${pad("", 8, "─")}  ${pad("", 0, "─")}`)

    const sorted = results.filter((r) => r.question === qID).sort((a, b) => b.elapsed - a.elapsed)
    for (const r of sorted) {
      const quality = scoreQuality(r.text, q.keyTerms)
      const tokCount = r.text.split(/\s+/).filter(Boolean).length
      const timeStr = r.error ? "FAIL" : `${(r.elapsed / 1000).toFixed(1)}s`
      const scoreStr = r.error ? "—" : `${(quality.score * 100).toFixed(0)}%`
      const tokStr = r.error ? "—" : `${tokCount}`
      const missingStr = r.error ? r.error.slice(0, 55) : quality.missing.slice(0, 3).join(", ") || "—"
      console.log(`${pad(r.model.label, 24)} ${pad(r.model.group, 18)} ${pad(timeStr, 8)} ${pad(scoreStr, 7)} ${pad(tokStr, 8)}  ${missingStr}`)
      // Print raw answer for quality inspection
      if (process.env.VERBOSE === "1" && r.text) {
        console.log(`  ── Response ──────────────────────────────`)
        r.text.split("\n").slice(0, 8).forEach((l: string) => console.log(`  ${l.slice(0, 120)}`))
        console.log(`  ───────────────────────────────────────────`)
      }
    }
  }

  // Speed summary
  console.log(`\n## Speed Summary (fastest first)`)
  console.log()
  const byLabel = new Map<string, RunResult[]>()
  for (const r of results) {
    if (r.error) continue
    const list = byLabel.get(r.model.label) ?? []
    list.push(r)
    byLabel.set(r.model.label, list)
  }
  const speeds = [...byLabel.entries()]
    .map(([label, list]) => ({ label, group: list[0].model.group, avg: list.reduce((s, r) => s + r.elapsed, 0) / list.length / 1000 }))
    .sort((a, b) => a.avg - b.avg)

  console.log(`${pad("Model", 24)} ${pad("Group", 18)} ${pad("Avg Time", 10)}`)
  console.log(`${pad("", 24, "─")} ${pad("", 18, "─")} ${pad("", 10, "─")}`)
  for (const m of speeds) console.log(`${pad(m.label, 24)} ${pad(m.group, 18)} ${pad(`${m.avg.toFixed(1)}s`, 10)}`)

  // Quality summary
  console.log(`\n## Quality Summary (highest score first)`)
  console.log()
  const scores = [...byLabel.entries()]
    .map(([label, list]) => {
      const qs = list.map((r) => scoreQuality(r.text, QUESTIONS.find((x) => x.id === r.question)!.keyTerms))
      const avgScores = qs.reduce((s, x) => s + x.score, 0) / qs.length
      return { label, group: list[0].model.group, avg: avgScores * 100 }
    })
    .sort((a, b) => b.avg - a.avg)

  console.log(`${pad("Model", 24)} ${pad("Group", 18)} ${pad("Score", 10)}`)
  console.log(`${pad("", 24, "─")} ${pad("", 18, "─")} ${pad("", 10, "─")}`)
  for (const m of scores) console.log(`${pad(m.label, 24)} ${pad(m.group, 18)} ${pad(`${m.avg.toFixed(0)}%`, 10)}`)

  // Speed/Quality matrix
  console.log(`\n## Speed vs. Quality Matrix`)
  console.log()
  const speedMap = new Map(speeds.map((s) => [s.label, s]))
  const scoreMap = new Map(scores.map((s) => [s.label, s]))
  const allLabels = [...new Set([...speedMap.keys(), ...scoreMap.keys()])]
  console.log(`${pad("Model", 24)} ${pad("Group", 18)} ${pad("Speed", 8)} ${pad("Quality", 9)}  Verdict`)
  console.log(`${pad("", 24, "─")} ${pad("", 18, "─")} ${pad("", 8, "─")} ${pad("", 9, "─")}  ${pad("", 0, "─")}`)
  for (const label of allLabels) {
    const s = speedMap.get(label)
    const sc = scoreMap.get(label)
    if (!s || !sc) continue
    const speedRank = speeds.findIndex((x) => x.label === label) + 1
    const scoreRank = scores.findIndex((x) => x.label === label) + 1
    const total = speeds.length
    const verdict = speedRank <= total / 2 && scoreRank <= total / 2 ? "BEST" :
      speedRank > total * 0.75 && scoreRank > total * 0.75 ? "WORST" :
      speedRank <= total / 2 ? "fast-ish" : "slow-ish"
    console.log(`${pad(label, 24)} ${pad(s.group, 18)} ${pad(`#${speedRank}/${total}`, 8)} ${pad(`#${scoreRank}/${total}`, 9)}  ${verdict}`)
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const filterGroup = process.env.FILTER_GROUP
  const filterModel = process.env.FILTER_MODEL?.split(",").map((s) => s.trim())
  const fast = process.env.FAST === "1"

  let models = MODELS
  if (filterGroup) models = models.filter((m) => m.group === filterGroup)
  if (filterModel) models = models.filter((m) => filterModel.includes(m.label))

  let questions = QUESTIONS
  if (fast) questions = questions.slice(0, 1)

  const total = models.length * questions.length
  console.log(`Models: ${models.length}, Questions: ${questions.length}, Total runs: ${total}`)
  console.log(`Timeout per run: ${PER_RUN_TIMEOUT_MS / 1000}s\n`)

  if (total === 0) { console.log("No models match filters."); process.exit(1) }

  console.log(` ${"Model".padEnd(24)} ${"Q".padEnd(22)} Time`)
  console.log(` ${"".padEnd(24, "─")} ${"".padEnd(22, "─")} ${"".padEnd(8, "─")}`)

  const results: RunResult[] = []
  let completed = 0

  for (const model of models) {
    for (const question of questions) {
      completed++
      process.stdout.write(` [${completed}/${total}] ${model.label.padEnd(22)} ${question.id.padEnd(20)} `)
      const result = runModelSync(model, question)
      const timeStr = result.error ? `FAIL (${result.error.slice(0, 40)})` : `${(result.elapsed / 1000).toFixed(1)}s`
      console.log(timeStr)
      results.push(result)
    }
  }

  console.log(`\n${"=".repeat(100)}`)
  table(results)
}

await main()
