import { describe, expect, test } from "bun:test"
import { pluginServiceResponse } from "./service-response"

type HttpRequest = {
  path: string
  directory?: string
  method?: string
  query?: Record<string, unknown>
  body?: Record<string, unknown>
}

type HttpResponse = {
  ok: boolean
  status: number
  statusText: string
  body?: unknown
  text?: string
}

type SchedulerPlugin = {
  default: {
    app: (api: unknown) => void
  }
  runSchedulerVerificationFixture: (api: unknown, input: unknown) => Promise<Record<string, unknown>>
}

const scheduler = (await import(
  new URL("../../../../.opencode/plugin-sources/scheduled-jobs-app/index.js", import.meta.url).href
)) as unknown as SchedulerPlugin

const fixtureId = "0123456789abcdef0123456789abcdef"
const scopeId = "opencode-6bf699ecdff8"
const workdir = "C:\\GitRepros\\opencode"
const schedule = "42 10 18 7 *"
const preflightToken = "SCHEDULER_SMOKE_0123456789"
const runId = "abcdef0123456789abcdef0123456789"
const model = "openai/gpt-5.6-terra"
const source = "scheduled-jobs-app-verification"
const slug = `${source}-scheduler-verification-${fixtureId}`

describe("scheduled jobs verification automation", () => {
  for (const status of [401, 403, 503]) {
    test(`preserves an outer service HTTP ${status} for scheduler recovery`, async () => {
      await expect(
        scheduler.runSchedulerVerificationFixture(
          { services: { call: async () => ({ ok: false, status, error: "Service unavailable" }) } },
          common("get"),
        ),
      ).rejects.toMatchObject({ status })
    })
  }

  for (const status of [401, 403, 503]) {
    test(`startup recovery handles a real service HTTP ${status} without replay`, async () => {
      const controller = new AbortController()
      const requests: HttpRequest[] = []
      const navigation: unknown[] = []
      const unexpected: unknown[] = []
      const job = fixtureJob({
        lastRunStatus: "running", lastRunRunId: runId,
        lastRunSessionID: "ses_saved", lastRunMessageID: "msg_saved",
        lastRunResultContract: "opencode.scheduled-job-result/v1",
      })
      let lists = 0
      let settled = false
      scheduler.default.app({
        settings: { get: (_key: string, fallback: unknown) => fallback, register() {}, subscribe() {} },
        commands: { register() {} }, automation: { register() {} },
        dock: { state: { item: () => ({ area: "left" }) }, register() {}, open: { item() {} } },
        kv: { get: (_key: string, fallback: unknown) => fallback },
        lifecycle: { signal: controller.signal, onDispose() {} },
        ui: { models: { resolve: (input: unknown) => unexpected.push(input) } },
        host: {
          navigation: { registerHandoffHandler() {}, openSession: (input: unknown) => navigation.push(input) },
          projects: { open() {} },
          http: { request: (input: unknown) => unexpected.push(input) },
          sessions: { accessControl: { set: (input: unknown) => unexpected.push(input) } },
        },
        services: {
          call: async ({ input }: { input: HttpRequest }) => {
            requests.push(input)
            if (input.path === "/scheduler/jobs" && ++lists === 1)
              return pluginServiceResponse(Response.json({ message: "Temporarily unavailable" }, { status }))
            const data = input.path === "/scheduler/jobs" ? { jobs: [job] }
              : input.path.endsWith("/outcome") ? { status: "failed", error: "Interrupted before settlement" }
              : input.path.endsWith("/state") ? { job: { ...job, lastRunStatus: "failed" } }
              : { job }
            if (input.path.endsWith("/state")) settled = true
            return pluginServiceResponse(Response.json({ ok: true, data: { status: 200, body: { success: true, data } } }))
          },
        },
      })
      try {
        const deadline = Date.now() + 2200
        while (!settled && Date.now() < deadline) await Bun.sleep(10)
        expect(lists).toBe(status === 503 ? 2 : 1)
        expect(settled).toBe(status === 503)
        expect(unexpected).toEqual([])
        expect(navigation).toEqual(status === 503 ? [{ directory: workdir, sessionID: "ses_saved" }] : [])
        if (status === 503) expect(requests.at(-1)?.body).toMatchObject({ status: "failed", messageID: "msg_saved" })
      } finally { controller.abort() }
    })
  }

  test("disposal cancels a pending service recovery retry", async () => {
    const controller = new AbortController()
    let calls = 0
    scheduler.default.app({
      settings: { get: (_key: string, fallback: unknown) => fallback, register() {}, subscribe() {} },
      commands: { register() {} }, automation: { register() {} },
      dock: { state: { item: () => ({ area: "left" }) }, register() {}, open: { item() {} } },
      kv: { get: (_key: string, fallback: unknown) => fallback },
      lifecycle: { signal: controller.signal, onDispose() {} },
      host: { navigation: { registerHandoffHandler() {} } },
      services: { call: async () => { calls++; return pluginServiceResponse(new Response("Unavailable", { status: 503 })) } },
    })
    await Bun.sleep(30)
    controller.abort()
    await Bun.sleep(1100)
    expect(calls).toBe(1)
  })

  test("registers the fixture through the app automation API", () => {
    const actions: Array<Record<string, unknown>> = []
    scheduler.default.app({
      settings: {
        get: (_key: string, fallback: unknown) => fallback,
        register: () => {},
        subscribe: () => {},
      },
      commands: { register: () => {} },
      automation: { register: (action: Record<string, unknown>) => actions.push(action) },
      dock: {
        state: { item: () => ({ area: "left", visible: true }) },
        register: () => {},
        open: { item: () => {} },
      },
      kv: { get: (_key: string, fallback: unknown) => fallback },
      lifecycle: { signal: new AbortController().signal, onDispose: () => {} },
      host: { navigation: { registerHandoffHandler: () => () => {} } },
    })

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      id: "verificationFixture",
      title: "Scheduled job verification fixture",
      inputSchema: {
        additionalProperties: false,
        required: ["operation", "fixtureId", "expectedScopeId", "workdir"],
      },
    })
    expect(typeof actions[0]?.run).toBe("function")
  })

  test("creates only a new-session ask-mode app fixture with a fixed safe preflight", async () => {
    const requests: HttpRequest[] = []
    const prompt = "Reply with the exact token below.\n\nSCHEDULER_RESPONSE_0123456789"
    const result = await scheduler.runSchedulerVerificationFixture(
      api(requests, [
        response(404, { success: false, output: "Scheduled job no longer exists." }),
        response(200, { success: true, data: { job: fixtureJob({ prompt, run: { model } }) } }),
      ]),
      {
        operation: "create",
        fixtureId,
        expectedScopeId: scopeId,
        workdir,
        schedule,
        prompt,
        model,
        variant: "high",
        preflightToken,
        timeoutSeconds: 600,
      },
    )

    expect(result).toMatchObject({
      ok: true,
      operation: "create",
      fixtureId,
      slug,
      expectedScopeId: scopeId,
      workdir,
      job: { run: { model } },
    })
    expect(requests).toHaveLength(2)
    expect(requests[0]).toEqual({
      path: `/scheduler/jobs/${slug}`,
      query: { workdir, scopeId },
    })
    expect(requests[1]).toEqual({
      path: "/scheduler/jobs",
      method: "POST",
      body: {
        name: `Scheduler verification ${fixtureId}`,
        description: `Isolated scheduled app verification fixture ${fixtureId}.`,
        source,
        schedule,
        workdir,
        runOnce: false,
        timeoutSeconds: 600,
        prompt,
        runTarget: "app",
        appSessionStrategy: "new",
        accessControl: { mode: "ask" },
        model,
        variant: "high",
        modelPolicyException: {
          model,
          variant: "high",
          reason: "Isolated scheduler verification explicitly requested this direct model.",
        },
        preflight: {
          command: "powershell.exe",
          args: ["-NoProfile", "-NonInteractive", "-Command", `Write-Output '${preflightToken}'`],
          timeoutSeconds: 30,
        },
      },
    })
    expect(requests[1]?.body).not.toHaveProperty("invocation")
    expect(requests[1]?.body).not.toHaveProperty("currentClient")
    expect(requests[1]?.body).not.toHaveProperty("appSessionID")
  })

  test("rolls back a create response whose app model differs", async () => {
    const requests: HttpRequest[] = []
    const mismatched = fixtureJob({ prompt: "test", run: { model: "openai/gpt-5.6" } })
    await expect(
      scheduler.runSchedulerVerificationFixture(
        api(requests, [
          response(404, { success: false }),
          response(200, { success: true, data: { job: mismatched } }),
          response(200, { success: true, data: { job: mismatched } }),
          response(200, { success: true }),
          response(404, { success: false }),
        ]),
        {
          ...common("create"),
          schedule,
          prompt: "test",
          model,
          variant: "high",
          preflightToken,
        },
      ),
    ).rejects.toThrow("rolled back and exact absence was verified")
    expect(requests).toEqual([
      exactGet(),
      expect.objectContaining({
        path: "/scheduler/jobs",
        method: "POST",
        body: expect.objectContaining({ model }),
      }),
      exactGet(),
      { ...exactGet(), method: "DELETE" },
      exactGet(),
    ])
  })

  test("uses exact scoped routes for get, logs, and the current run outcome", async () => {
    const requests: HttpRequest[] = []
    const client = api(requests, [
      response(200, { success: true, data: { job: fixtureJob() } }),
      response(200, { success: true, data: { job: fixtureJob() } }),
      response(200, { success: true, data: { logs: "preflight marker\nhandoff marker" } }),
      response(200, { success: true, data: { job: fixtureJob({ lastRunRunId: runId }) } }),
      response(200, { success: true, data: { status: "success", runId } }),
    ])

    await scheduler.runSchedulerVerificationFixture(client, common("get"))
    const logs = await scheduler.runSchedulerVerificationFixture(client, { ...common("logs"), lines: 17 })
    const outcome = await scheduler.runSchedulerVerificationFixture(client, { ...common("outcome"), runId })

    expect(logs).toMatchObject({ logs: "preflight marker\nhandoff marker" })
    expect(outcome).toMatchObject({ outcome: { status: "success", runId } })
    expect(requests).toEqual([
      exactGet(),
      exactGet(),
      { path: `${exactGet().path}/logs`, query: { workdir, scopeId, lines: 17 } },
      exactGet(),
      { path: `${exactGet().path}/outcome`, query: { workdir, scopeId, runId }, directory: workdir },
    ])
  })

  test("deletes only after exact identity verification and proves exact absence", async () => {
    const requests: HttpRequest[] = []
    const result = await scheduler.runSchedulerVerificationFixture(
      api(requests, [
        response(200, { success: true, data: { job: fixtureJob() } }),
        response(200, { success: true }),
        response(404, { success: false, output: "Scheduled job no longer exists." }),
      ]),
      common("delete"),
    )

    expect(result).toMatchObject({ ok: true, operation: "delete", deleted: true })
    expect(requests).toEqual([
      exactGet(),
      { ...exactGet(), method: "DELETE" },
      exactGet(),
    ])
  })

  test("fails closed on unknown fields, unsafe identifiers, paths, schedules, and stale run IDs", async () => {
    const requests: HttpRequest[] = []
    const client = api(requests, [response(200, { success: true, data: { job: fixtureJob() } })])

    await expect(
      scheduler.runSchedulerVerificationFixture(client, { ...common("get"), slug: "daily-agent-review-morgenplan" }),
    ).rejects.toThrow('does not allow "slug"')
    await expect(
      scheduler.runSchedulerVerificationFixture(client, { ...common("get"), fixtureId: "not-a-fixture" }),
    ).rejects.toThrow("32 lowercase hexadecimal")
    await expect(
      scheduler.runSchedulerVerificationFixture(client, { ...common("get"), workdir: "C:\\repo\\..\\other" }),
    ).rejects.toThrow("parent-directory")
    await expect(
      scheduler.runSchedulerVerificationFixture(client, {
        ...common("create"),
        schedule: "*/5 * * * *",
        prompt: "test",
        preflightToken,
      }),
    ).rejects.toThrow("exact minute hour day month")
    await expect(
      scheduler.runSchedulerVerificationFixture(client, { ...common("outcome"), runId }),
    ).rejects.toThrow("is not the fixture's current run")
    expect(requests).toEqual([exactGet()])
  })

  test("rolls back a create response whose app-job contract differs", async () => {
    const requests: HttpRequest[] = []
    const mismatched = fixtureJob({
      prompt: "test",
      run: { prompt: "test", accessControl: { mode: "full_access" } },
    })
    await expect(
      scheduler.runSchedulerVerificationFixture(
        api(requests, [
          response(404, { success: false }),
          response(200, { success: true, data: { job: mismatched } }),
          response(200, { success: true, data: { job: mismatched } }),
          response(200, { success: true }),
          response(404, { success: false }),
        ]),
        {
          ...common("create"),
          schedule,
          prompt: "test",
          preflightToken,
        },
      ),
    ).rejects.toThrow("rolled back and exact absence was verified")
    expect(requests).toEqual([
      exactGet(),
      expect.objectContaining({ path: "/scheduler/jobs", method: "POST" }),
      exactGet(),
      { ...exactGet(), method: "DELETE" },
      exactGet(),
    ])
  })

  test("rolls back an exact returned slug with mismatched display identity", async () => {
    const requests: HttpRequest[] = []
    const otherSlug = `${source}-v2-scheduler-verification-${fixtureId}`
    const mismatched = fixtureJob({
      name: "Unexpected verification name",
      description: "Unexpected verification description",
      slug: otherSlug,
      prompt: "test",
      run: { prompt: "test", accessControl: { mode: "full_access" } },
    })
    await expect(
      scheduler.runSchedulerVerificationFixture(
        api(requests, [
          response(404, { success: false }),
          response(200, { success: true, data: { job: mismatched } }),
          response(200, { success: true, data: { job: mismatched } }),
          response(200, { success: true }),
          response(404, { success: false }),
          response(404, { success: false }),
        ]),
        {
          ...common("create"),
          schedule,
          prompt: "test",
          preflightToken,
        },
      ),
    ).rejects.toThrow("rolled back and exact absence was verified")
    const returned = {
      path: `/scheduler/jobs/${otherSlug}`,
      query: { workdir, scopeId },
    }
    expect(requests.slice(2)).toEqual([returned, { ...returned, method: "DELETE" }, returned, exactGet()])
  })

  test("still cleans the deterministic route when a returned candidate is absent", async () => {
    const requests: HttpRequest[] = []
    const otherSlug = `${source}-v2-scheduler-verification-${fixtureId}`
    const mismatched = fixtureJob({ slug: otherSlug, prompt: "test", run: { prompt: "test" } })
    const expected = fixtureJob({ prompt: "test", run: { prompt: "test" } })
    await expect(
      scheduler.runSchedulerVerificationFixture(
        api(requests, [
          response(404, { success: false }),
          response(200, { success: true, data: { job: mismatched } }),
          response(404, { success: false }),
          response(200, { success: true, data: { job: expected } }),
          response(200, { success: true }),
          response(404, { success: false }),
        ]),
        {
          ...common("create"),
          schedule,
          prompt: "test",
          preflightToken,
        },
      ),
    ).rejects.toThrow("rolled back and exact absence was verified")
    expect(requests.map((request) => request.method ?? "GET")).toEqual([
      "GET",
      "POST",
      "GET",
      "GET",
      "DELETE",
      "GET",
    ])
  })

  test("still cleans the deterministic route when the returned identity is unsafe", async () => {
    const requests: HttpRequest[] = []
    const otherSlug = `${source}-v2-scheduler-verification-${fixtureId}`
    const unsafe = fixtureJob({
      slug: otherSlug,
      workdir: "C:\\GitRepros\\other",
      prompt: "test",
      run: { prompt: "test" },
    })
    const expected = fixtureJob({ prompt: "test", run: { prompt: "test" } })
    await expect(
      scheduler.runSchedulerVerificationFixture(
        api(requests, [
          response(404, { success: false }),
          response(200, { success: true, data: { job: unsafe } }),
          response(200, { success: true, data: { job: expected } }),
          response(200, { success: true }),
          response(404, { success: false }),
        ]),
        {
          ...common("create"),
          schedule,
          prompt: "test",
          preflightToken,
        },
      ),
    ).rejects.toThrow(
      "Automatic rollback failed: Create response did not safely identify an exact rollback target.",
    )
    expect(requests).toEqual([
      exactGet(),
      expect.objectContaining({ path: "/scheduler/jobs", method: "POST" }),
      exactGet(),
      { ...exactGet(), method: "DELETE" },
      exactGet(),
    ])
    expect(requests).not.toContainEqual(
      expect.objectContaining({ path: `/scheduler/jobs/${otherSlug}` }),
    )
  })

  test("reports rollback failure when the returned scoped job cannot be deleted", async () => {
    const requests: HttpRequest[] = []
    const otherScope = "other-scope"
    const otherSlug = `${source}-v2-scheduler-verification-${fixtureId}`
    const mismatched = fixtureJob({
      scopeId: otherScope,
      slug: otherSlug,
      prompt: "test",
      run: { prompt: "test" },
    })
    await expect(
      scheduler.runSchedulerVerificationFixture(
        api(requests, [
          response(404, { success: false }),
          response(200, { success: true, data: { job: mismatched } }),
          response(200, { success: true, data: { job: mismatched } }),
          response(409, { success: false, output: "scope does not match workdir" }),
          response(404, { success: false }),
        ]),
        {
          ...common("create"),
          schedule,
          prompt: "test",
          preflightToken,
        },
      ),
    ).rejects.toThrow("Automatic rollback failed")
    expect(requests.slice(-1)).toEqual([exactGet()])
  })

  test("checks and removes the deterministic fixture after a failed create response", async () => {
    const requests: HttpRequest[] = []
    const created = fixtureJob({ prompt: "test", run: { prompt: "test" } })
    await expect(
      scheduler.runSchedulerVerificationFixture(
        api(requests, [
          response(404, { success: false }),
          response(500, { success: false, output: "response assembly failed" }),
          response(200, { success: true, data: { job: created } }),
          response(200, { success: true }),
          response(404, { success: false }),
        ]),
        {
          ...common("create"),
          schedule,
          prompt: "test",
          preflightToken,
        },
      ),
    ).rejects.toThrow("rolled back and exact absence was verified")
    expect(requests.map((request) => request.method ?? "GET")).toEqual(["GET", "POST", "GET", "DELETE", "GET"])
  })

  test("rejects and rolls back every mismatched create workload field", async () => {
    const prompt = "verification prompt"
    const mismatches = [
      fixtureJob({ prompt, schedule: "43 10 18 7 *" }),
      fixtureJob({ prompt: "wrong", run: { prompt } }),
      fixtureJob({ prompt, run: { prompt: "wrong" } }),
      fixtureJob({ prompt, timeoutSeconds: 601 }),
      fixtureJob({ prompt, source: "wrong-source" }),
      fixtureJob({ prompt, runOnce: true }),
      fixtureJob({ prompt, run: { preflight: fixturePreflight({ timeoutSeconds: 31 }) } }),
    ]

    for (const job of mismatches) {
      const requests: HttpRequest[] = []
      await expect(
        scheduler.runSchedulerVerificationFixture(
          api(requests, [
            response(404, { success: false }),
            response(200, { success: true, data: { job } }),
            response(200, { success: true, data: { job } }),
            response(200, { success: true }),
            response(404, { success: false }),
          ]),
          {
            ...common("create"),
            schedule,
            prompt,
            preflightToken,
            timeoutSeconds: 600,
          },
        ),
      ).rejects.toThrow("rolled back and exact absence was verified")
      expect(requests.map((request) => request.method ?? "GET")).toEqual(["GET", "POST", "GET", "DELETE", "GET"])
    }
  })

  test("declares only the capabilities the scheduled jobs app uses", async () => {
    const manifest = await Bun.file(
      new URL("../../../../.opencode/plugin-sources/scheduled-jobs-app/package.json", import.meta.url),
    ).json()

    expect(manifest.opencode.app.capabilities).toEqual([
      "ui:dock",
      "commands",
      "kv",
      "ui:settings",
      "ui:models",
      "host:http",
      "host:navigation",
      "host:session-policy",
      "host:projects",
      "automation",
      "services:opencode-scheduler:jobs",
    ])
  })
})

