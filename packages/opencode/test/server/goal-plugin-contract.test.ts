import { describe, expect, test } from "bun:test"
import path from "node:path"
import goalPlugin, { GoalPlugin } from "../../../goal-plugin/index"
import { readV1Plugin, resolvePluginId } from "../../src/plugin/shared"
import { createPluginServiceRegistry } from "../../src/plugin/services"
import { createGoalOwnershipRegistry } from "../../src/plugin/completion"
import { sessionGoalMetadataPatch } from "../../../server/src/session-goal"

// Real package + loader identity + service/ownership registries, fixture transport.
// HTTP authentication/session routing is covered by httpapi-plugin-services.test.ts.
describe("in-repo goal plugin host contract", () => {
  test("file module retains the fixed service identity and forwards options", async () => {
    const module = readV1Plugin({ default: goalPlugin }, "file:///goal-plugin", "server")
    expect(module?.server).toBe(GoalPlugin)
    expect(await resolvePluginId("file", "file:///goal-plugin", "file:///goal-plugin/index.ts", module?.id as string)).toBe("opencode-goal-plugin")
    const fixture = await setup()
    try {
      await fixture.boundary()
      expect(fixture.prompts).toHaveLength(1)
      expect(fixture.prompts[0]).toMatchObject({ sessionID: "s1", expectedLatestInputID: null })
      expect(fixture.prompts[0].text).toContain("1/1")
      expect(fixture.ownership.ownedSync(fixture.directory, "s1")).toBe(true)
      await fixture.boundary()
      expect(fixture.prompts).toHaveLength(1)
      expect(fixture.status()).toMatchObject({ stopped: true, stopReason: "max-continuations" })
      expect(await fixture.control({ action: "resume", operationID: "resume", expectedRevision: 0 })).toMatchObject({ ok: true, controlRevision: 1 })
      expect(fixture.prompts).toHaveLength(2)
      expect(await fixture.control({ action: "pause", operationID: "pause", expectedRevision: 1 })).toMatchObject({ ok: true, controlRevision: 2 })
      expect(await fixture.control({ action: "pause", operationID: "pause", expectedRevision: 1 })).toMatchObject({ ok: true, controlRevision: 2 })
      expect(await fixture.control({ action: "resume", operationID: "stale", expectedRevision: 0 })).toMatchObject({ ok: false, error: "revision" })
      expect(await fixture.control({ sessionID: "foreign", action: "pause", operationID: "foreign" })).toMatchObject({ ok: false, error: "session-mismatch" })
      await expect(fixture.control({ action: "delete", operationID: "invalid" })).rejects.toMatchObject({ code: "input" })
    } finally { await fixture.dispose() }
  })

  test("attested completion clears all three keys with run-bound CAS", async () => {
    const fixture = await setup()
    try {
      await fixture.boundary()
      fixture.evidence.value = "[goal:evidence] tests verified\n[goal:complete]"
      await fixture.boundary()
      expect(fixture.metadata).toEqual({})
      expect(fixture.clears).toEqual([{ sessionID: "s1", condition: "ship it", runID: fixture.runID }])
      expect(fixture.ownership.ownedSync(fixture.directory, "s1")).toBe(false)
    } finally { await fixture.dispose() }
  })

  test("the real setter's same-text replacement invalidates old completion", async () => {
    const fixture = await setup()
    try {
      await fixture.boundary()
      const replacement = sessionGoalMetadataPatch({ type: "set", value: "ship it" })
      if (!replacement || !("set" in replacement)) throw new Error("missing set patch")
      Object.assign(fixture.metadata, replacement.set)
      replacement.unset?.forEach((key) => delete fixture.metadata[key])
      fixture.evidence.value = "[goal:evidence] old run\n[goal:complete]"
      await fixture.boundary()
      expect(fixture.clears).toHaveLength(0)
      expect(fixture.prompts).toHaveLength(2)
      expect(fixture.metadata["opencode.session.goal_run"]).not.toBe(fixture.runID)
    } finally { await fixture.dispose() }
  })

  test("a replacement racing CAS clear keeps all replacement metadata untouched", async () => {
    const fixture = await setup()
    try {
      await fixture.boundary()
      fixture.evidence.value = "[goal:evidence] old run\n[goal:complete]"
      fixture.onClear.run = () => {
        const replacement = sessionGoalMetadataPatch({ type: "set", value: "ship it" })
        if (!replacement || !("set" in replacement)) throw new Error("missing set patch")
        Object.assign(fixture.metadata, replacement.set)
        replacement.unset?.forEach((key) => delete fixture.metadata[key])
      }
      await fixture.boundary()
      expect(fixture.clears).toHaveLength(0)
      expect(fixture.metadata).toEqual({ "opencode.session.goal": "ship it", "opencode.session.goal_run": expect.any(String) })
      expect(fixture.metadata["opencode.session.goal_run"]).not.toBe(fixture.runID)
    } finally { await fixture.dispose() }
  })
})

