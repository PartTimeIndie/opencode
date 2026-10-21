import { expect, test } from "bun:test"
import type { Config, Hooks } from "@opencode-ai/plugin"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { CursorPlugin } from "../../../provider-plugins/cursor/src/upstream/plugin.js"
import { flushPlanExecutionKickoff, queuePlanExecutionKickoff, planExecutionKickoffState, setPlanExecutionKickoff } from "../../../provider-plugins/cursor/src/upstream/plan-execution-kickoff.js"
import { tmpdir } from "../fixture/fixture"

test("Cursor discovery uses only the public host credential and does not add an unauthenticated provider", async () => {
  await using directory = await tmpdir()
  const requests: string[] = []
  const server = Bun.serve({ port: 0, fetch(request) {
    requests.push(request.headers.get("authorization") ?? "")
    return Response.json({ models: [{ name: "neutral-model", clientDisplayName: "Neutral model", supportsAgent: true }] })
  } })
  const previous = { base: process.env.CURSOR_API_BASE_URL, version: process.env.CURSOR_CLIENT_VERSION, auth: process.env.OPENCODE_AUTH_CONTENT }
  let hooks: Hooks | undefined
  try {
    process.env.CURSOR_API_BASE_URL = server.url.origin
    process.env.CURSOR_CLIENT_VERSION = "test"
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ cursor: { type: "api", key: "ambient-must-not-be-used" } })
    hooks = await CursorPlugin({ directory: directory.path, client: createOpencodeClient({ baseUrl: server.url.origin }) } as never)
    const config: Config = {}
    await hooks.config?.(config)
    expect(config.provider).toBeUndefined()
    expect(requests).toEqual([])
    expect(await hooks.auth!.loader!(async () => undefined as never, {} as never)).not.toHaveProperty("accessToken")
    expect(requests).toEqual([])
    const models = await hooks.provider!.models!({ models: {} } as never, { auth: { type: "api", key: "explicit-public-token" } } as never)
    expect(requests).toEqual(["Bearer explicit-public-token"])
    expect(models["neutral-model"].name).toBe("Neutral model")
    expect(models["neutral-model"].providerID).toBe("cursor")
  } finally {
    await hooks?.dispose?.()
    server.stop(true)
    for (const [key, value] of Object.entries({ CURSOR_API_BASE_URL: previous.base, CURSOR_CLIENT_VERSION: previous.version, OPENCODE_AUTH_CONTENT: previous.auth })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test("Cursor plan handoffs remain workspace scoped and disposing one plugin clears only its pending work", async () => {
  await using directory = await tmpdir()
  const requests: string[] = []
  const server = Bun.serve({ port: 0, fetch(request) { requests.push(new URL(request.url).pathname); return new Response(null, { status: 204 }) } })
  const client = createOpencodeClient({ baseUrl: server.url.origin })
  const sdk = await import("@opencode-ai/sdk/v2")
  const clientV2 = sdk.createOpencodeClient({ baseUrl: server.url.origin })
  const first = await CursorPlugin({ directory: `${directory.path}/first`, client, clientV2 } as never)
  const second = await CursorPlugin({ directory: `${directory.path}/second`, client, clientV2 } as never)
  try {
    expect(queuePlanExecutionKickoff({ sessionID: "session-first", planPath: "plan.md", workspaceRoot: `${directory.path}/first` })).toBe(true)
    expect(queuePlanExecutionKickoff({ sessionID: "session-second", planPath: "plan.md", workspaceRoot: `${directory.path}/second` })).toBe(true)
    expect(queuePlanExecutionKickoff({ sessionID: "session-third", planPath: "plan.md", workspaceRoot: `${directory.path}/third` })).toBe(false)
    await first.dispose?.()
    expect(planExecutionKickoffState("session-first")).toBeUndefined()
    expect(await flushPlanExecutionKickoff("session-first", { terminal: true })).toBe(false)
    const flushed = await flushPlanExecutionKickoff("session-second", { terminal: true })
    expect(planExecutionKickoffState("session-second")).toBeUndefined()
    expect(flushed).toBe(true)
    expect(requests).toEqual(["/api/session/session-second/prompt"])
    expect(await flushPlanExecutionKickoff("session-second", { terminal: true })).toBe(false)
  } finally {
    await first.dispose?.()
    await second.dispose?.()
    server.stop(true)
  }
})

test("Cursor explicit clearing and shared callbacks preserve registration ownership", async () => {
  await using directory = await tmpdir()
  const calls: string[] = []
  const handler = async (input: { sessionID: string }) => { calls.push(input.sessionID) }
  const first = setPlanExecutionKickoff(handler, `${directory.path}/first`)
  const second = setPlanExecutionKickoff(handler, `${directory.path}/second`)
  try {
    queuePlanExecutionKickoff({ sessionID: "first", planPath: "plan", workspaceRoot: `${directory.path}/first` })
    queuePlanExecutionKickoff({ sessionID: "second", planPath: "plan", workspaceRoot: `${directory.path}/second` })
    setPlanExecutionKickoff(undefined, `${directory.path}/first`)
    expect(await flushPlanExecutionKickoff("first", { terminal: true })).toBe(false)
    first()
    expect(await flushPlanExecutionKickoff("second", { terminal: true })).toBe(true)
    expect(calls).toEqual(["second"])
  } finally { first(); second() }
})

test("Cursor concurrent flush admits one handoff and permits an explicit retry after failure", async () => {
  await using directory = await tmpdir()
  const gate = Promise.withResolvers<void>()
  const calls: string[] = []
  const dispose = setPlanExecutionKickoff(async () => {
    calls.push("invoke")
    if (calls.length === 1) { await gate.promise; throw new Error("retryable test failure") }
  }, directory.path)
  try {
    queuePlanExecutionKickoff({ sessionID: "concurrent", planPath: "plan", workspaceRoot: directory.path })
    const first = flushPlanExecutionKickoff("concurrent", { terminal: true })
    expect(await flushPlanExecutionKickoff("concurrent", { terminal: true })).toBe(false)
    expect(calls).toHaveLength(1)
    gate.resolve()
    expect(await first).toBe(false)
    expect(planExecutionKickoffState("concurrent")?.status).toBe("failed")
    expect(await flushPlanExecutionKickoff("concurrent", { terminal: true })).toBe(true)
    expect(calls).toHaveLength(2)
    expect(await flushPlanExecutionKickoff("concurrent", { terminal: true })).toBe(false)
  } finally { gate.resolve(); dispose() }
})
