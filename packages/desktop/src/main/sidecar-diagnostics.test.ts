import { expect, test } from "bun:test"
import { createSidecarActivityLog, parseSidecarDiagnostic, sampleSidecarDiagnostic, startSidecarDiagnostics } from "./sidecar-diagnostics"

test("retains only bounded, allowlisted activity from this process generation", () => {
  let now = 0
  const log = createSidecarActivityLog(() => ++now)
  const sample = { phase: "start", kind: "tool", sessionID: "ses_demo", name: "task_wait", args: "private" }
  log.accept({ ...sample, id: 1, sessionID: "untrusted text" })
  log.accept({ ...sample, id: 2, name: "untrusted text" })
  for (let id = 3; id < 43; id++) log.accept({ ...sample, id })
  const beforeExit = log.snapshot()
  expect(beforeExit.active).toHaveLength(32)
  expect(beforeExit.evicted).toBe(8)
  expect(beforeExit.active[0]).toEqual({ id: 11, kind: "tool", sessionID: "ses_demo", name: "task_wait", startedAt: 9 })
  for (let id = 11; id < 43; id++) log.accept({ phase: "end", id })
  log.accept({ phase: "end", id: 42 })
  expect(log.snapshot().active).toEqual([])
  expect(log.snapshot().recent.map((item) => item.id)).toEqual([31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42])
  expect(createSidecarActivityLog().snapshot()).toEqual({
    active: [], recent: [], recentSessionReads: [],
    recentStages: { "session-stage": [], sqlite: [], plugin: [] }, evicted: 0,
  })
})

test("tool activity cannot evict recent session reads", () => {
  const log = createSidecarActivityLog()
  log.accept({ phase: "start", id: 1, kind: "session-read", sessionID: "ses_demo", name: "session.exists" })
  log.accept({ phase: "end", id: 1 })
  for (let id = 2; id <= 20; id++) {
    log.accept({ phase: "start", id, kind: "tool", sessionID: "ses_demo", name: "task_wait" })
    log.accept({ phase: "end", id })
  }
  expect(log.snapshot().recent).toHaveLength(12)
  expect(log.snapshot().recentSessionReads).toEqual([
    expect.objectContaining({ id: 1, kind: "session-read", name: "session.exists" }),
  ])
})

test("keeps unfinished work and separate recent stages while rejecting private fields and invalid outcomes", () => {
  const log = createSidecarActivityLog(() => 10)
  const session = { phase: "start", sessionID: "ses_demo" }
  log.accept({ ...session, id: 1, kind: "session-read", name: "v2.session.messages" })
  log.accept({ ...session, id: 2, kind: "session-stage", name: "messages.decode", message: "private" })
  log.accept({ phase: "end", id: 2, outcome: "success" })
  log.accept({ phase: "start", id: 3, kind: "plugin", pluginID: "C:/private/file.js", name: "module.import" })
  log.accept({ phase: "start", id: 4, kind: "plugin", pluginID: "@example/plugin", name: "server.event" })
  log.accept({ phase: "end", id: 4, outcome: "failure" })
  for (let id = 5; id < 25; id++) {
    log.accept({ phase: "start", id, kind: "sqlite", name: "all.rows", query: "SELECT private" })
    log.accept({ phase: "end", id, outcome: "success" })
  }
  log.accept({ phase: "start", id: 25, kind: "sqlite", name: "prepare" })
  log.accept({ phase: "end", id: 25, outcome: "private" })
  const snapshot = log.snapshot()
  expect(snapshot.active.map((item) => item.id)).toEqual([1, 25])
  expect(snapshot.recentStages.sqlite).toHaveLength(12)
  expect(snapshot.recentStages.plugin).toEqual([
    { id: 4, kind: "plugin", pluginID: "@example/plugin", name: "server.event", startedAt: 10, endedAt: 10, outcome: "failure" },
  ])
  expect(snapshot.recentStages["session-stage"]).toHaveLength(1)
  expect(JSON.stringify(snapshot)).not.toContain("private")
})

test("sidecar diagnostic samples contain bounded numeric process metrics", () => {
  const sample = sampleSidecarDiagnostic()
  expect(parseSidecarDiagnostic(sample)).toEqual(sample)
  expect(sample.rssBytes).toBeGreaterThan(0)
  expect(sample.heapLimitBytes).toBeGreaterThan(0)
  expect(Object.keys(sample).sort()).toEqual([
    "cpuSystemMicros", "cpuUserMicros", "externalBytes", "heapLimitBytes", "heapTotalBytes", "heapUsedBytes",
    "rssBytes", "uptimeMs",
  ].sort())
  expect(parseSidecarDiagnostic({ ...sample, password: "secret" })).toBeUndefined()
  expect(parseSidecarDiagnostic({ ...sample, rssBytes: -1 })).toBeUndefined()
})

test("sidecar diagnostics sample immediately and on each scheduled tick until stopped", () => {
  let tick: (() => void) | undefined
  let stopped = false
  const samples: ReturnType<typeof sampleSidecarDiagnostic>[] = []
  const stop = startSidecarDiagnostics(
    (sample) => samples.push(sample),
    (callback) => {
      tick = callback
      return () => { stopped = true; tick = undefined }
    },
  )
  expect(samples).toHaveLength(1)
  tick?.()
  expect(samples).toHaveLength(2)
  stop()
  expect(stopped).toBe(true)
  expect(tick).toBeUndefined()
})

test("diagnostic transport errors do not terminate the sidecar", () => {
  let tick: (() => void) | undefined
  expect(() => startSidecarDiagnostics(
    () => { throw new Error("parent port closed") },
    (callback) => { tick = callback; return () => {} },
  )).not.toThrow()
  expect(() => tick?.()).not.toThrow()
})
