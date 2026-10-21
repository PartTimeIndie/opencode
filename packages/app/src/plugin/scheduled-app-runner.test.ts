import { expect, test } from "bun:test"

const { createScheduledAppRunner } = await import(new URL("../../../../.opencode/plugin-sources/scheduled-jobs-app/app-runner.js", import.meta.url).href)
const { resultContractMarker } = await import(new URL("../../../../.opencode/plugin-sources/scheduled-jobs-app/result-contract.js", import.meta.url).href)
const runId = "a".repeat(32)
const handoff = { directory: "C:/project", payload: { scopeId: "scope-one", slug: "nightly", runId } }

test("duplicate handoffs admit one deterministic job and preserve policy/result ordering", async () => {
  const fixture = setup()
  try {
    await Promise.all([fixture.runner.handle(handoff), fixture.runner.handle(handoff)])
    await until(() => fixture.states.some((state) => state.status === "success"))
    expect(fixture.prompts).toHaveLength(1)
    expect(fixture.created).toHaveLength(1)
    expect(fixture.prompts[0]).toMatchObject({ id: expect.stringMatching(/^msg_/), delivery: "steer", prompt: { text: expect.stringContaining(resultContractMarker) } })
    expect(fixture.events.indexOf("policy:ask")).toBeLessThan(fixture.events.indexOf("state:running"))
    expect(fixture.events.indexOf("state:running")).toBeLessThan(fixture.events.indexOf("prompt"))
    await fixture.runner.handle(handoff)
    await until(() => fixture.navigation.length === 2)
    expect(fixture.prompts).toHaveLength(1)
  } finally { fixture.dispose() }
})

test("recovery uses the persisted session and message without creating another session", async () => {
  const fixture = setup({ lastRunSessionID: "ses_recovered", lastRunMessageID: "msg_recovered", lastRunResultContract: resultContractMarker })
  try {
    await fixture.runner.handle(handoff)
    await until(() => fixture.states.some((state) => state.status === "success"))
    expect(fixture.created).toEqual([])
    expect(fixture.prompts).toHaveLength(1)
    expect(fixture.prompts[0]?.id).toBe("msg_recovered")
    expect(fixture.navigation).toEqual([{ directory: "C:/project", sessionID: "ses_recovered" }])
  } finally { fixture.dispose() }
})

test("global recovery binds job lookup, outcome polling and state updates to the job project", async () => {
  const fixture = setup({ lastRunSessionID: "ses_other_project", lastRunMessageID: "msg_recovered", lastRunResultContract: resultContractMarker })
  try {
    await fixture.runner.resume()
    await until(() => fixture.states.some((state) => state.status === "success"))
    expect(fixture.requests[0]).toMatchObject({ path: "/scheduler/jobs" })
    expect(fixture.requests[0]?.directory).toBeUndefined()
    const scoped = fixture.requests.filter((request) => request.path !== "/scheduler/jobs")
    expect(scoped.some((request) => request.path.endsWith("/outcome"))).toBe(true)
    expect(scoped.some((request) => request.path.endsWith("/state"))).toBe(true)
    expect(scoped.every((request) => request.directory === fixture.job.workdir)).toBe(true)
    expect(fixture.prompts).toHaveLength(1)
  } finally { fixture.dispose() }
})

test("an empty prompt response is ambiguous and retries the same scheduled admission", async () => {
  const fixture = setup({}, undefined, new SyntaxError("Failed to execute 'json' on 'Response': Unexpected end of JSON input"))
  try {
    await fixture.runner.handle(handoff)
    await until(() => fixture.states.some((state) => state.status === "success"), 3000)
    expect(fixture.prompts).toHaveLength(2)
    expect(fixture.prompts[0]?.id).toBe(fixture.prompts[1]?.id)
    expect(fixture.created).toHaveLength(1)
    expect(fixture.states.some((state) => state.status === "failed")).toBe(false)
  } finally { fixture.dispose() }
})

test("completed recovery opens the existing session without provider admission", async () => {
  const fixture = setup({ lastRunStatus: "success", run: { prompt: "Saved work", appSessionID: "ses_done", runTarget: "app" } })
  try {
    await fixture.runner.handle(handoff)
    await until(() => fixture.navigation.length === 1)
    expect(fixture.prompts).toEqual([])
    expect(fixture.created).toEqual([])
    expect(fixture.states).toEqual([])
  } finally { fixture.dispose() }
})

