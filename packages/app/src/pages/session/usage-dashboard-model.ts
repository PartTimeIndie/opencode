import { getFilename } from "@opencode-ai/core/util/path"
import type { GlobalSession } from "@opencode-ai/sdk/v2/client"

export type UsageBucket = {
  day: string
  label: string
  tokens: number
  cost: number
  sessions: number
}

export type UsageRow = {
  name: string
  sessions: number
  tokens: number
  cost: number
  active: boolean
  activeSessions: number
  lastUsed: number
}

export function applyLimit<T>(rows: T[], limit: number | "all") {
  if (limit === "all") return rows
  return rows.slice(0, limit)
}

export function parseModelLimit(value: string): number | "all" {
  if (value === "all") return "all"
  const parsed = Number(value)
  return parsed === 8 || parsed === 20 || parsed === 50 ? parsed : 8
}

const dayMs = 24 * 60 * 60 * 1000

export function buildSummary(
  sessions: GlobalSession[],
  range: { days?: number },
  start: number | undefined,
  activeSessions: { agent: string }[],
) {
  const filtered = sessions.filter((session) => start === undefined || sessionTime(session) >= start)
  const activeAgents = new Map<string, number>()
  activeSessions.forEach((session) => activeAgents.set(session.agent, (activeAgents.get(session.agent) ?? 0) + 1))

  const daily = new Map<string, UsageBucket>()
  const agents = new Map<string, UsageRow>()
  const models = new Map<string, UsageRow>()
  const projects = new Map<string, UsageRow>()

  if (range.days !== undefined) {
    const first = rangeStartForDays(range.days)
    Array.from({ length: range.days }, (_, index) => first + index * dayMs).forEach((time) => {
      const day = dayKey(time)
      daily.set(day, { day, label: dayLabel(time), tokens: 0, cost: 0, sessions: 0 })
    })
  }

  filtered.forEach((session) => {
    const time = sessionTime(session)
    const day = dayKey(time)
    const tokens = tokenTotal(session)
    const cost = session.cost ?? 0
    const bucket = daily.get(day) ?? { day, label: dayLabel(time), tokens: 0, cost: 0, sessions: 0 }
    bucket.tokens += tokens
    bucket.cost += cost
    bucket.sessions += 1
    daily.set(day, bucket)
    addUsage(agents, session.agent ?? "default", tokens, cost, time)
    addUsage(models, modelLabel(session), tokens, cost, time)
    addUsage(projects, projectLabel(session), tokens, cost, time)
  })

  activeAgents.forEach((count, agent) => {
    const row = agents.get(agent) ?? { name: agent, sessions: 0, tokens: 0, cost: 0, active: false, activeSessions: 0, lastUsed: 0 }
    row.active = true
    row.activeSessions = count
    agents.set(agent, row)
  })

  return {
    sessionCount: filtered.length,
    totalTokens: filtered.reduce((sum, session) => sum + tokenTotal(session), 0),
    totalCost: filtered.reduce((sum, session) => sum + (session.cost ?? 0), 0),
    activeSessionCount: activeSessions.length,
    projectCount: new Set(filtered.map((session) => session.projectID)).size,
    daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
    hasDailyUsage: [...daily.values()].some((bucket) => bucket.tokens > 0),
    agents: sortRows(agents),
    models: sortRows(models),
    projects: sortRows(projects),
  }
}

export function rangeStartForDays(days: number) {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - days + 1)
  return date.getTime()
}

function addUsage(rows: Map<string, UsageRow>, name: string, tokens: number, cost: number, time: number) {
  const row = rows.get(name) ?? { name, sessions: 0, tokens: 0, cost: 0, active: false, activeSessions: 0, lastUsed: 0 }
  row.sessions += 1
  row.tokens += tokens
  row.cost += cost
  row.lastUsed = Math.max(row.lastUsed, time)
  rows.set(name, row)
}

function sortRows(rows: Map<string, UsageRow>) {
  return [...rows.values()].sort(
    (a, b) => Number(b.active) - Number(a.active) || b.tokens - a.tokens || b.cost - a.cost || b.lastUsed - a.lastUsed,
  )
}

function tokenTotal(session: GlobalSession) {
  return (
    (session.tokens?.input ?? 0) +
    (session.tokens?.output ?? 0) +
    (session.tokens?.reasoning ?? 0) +
    (session.tokens?.cache.read ?? 0) +
    (session.tokens?.cache.write ?? 0)
  )
}

function sessionTime(session: GlobalSession) {
  return session.time.updated ?? session.time.created
}

function dayKey(time: number) {
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

function dayLabel(time: number) {
  return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function modelLabel(session: GlobalSession) {
  if (!session.model) return "unknown"
  return `${session.model.providerID}/${session.model.id}${session.model.variant ? ` (${session.model.variant})` : ""}`
}

function projectLabel(session: GlobalSession) {
  if (session.project?.name) return session.project.name
  if (session.project?.worktree) return getFilename(session.project.worktree)
  return getFilename(session.directory)
}