function common(operation: string) {
  return { operation, fixtureId, expectedScopeId: scopeId, workdir }
}

function exactGet(): HttpRequest {
  return {
    path: `/scheduler/jobs/${slug}`,
    query: { workdir, scopeId },
  }
}

function fixtureJob(overrides: Record<string, unknown> = {}) {
  const prompt = typeof overrides.prompt === "string" ? overrides.prompt : "verification prompt"
  const run = {
    prompt,
    runTarget: "app",
    appSessionStrategy: "new",
    accessControl: { mode: "ask" },
    preflight: fixturePreflight(),
    ...(typeof overrides.run === "object" && overrides.run ? overrides.run : {}),
  }
  return {
    name: `Scheduler verification ${fixtureId}`,
    slug,
    scopeId,
    workdir,
    description: `Isolated scheduled app verification fixture ${fixtureId}.`,
    schedule,
    source,
    timeoutSeconds: 600,
    prompt,
    ...overrides,
    run,
  }
}

function fixturePreflight(overrides: Record<string, unknown> = {}) {
  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", `Write-Output '${preflightToken}'`],
    timeoutSeconds: 30,
    ...overrides,
  }
}

function api(requests: HttpRequest[], responses: HttpResponse[]) {
  return {
    services: {
        call: async (call: { pluginID: string; serviceID: string; version: number; input: HttpRequest; directory?: string }) => {
          expect({ pluginID: call.pluginID, serviceID: call.serviceID, version: call.version }).toEqual({pluginID:"opencode-scheduler",serviceID:"jobs",version:1})
          if (call.input.directory) expect(call.directory).toBe(call.input.directory)
          const { method, ...request } = call.input
          requests.push(method === "GET" ? request : { ...request, method })
          const next = responses.shift()
          if (!next) throw new Error("Unexpected scheduler service request")
          return { ok: true, data: { status: next.status, body: next.body } }
        },
    },
  }
}

function response(status: number, body: unknown): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? "Not Found" : "OK",
    body,
  }
}
