import path from "path"
import { Global } from "@opencode-ai/core/global"

type Event = Record<string, unknown> & { kind?: string }

const input = process.argv[2] ?? path.join(Global.Path.log, "perf.jsonl")
const files = [input, `${input}.1`, `${input}.2`, `${input}.3`]
const events = (await Promise.all(files.map(readEvents))).flat()

console.log(`Perf report: ${input}`)
console.log(`Events: ${events.length}`)
printCounts("By kind", group(events, (event) => string(event.kind) ?? "unknown"))
printLatency("Provider TTFB", events.filter((event) => event.kind === "provider_turn"), "ttfb_ms")
printLatency("Provider stream", events.filter((event) => event.kind === "provider_turn"), "stream_ms")
printLatency("UI question", events.filter((event) => event.kind === "ui_question"), "duration_ms")
printLatency("UI session", events.filter((event) => event.kind === "ui_session_load"), "duration_ms")
printTools(events.filter((event) => event.kind === "tool_call"))
printCounts("Interrupt phases", group(events.filter((event) => event.kind === "interrupt"), (event) => string(event.phase) ?? "unknown"))
printOptimization(events.filter((event) => event.kind === "optimization"))

async function readEvents(file: string) {
  if (!(await Bun.file(file).exists())) return []
  return (await Bun.file(file).text())
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line)
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? [parsed as Event] : []
      } catch {
        return []
      }
    })
}

function group(items: Event[], key: (event: Event) => string) {
  return items.reduce((result, item) => result.set(key(item), (result.get(key(item)) ?? 0) + 1), new Map<string, number>())
}

function printCounts(title: string, counts: Map<string, number>) {
  console.log(`\n${title}`)
  for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${key}: ${count}`)
}

function printLatency(title: string, items: Event[], key: string) {
  const values = items.flatMap((event) => number(event[key]) ?? [])
  if (values.length === 0) return
  values.sort((a, b) => a - b)
  console.log(`\n${title}`)
  console.log(`  count: ${values.length}`)
  console.log(`  p50: ${percentile(values, 50).toFixed(1)}ms`)
  console.log(`  p95: ${percentile(values, 95).toFixed(1)}ms`)
  console.log(`  max: ${values.at(-1)?.toFixed(1)}ms`)
}

function printTools(items: Event[]) {
  const byTool = new Map<string, number[]>()
  for (const item of items) {
    const tool = string(item.tool) ?? "unknown"
    byTool.set(tool, [...(byTool.get(tool) ?? []), ...(number(item.duration_ms) === undefined ? [] : [number(item.duration_ms)!])])
  }
  if (byTool.size === 0) return
  console.log("\nSlow tools")
  for (const [tool, values] of [...byTool].sort((a, b) => average(b[1]) - average(a[1])).slice(0, 10)) {
    console.log(`  ${tool}: count=${values.length} avg=${average(values).toFixed(1)}ms max=${Math.max(...values).toFixed(1)}ms`)
  }
}

function printOptimization(items: Event[]) {
  const byFeature = group(items, (event) => string(event.feature) ?? "unknown")
  if (byFeature.size === 0) return
  console.log("\nOptimization effectiveness")
  for (const [feature] of [...byFeature].sort((a, b) => a[0].localeCompare(b[0]))) {
    const featureEvents = items.filter((event) => event.feature === feature)
    const hits = featureEvents.filter((event) => event.hit === true).length
    const misses = featureEvents.filter((event) => event.hit === false).length
    const hitRate = hits + misses === 0 ? "n/a" : `${((hits / (hits + misses)) * 100).toFixed(1)}%`
    console.log(`  ${feature}: events=${featureEvents.length} hits=${hits} misses=${misses} hitRate=${hitRate}`)
  }
}

function percentile(values: number[], p: number) {
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil((p / 100) * values.length) - 1))] ?? 0
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
}

function string(value: unknown) {
  if (typeof value === "string") return value
}

function number(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
}