test("unloading while the job lookup is pending prevents later session work", async () => {
  const pending = Promise.withResolvers<unknown>()
  const fixture = setup({}, pending.promise)
  await fixture.runner.handle(handoff)
  fixture.dispose()
  pending.resolve({ data: { job: fixture.job } })
  await Bun.sleep(10)
  expect(fixture.created).toEqual([])
  expect(fixture.prompts).toEqual([])
  expect(fixture.states).toEqual([])
})

test("rejects forged handoff shapes and ignores a superseded run", async () => {
  const fixture = setup({ lastRunRunId: "b".repeat(32) })
  try {
    await expect(fixture.runner.handle({ ...handoff, payload: { ...handoff.payload, runId: "../invalid" } })).rejects.toThrow("Invalid scheduled app handoff")
    await fixture.runner.handle(handoff)
    await Bun.sleep(10)
    expect(fixture.created).toEqual([])
    expect(fixture.prompts).toEqual([])
  } finally { fixture.dispose() }
})

function setup(overrides: Record<string, unknown> = {}, pending?: Promise<unknown>, promptFailure?: Error) {
  const controller = new AbortController()
  const cleanup: (() => void)[] = []
  const events: string[] = []
  const created: unknown[] = []
  const prompts: Record<string, unknown>[] = []
  const states: Record<string, unknown>[] = []
  const navigation: unknown[] = []
  const requests: Array<{ path: string; directory?: string }> = []
  const job: Record<string, unknown> = { workdir: "C:/project", scopeId: "scope-one", slug: "nightly", lastRunRunId: runId, lastRunStatus: "running", run: { prompt: "Saved work", model: "neutral/model", runTarget: "app", appSessionStrategy: "new" }, ...overrides }
  const request = async (input: { path: string; directory?: string; method?: string; body?: Record<string, unknown> }) => {
    requests.push(input)
    if (input.path.endsWith("/outcome")) return promptFailure && prompts.length < 2
      ? { data: { status: "pending", phase: "admission_missing" } }
      : { data: { status: "success", activityID: "activity-one" } }
    if (input.path.endsWith("/state")) {
      states.push(input.body!)
      events.push(`state:${input.body!.status}`)
      job.lastRunStatus = input.body!.status
      job.run = { ...(job.run as object), appSessionID: input.body!.appSessionID }
      return { data: { job: { lastRunResultContract: resultContractMarker } } }
    }
    if (input.path.endsWith("/jobs")) return { data: { jobs: [job] } }
    return pending ?? { data: { job } }
  }
  const runner = createScheduledAppRunner({
    lifecycle: { signal: controller.signal, onDispose: (fn: () => void) => cleanup.push(fn) },
    host: {
      projects: { open() {} },
      navigation: { openSession: (input: unknown) => navigation.push(input) },
      sessions: { accessControl: { get: async () => ({ mode: "ask" }), set: async (input: { mode: string }) => { events.push(`policy:${input.mode}`) } } },
      http: { request: async (input: { path: string; body?: Record<string, unknown>; query: { directory: string }; signal: AbortSignal }) => {
        expect(input.query.directory).toBe("C:/project")
        expect(input.signal).toBe(controller.signal)
        if (input.path === "/api/session") { created.push(input.body); return { ok: true, body: { data: { id: input.body!.id } } } }
        if (input.path.endsWith("/prompt")) { events.push("prompt"); prompts.push(input.body!); if (promptFailure && prompts.length === 1) throw promptFailure; return { ok: true, body: { data: {} } } }
        return { ok: true, body: { id: decodeURIComponent(input.path.split("/").at(-1)!) } }
      } },
    },
    ui: { models: { resolve: () => ({ providerID: "neutral", id: "model" }) } },
  }, request, () => {})
  return { runner, job, states, prompts, created, navigation, events, requests, dispose() { controller.abort(); cleanup.forEach((fn) => fn()) } }
}

async function until(predicate: () => boolean, timeout = 1000) {
  const deadline = Date.now() + timeout
  while (!predicate() && Date.now() < deadline) await Bun.sleep(2)
  expect(predicate()).toBe(true)
}
