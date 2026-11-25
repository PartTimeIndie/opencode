import { getHeapStatistics } from "node:v8"

export type SidecarDiagnostic = ReturnType<typeof sampleSidecarDiagnostic>

type ActivityKind = "tool" | "provider" | "session-read" | "session-stage" | "sqlite" | "plugin"
type Outcome = "success" | "failure" | "interrupted"
type ActivityStart = { phase: "start"; id: number; kind: ActivityKind; sessionID?: string; pluginID?: string; name: string }
export type SidecarActivityUpdate = ActivityStart | { phase: "end"; id: number; outcome?: Outcome }

export function createSidecarActivityLog(now = Date.now) {
  const active = new Map<number, Omit<ActivityStart, "phase"> & { startedAt: number }>()
  type Completed = Omit<ActivityStart, "phase"> & { startedAt: number; endedAt: number; outcome?: Outcome }
  const recent: Completed[] = []
  const recentSessionReads: Completed[] = []
  const recentStages = {
    "session-stage": [] as Completed[],
    sqlite: [] as Completed[],
    plugin: [] as Completed[],
  }
  const activeStages = new Map<number, Omit<ActivityStart, "phase"> & { startedAt: number }>()
  let evicted = 0
  return {
    accept(value: unknown) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return
      const record = value as Record<string, unknown>
      const id = record.id
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return
      if (record.phase === "end") {
        const operation = active.get(id) ?? activeStages.get(id)
        if (!operation) return
        const outcome = record.outcome
        if (outcome !== undefined && outcome !== "success" && outcome !== "failure" && outcome !== "interrupted") return
        active.delete(id)
        activeStages.delete(id)
        const kind = operation.kind
        const history = kind === "session-read" ? recentSessionReads
          : kind === "session-stage" || kind === "sqlite" || kind === "plugin" ? recentStages[kind]
          : recent
        history.push({ ...operation, endedAt: now(), ...(outcome === undefined ? {} : { outcome }) })
        if (history.length > 12) history.shift()
        return
      }
      const kind = record.kind
      const sessionID = record.sessionID
      const pluginID = record.pluginID
      const detail = kind === "session-stage" || kind === "sqlite" || kind === "plugin"
      if (
        record.phase !== "start" ||
        (!detail && kind !== "tool" && kind !== "provider" && kind !== "session-read") ||
        (sessionID === undefined
          ? kind !== "sqlite" && kind !== "plugin"
          : kind === "sqlite" || typeof sessionID !== "string" || !/^ses_[\w-]{1,120}$/.test(sessionID)) ||
        (kind === "plugin"
          ? typeof pluginID !== "string" || pluginID.length > 160 || !/^(?:@[\w.-]+\/)?[\w.-]+$/.test(pluginID)
          : pluginID !== undefined) ||
        typeof record.name !== "string" || !/^[\w./:@+%-]{1,160}$/.test(record.name) ||
        active.has(id) || activeStages.has(id)
      ) return
      const pending = detail ? activeStages : active
      if (pending.size === 32) {
        const oldest = pending.keys().next().value
        if (oldest !== undefined) pending.delete(oldest)
        evicted++
      }
      pending.set(id, {
        id, kind, name: record.name, startedAt: now(),
        ...(typeof sessionID === "string" ? { sessionID } : {}),
        ...(typeof pluginID === "string" ? { pluginID } : {}),
      })
    },
    snapshot() {
      return {
        active: [...active.values(), ...activeStages.values()].sort((left, right) => left.id - right.id),
        recent: [...recent],
        recentSessionReads: [...recentSessionReads],
        recentStages: {
          "session-stage": [...recentStages["session-stage"]],
          sqlite: [...recentStages.sqlite],
          plugin: [...recentStages.plugin],
        },
        evicted,
      }
    },
  }
}

const keys = [
  "uptimeMs", "rssBytes", "heapUsedBytes", "heapTotalBytes", "heapLimitBytes", "externalBytes",
  "cpuUserMicros", "cpuSystemMicros",
] as const

export function sampleSidecarDiagnostic() {
  const memory = process.memoryUsage()
  const heap = getHeapStatistics()
  const cpu = process.cpuUsage()
  return {
    uptimeMs: Math.round(process.uptime() * 1000),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    heapLimitBytes: heap.heap_size_limit,
    externalBytes: memory.external,
    cpuUserMicros: cpu.user,
    cpuSystemMicros: cpu.system,
  }
}

export function parseSidecarDiagnostic(value: unknown): SidecarDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== keys.length) return
  if (!keys.every((key) => Number.isSafeInteger(record[key]) && (record[key] as number) >= 0)) return
  return Object.fromEntries(keys.map((key) => [key, record[key]])) as SidecarDiagnostic
}

export function startSidecarDiagnostics(
  send: (sample: SidecarDiagnostic) => void,
  schedule: (callback: () => void) => () => void = (callback) => {
    const timer = setInterval(callback, 30_000)
    timer.unref()
    return () => clearInterval(timer)
  },
) {
  let active = true
  const report = () => {
    if (!active) return
    try { send(sampleSidecarDiagnostic()) } catch { /* Diagnostics must not affect server execution. */ }
  }
  report()
  const cancel = schedule(report)
  return () => { active = false; cancel() }
}