async function setup() {
  const directory = path.resolve("goal-contract-fixture")
  const initial = sessionGoalMetadataPatch({ type: "set", value: "ship it" })
  if (!initial || !("set" in initial)) throw new Error("missing set patch")
  const metadata: Record<string, unknown> = { ...initial.set }
  const runID = String(metadata["opencode.session.goal_run"])
  const prompts: Array<{ sessionID: string; text: string; expectedLatestInputID?: string | null }> = []
  const clears: Array<{ sessionID: string; condition: string; runID: string }> = []
  const evidence = { value: "still working" }
  const onClear = { run: () => {} }
  const registry = createPluginServiceRegistry({ authorize: () => true })
  const ownership = createGoalOwnershipRegistry()
  const binding = registry.bind({ pluginID: goalPlugin.id, directory, projectID: "project-1" })
  const releases: Array<() => void> = []
  const plugin = await goalPlugin.server({
    directory,
    services: binding.services,
    client: { session: {
      get: async () => ({ data: { metadata } }),
      update: async (args) => {
        const patch = args.body.metadataPatch as { set?: Record<string, unknown> }
        Object.assign(metadata, patch.set)
        return { data: { metadata } }
      },
      messages: async () => { throw new Error("unbound history must not be read") },
    } },
    host: { sessions: {
      prompt: async (args) => {
        if (args.goal && (metadata["opencode.session.goal"] !== args.goal.condition || metadata["opencode.session.goal_run"] !== args.goal.runID || metadata["opencode.session.goal_status"] !== args.goal.expectedStatus)) throw { _tag: "SessionBusyError" }
        prompts.push(args)
        const id = `input-${prompts.length}`
        const goalStatus = args.goal ? JSON.stringify({ ...JSON.parse(args.goal.status), active: { promptID: id } }) : undefined
        if (goalStatus) metadata["opencode.session.goal_status"] = goalStatus
        return { id, goalStatus }
      },
      admissionHead: async () => ({ id: prompts.length ? `input-${prompts.length}` : null }),
      inputOrigin: async () => "plugin",
      execution: { read: async () => ({
        phase: "activity", activity: { status: "completed", closed_seq: 10 },
        questions: [], laterInputs: [], laterAdmissions: [],
        assistants: [{ id: "assistant-1", data: { content: [{ type: "text", text: evidence.value }] } }],
      }) },
      goalOwnership: {
        project: async (request) => {
          if (metadata["opencode.session.goal"] !== request.condition || metadata["opencode.session.goal_run"] !== request.runID || metadata["opencode.session.goal_status"] !== request.expectedStatus) return false
          metadata["opencode.session.goal_status"] = request.status
          return true
        },
        register: (policy) => { releases.push(ownership.register(directory, policy)) },
        clear: async (request) => {
          onClear.run()
          if (metadata["opencode.session.goal"] !== request.condition || metadata["opencode.session.goal_run"] !== request.runID) return
          clears.push(request)
          for (const key of Object.keys(metadata)) delete metadata[key]
        },
      },
    } },
  }, { maxContinuations: 1, cooldownMs: 0 })
  return {
    directory, metadata, prompts, clears, evidence, ownership, runID, onClear,
    status: () => JSON.parse(String(metadata["opencode.session.goal_status"])),
    boundary: () => plugin.event({ event: { type: "session.runner.settled", properties: { sessionID: "s1" } } }),
    control: (operation: Record<string, unknown>) => registry.invoke({
      pluginID: goalPlugin.id, serviceID: "control", version: 1,
      input: { sessionID: "s1", runID, ...operation },
    }, { pluginID: "opencode-host", directory, projectID: "project-1", sessionID: "s1", signal: new AbortController().signal }),
    dispose: async () => { releases.forEach((release) => release()); await binding.dispose() },
  }
}
