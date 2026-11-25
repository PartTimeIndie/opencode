import { describe, expect, test } from "bun:test"
import { GoalPlugin } from "../index"

type ExecutionView = Awaited<ReturnType<Parameters<typeof GoalPlugin>[0]["host"]["sessions"]["execution"]["read"]>>
type PromptRequest = Parameters<Parameters<typeof GoalPlugin>[0]["host"]["sessions"]["prompt"]>[0]

const settledView = () => ({
  phase: "activity",
  activity: { status: "completed", closed_seq: 5 },
  questions: [] as unknown[],
  laterInputs: [] as unknown[],
  laterAdmissions: [] as unknown[],
  assistants: [{ id: "a1" }],
})

const unsettledView = () => ({
  phase: "activity",
  activity: { status: "running" },
  questions: [],
  laterInputs: [],
  laterAdmissions: [],
})

const assistantText = (text: string) => [{ info: { role: "assistant", parts: [{ type: "text", text }] } }]

async function harness(options: { maxContinuations?: number; cooldownMs?: number } = {}) {
  const metadata: Record<string, Record<string, unknown>> = {}
  const messageLists: Record<string, unknown[]> = {}
  const views: Record<string, ExecutionView | undefined> = {}
  const origins: Record<string, string> = {}
  const prompts: Array<{ sessionID: string; text: string; expectedLatestInputID?: string | null }> = []
  const clears: Array<{ sessionID: string; condition: string; runID: string }> = []
  let serviceExecute: ((input: unknown, context: { sessionID?: string; signal: AbortSignal }) => Promise<unknown>) | null = null
  let head: string | null = null
  let failPrompt = false
  let failClear = false
  let beforeUpdate = async () => {}
  let beforePrompt = async () => {}
  let beforeRead = async () => {}
  let failProject = false
  let dispose = () => {}
  let policy: ((input: { sessionID: string }) => boolean) | null = null

  const setGoal = (sessionID: string, condition: string, runID: string) => {
    metadata[sessionID] = {
      ...(metadata[sessionID] ?? {}),
      "opencode.session.goal": condition,
      "opencode.session.goal_run": runID,
    }
    delete metadata[sessionID]["opencode.session.goal_status"]
  }
  const status = (sessionID: string) => {
    const raw = metadata[sessionID]?.["opencode.session.goal_status"]
    return typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : undefined
  }

  const client = {
    session: {
      get: async (args: { path: { id: string } }) => ({ data: { metadata: metadata[args.path.id] ?? {} } }),
      update: async (args: {
        path: { id: string }
        body: { metadataPatch: unknown }
      }) => {
        await beforeUpdate()
        const patch = args.body.metadataPatch as { set?: Record<string, unknown>; unset?: string[] }
        metadata[args.path.id] = { ...(metadata[args.path.id] ?? {}) }
        if (patch.set)
          for (const [key, value] of Object.entries(patch.set)) metadata[args.path.id][key] = value
        if (patch.unset)
          for (const key of patch.unset) delete metadata[args.path.id][key]
        return { data: { metadata: metadata[args.path.id] } }
      },
      messages: async (args: { path: { id: string } }) => ({ data: { messages: messageLists[args.path.id] ?? [] } }),
    },
  }

  const host = {
    sessions: {
      prompt: async (args: PromptRequest) => {
        await beforePrompt()
        if (failPrompt) throw new Error("transport down")
        if (args.expectedLatestInputID !== head) throw { _tag: "SessionBusyError" }
        const md = metadata[args.sessionID] ?? {}
        if (args.goal && (md["opencode.session.goal"] !== args.goal.condition || md["opencode.session.goal_run"] !== args.goal.runID || md["opencode.session.goal_status"] !== args.goal.expectedStatus)) throw { _tag: "SessionBusyError" }
        prompts.push(args)
        head = `in-${prompts.length}`
        origins[head] = "plugin"
        const goalStatus = args.goal ? JSON.stringify({ ...JSON.parse(args.goal.status), active: { promptID: head } }) : undefined
        if (goalStatus) md["opencode.session.goal_status"] = goalStatus
        return { id: head, goalStatus }
      },
      admissionHead: async () => ({ id: head }),
      inputOrigin: async (args: { inputID: string }) => origins[args.inputID] ?? "interactive",
      execution: { read: async (args: { sessionID: string; messageID: string }) => { await beforeRead(); return views[args.messageID] ?? {
        ...settledView(),
        assistants: [{ id: "a1", data: { content: (messageLists[args.sessionID]?.at(-1) as { info?: { parts?: unknown[] } })?.info?.parts ?? [] } }],
      } } },
      goalOwnership: {
        project: async (args: Parameters<Parameters<typeof GoalPlugin>[0]["host"]["sessions"]["goalOwnership"]["project"]>[0]) => {
          await beforeUpdate()
          if (failProject) throw new Error("projection failed")
          const md = metadata[args.sessionID] ?? {}
          if (md["opencode.session.goal"] !== args.condition || md["opencode.session.goal_run"] !== args.runID || md["opencode.session.goal_status"] !== args.expectedStatus) return false
          md["opencode.session.goal_status"] = args.status
          return true
        },
        register: async (input: (i: { sessionID: string }) => boolean) => {
          policy = input
        },
        clear: async (args: { sessionID: string; condition: string; runID: string }) => {
          if (failClear) throw new Error("forced clear failure")
          const md = metadata[args.sessionID] ?? {}
          if (md["opencode.session.goal"] !== args.condition || md["opencode.session.goal_run"] !== args.runID)
            throw new Error("CAS mismatch")
          clears.push(args)
          delete md["opencode.session.goal"]
          delete md["opencode.session.goal_run"]
          delete md["opencode.session.goal_status"]
        },
      },
    },
  }

  const create = () => GoalPlugin(
    {
      client,
      directory: "E:/fixture",
      host,
      services: {
        register: (definition: unknown) => {
          serviceExecute = (definition as { execute: typeof serviceExecute }).execute
          dispose = (definition as { dispose: () => void }).dispose
        },
      },
    },
    options,
  )
  let plugin = await create()

  const boundary = (sessionID: string, type = "session.idle") =>
    plugin.event({ event: { type, properties: { sessionID } } })

  const control = (sessionID: string, input: Record<string, unknown>, contextSessionID = sessionID) =>
    (serviceExecute ?? (async () => null))(
      { sessionID, action: "pause", operationID: "op-1", ...input },
      { sessionID: contextSessionID, signal: new AbortController().signal },
    )

  const transform = async (sessionID: string) => {
    const output: { system: unknown[] } = { system: [] }
    await plugin["experimental.chat.system.transform"]({ sessionID }, output)
    return output
  }

  return {
    metadata,
    prompts,
    clears,
    setGoal,
    status,
    boundary,
    control,
    command: (action: string) => plugin["command.execute.before"]({ command: "goal", sessionID: "s1", arguments: action }),
    transform,
    policy: () => policy,
    reload: async () => { dispose(); plugin = await create() },
    dispose: () => dispose(),
    invoke: (input: Record<string, unknown>, context: { sessionID?: string; signal: AbortSignal }) => serviceExecute!({ action: "pause", operationID: "raw", ...input }, context),
    set: {
      beforeUpdate: (hook: () => Promise<void>) => { beforeUpdate = hook },
      beforePrompt: (hook: () => Promise<void>) => { beforePrompt = hook },
      beforeRead: (hook: () => Promise<void>) => { beforeRead = hook },
      failProject: (value: boolean) => { failProject = value },
      head: (value: string | null) => {
        head = value
      },
      origin: (inputID: string, origin: string) => {
        origins[inputID] = origin
      },
      view: (inputID: string, view: ExecutionView | undefined) => {
        views[inputID] = view
      },
      messages: (sessionID: string, list: unknown[]) => {
        messageLists[sessionID] = list
      },
      failPrompt: (value: boolean) => {
        failPrompt = value
      },
      failClear: (value: boolean) => {
        failClear = value
      },
    },
  }
}

describe("goal plugin loop", () => {
  test("metadata-only replacement fences an old prompt at atomic admission", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "old", "run-1")
    env.set.beforePrompt(async () => env.setGoal("s1", "new", "run-2"))
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(0)
    expect(env.metadata.s1["opencode.session.goal_run"]).toBe("run-2")
    expect(env.status("s1")).toBeUndefined()
  })

  test("reload restores the exact receipt and consumes completion at the cap", async () => {
    const env = await harness({ cooldownMs: 0, maxContinuations: 1 })
    env.setGoal("s1", "ship it", "run-1")
    await env.boundary("s1")
    env.set.view("in-1", unsettledView())
    await env.reload()
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(1)
    env.set.view("in-1", undefined)
    env.set.messages("s1", assistantText("[goal:evidence] verified\n[goal:complete]"))
    await env.boundary("s1")
    expect(env.clears).toHaveLength(1)
    expect(env.prompts).toHaveLength(1)
  })

  for (const terminal of ["failed", "interrupted"]) test(`${terminal} activity pauses until explicit Continue`, async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    await env.boundary("s1")
    env.set.view("in-1", { ...settledView(), activity: { status: terminal, closed_seq: 5 } })
    await env.boundary("s1")
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(1)
    expect(env.status("s1")?.stopped).toBe(true)
    await env.control("s1", { action: "resume" })
    expect(env.prompts).toHaveLength(2)
    expect(env.clears).toHaveLength(0)
  })

  test("malformed saved status fails closed without breaking chat transformation", async () => {
    for (const raw of ["not JSON", "null", "[]", JSON.stringify({ runID: "run-1", condition: "wrong", stopped: false, controlRevision: -1, continues: -50 }),
      JSON.stringify({ runID: "run-1", condition: "ship it", stopped: false, phase: "paused", stopReason: "paused", controlRevision: 0, continues: 0, active: null }),
      JSON.stringify({ runID: "run-1", condition: "ship it", stopped: false, phase: "working", stopReason: "", controlRevision: 0, continues: 0, active: { promptID: "" } }),
    ]) {
      const env = await harness({ cooldownMs: 0 })
      env.setGoal("s1", "ship it", "run-1")
      env.metadata.s1["opencode.session.goal_status"] = raw
      expect((await env.transform("s1")).system).toHaveLength(0)
      await env.boundary("s1")
      expect(env.prompts).toHaveLength(0)
      expect(env.status("s1")).toMatchObject({ phase: "paused", stopped: true, stopReason: "invalid-saved-status" })
      await env.control("s1", { action: "resume", expectedRevision: 0 })
      expect(env.prompts).toHaveLength(1)
    }
  })
  test("typed inbox CAS rejection defers without permanently pausing human input", async () => {
    const env = await harness({ maxContinuations: 1, cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    env.set.beforePrompt(async () => {
      env.set.head("human")
      env.set.view("human", unsettledView())
    })
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(0)
    expect(env.status("s1")).toMatchObject({ stopped: false, continues: 0 })
    env.set.beforePrompt(async () => {})
    env.set.view("human", settledView())
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(1)
    expect(env.prompts[0].expectedLatestInputID).toBe("human")
    expect(env.status("s1")).toMatchObject({ stopped: false, continues: 1 })
  })
  test("an unsettled admitted continuation cannot be launched twice", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    await env.boundary("s1")
    env.set.head("in-1")
    env.set.view("in-1", unsettledView())
    await env.boundary("s1", "session.runner.settled")
    await env.boundary("s1", "session.turn.completed")
    expect(env.prompts).toHaveLength(1)
  })

  test("new human head supersedes an active continuation and settles once", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    await env.boundary("s1")
    env.set.view("in-1", { ...settledView(), laterAdmissions: ["human-1"] })
    env.set.head("human-1")
    env.set.view("human-1", unsettledView())
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(1)
    env.set.head("human-2")
    env.set.view("human-2", unsettledView())
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(1)
    env.set.view("human-2", settledView())
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(2)
    expect(env.prompts[1].expectedLatestInputID).toBe("human-2")
  })

  test("open questions block markers and admission", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    await env.boundary("s1")
    env.set.view("in-1", { ...settledView(), questions: [{ id: "q1" }] })
    env.set.messages("s1", assistantText("[goal:evidence] old\n[goal:complete]"))
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(1)
    expect(env.clears).toHaveLength(0)
  })

  test("unrelated history cannot supply completion evidence", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    await env.boundary("s1")
    env.set.messages("s1", assistantText("[goal:evidence] old\n[goal:complete]"))
    env.set.view("in-1", { ...settledView(), assistants: [{ id: "exact", data: { content: [{ type: "text", text: "still working" }] } }] })
    await env.boundary("s1")
    expect(env.clears).toHaveLength(0)
    expect(env.prompts).toHaveLength(2)
  })

  test("a failed tool in an earlier assistant vetoes a later complete marker", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    await env.boundary("s1")
    env.set.view("in-1", { ...settledView(), assistants: [
      { id: "tool-step", data: { content: [{ type: "tool", state: { status: "error" } }] } },
      { id: "final", data: { content: [{ type: "text", text: "[goal:evidence] supposedly done\n[goal:complete]" }] } },
    ] })
    await env.boundary("s1")
    expect(env.clears).toHaveLength(0)
    expect(env.prompts).toHaveLength(1)
    expect(env.status("s1")).toMatchObject({ stopped: true, stopReason: "continuation-failed" })
  })

  test("restart restores a paused run, its revision and continuation cap", async () => {
    const env = await harness({ maxContinuations: 1, cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    env.metadata.s1["opencode.session.goal_status"] = JSON.stringify({ runID: "run-1", condition: "ship it", phase: "paused", stopped: true, stopReason: "max-continuations", controlRevision: 7, continues: 1, active: null })
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(0)
    expect(await env.control("s1", { action: "resume", expectedRevision: 0 })).toMatchObject({ ok: false, error: "revision", controlRevision: 7 })
    expect(await env.control("s1", { action: "resume", expectedRevision: 7, operationID: "new" })).toMatchObject({ ok: true, controlRevision: 8 })
    expect(env.prompts).toHaveLength(1)
  })

  test("default cap admits fifty continuations, never fifty-one", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    for (let i = 0; i < 51; i++) await env.boundary("s1")
    expect(env.prompts).toHaveLength(50)
    expect(env.status("s1")).toMatchObject({ stopped: true, stopReason: "max-continuations", continues: 50 })
  })

  test("a real settlement boundary is retained across cooldown", async () => {
    const env = await harness({ cooldownMs: 20 })
    env.setGoal("s1", "ship it", "run-1")
    env.set.head("human")
    env.set.view("human", unsettledView())
    await env.boundary("s1")
    env.set.view("human", settledView())
    await env.boundary("s1", "session.runner.settled")
    expect(env.prompts).toHaveLength(1)
  })
  test("boundary without a goal is a no-op", async () => {
    const env = await harness({ cooldownMs: 0 })
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(0)
    expect(env.status("s1")).toBeUndefined()
  })

  test("UI goal is picked up at the next boundary and continues with CAS", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(1)
    expect(env.prompts[0].text).toContain("ship it")
    expect(env.prompts[0].expectedLatestInputID).toBeNull()
    expect(env.status("s1")).toMatchObject({ phase: "working", stopped: false, runID: "run-1", condition: "ship it" })
  })

  test("continuation carries the admitted head as CAS when one exists", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    env.set.head("h1")
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(1)
    expect(env.prompts[0].expectedLatestInputID).toBe("h1")
  })

  test("cap pauses with max-continuations and continue resets the counter", async () => {
    const env = await harness({ maxContinuations: 2, cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    await env.boundary("s1")
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(2)
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(2)
    expect(env.status("s1")).toMatchObject({ phase: "paused", stopped: true, stopReason: "max-continuations" })
    const outcome = (await env.control("s1", { action: "resume", runID: "run-1" })) as Record<string, unknown>
    expect(outcome).toMatchObject({ ok: true, controlRevision: 1 })
    // Resume drives one continuation immediately; the next boundary settles it
    // and continues the loop once more before the cap pauses again.
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(4)
  })

  test("newer human input defers exactly one continuation, then continues once", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    env.set.head("h1")
    env.set.view("h1", unsettledView())
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(0)
    env.set.view("h1", undefined)
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(1)
    expect(env.prompts[0].expectedLatestInputID).toBe("h1")
    // The settled input drove exactly one deferred continuation; the next
    // boundary is the normal loop continuing, not a duplicate deferral.
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(2)
  })

  test("deferred continuation counts toward the cap", async () => {
    const env = await harness({ maxContinuations: 1, cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    env.set.head("h1")
    env.set.view("h1", unsettledView())
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(0)
    env.set.view("h1", undefined)
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(1)
    await env.boundary("s1")
    expect(env.status("s1")).toMatchObject({ stopped: true, stopReason: "max-continuations" })
    await env.control("s1", { action: "resume", runID: "run-1" })
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(2)
    expect(env.status("s1")).toMatchObject({ stopped: true, stopReason: "max-continuations" })
  })

  test("run change invalidates a pending deferral", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    env.set.head("h1")
    env.set.view("h1", unsettledView())
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(0)
    env.setGoal("s1", "ship it 2", "run-2")
    env.set.view("h1", undefined)
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(1)
    expect(env.prompts[0].text).toContain("ship it 2")
  })

  test("achieved outcome clears ownership run-bound", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    await env.boundary("s1")
    env.set.messages("s1", assistantText("checked tests\n[goal:evidence] all green\n[goal:complete]"))
    await env.boundary("s1")
    expect(env.clears).toEqual([{ sessionID: "s1", condition: "ship it", runID: "run-1" }])
    expect(env.status("s1")).toBeUndefined()
    expect(env.metadata["s1"]["opencode.session.goal"]).toBeUndefined()
    expect(env.policy()?.({ sessionID: "s1" })).toBe(false)
  })

  test("goal:complete without evidence keeps working", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    await env.boundary("s1")
    env.set.messages("s1", assistantText("looks done\n[goal:complete]"))
    await env.boundary("s1")
    expect(env.clears).toHaveLength(0)
    expect(env.status("s1")).toMatchObject({ phase: "working", stopped: false })
  })

  test("blocked marker pauses with the concrete blocker", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    await env.boundary("s1")
    env.set.messages("s1", assistantText("cannot continue\nmissing API credentials\n[goal:blocked]"))
    await env.boundary("s1")
    expect(env.status("s1")).toMatchObject({ phase: "paused", stopped: true })
    expect(String(env.status("s1")?.stopReason)).toContain("missing API credentials")
    expect(env.clears).toHaveLength(0)
  })

  test("failed ownership CAS keeps the goal and skips the status write", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    await env.boundary("s1")
    env.set.failClear(true)
    env.set.messages("s1", assistantText("done\n[goal:evidence] verified\n[goal:complete]"))
    await expect(env.boundary("s1")).rejects.toThrow("forced clear failure")
    expect(env.clears).toHaveLength(0)
    expect(env.metadata["s1"]["opencode.session.goal"]).toBe("ship it")
    expect(env.status("s1")?.phase).not.toBe("achieved")
    expect(env.policy()?.({ sessionID: "s1" })).toBe(true)
  })

  test("ambiguous transport admission pauses instead of duplicating", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    env.set.failPrompt(true)
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(0)
    expect(env.status("s1")).toMatchObject({ stopped: true, stopReason: "continuation-failed" })
    expect(env.policy()?.({ sessionID: "s1" })).toBe(false)
  })

  test("system block is injected once and dropped when stopped", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    await env.boundary("s1")
    const first = await env.transform("s1")
    expect(first.system).toHaveLength(1)
    expect(String(first.system[0])).toContain("ship it")
    expect(String(first.system[0])).toContain("[goal:complete]")
    const second = await env.transform("s1")
    expect(second.system).toHaveLength(1)
    await env.control("s1", { action: "pause", runID: "run-1", expectedRevision: 0 })
    const stopped = await env.transform("s1")
    expect(stopped.system).toHaveLength(0)
  })
})

describe("goal plugin control service", () => {
  test("unbound calls are rejected before session reads or mutation", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("foreign", "private", "run-1")
    expect(await env.invoke({ sessionID: "foreign" }, { signal: new AbortController().signal })).toMatchObject({ ok: false, error: "session-mismatch" })
    expect(env.status("foreign")).toBeUndefined()
  })

  test("Pause racing a successful admission advances its revision once", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    env.set.beforePrompt(async () => { entered.resolve(); await gate.promise })
    const boundary = env.boundary("s1")
    await entered.promise
    const pause = env.control("s1", { action: "pause", expectedRevision: 0 })
    gate.resolve()
    await boundary
    expect(await pause).toMatchObject({ ok: true, controlRevision: 1 })
    expect(env.status("s1")).toMatchObject({ stopped: true, controlRevision: 1 })
    expect(await env.control("s1", { action: "resume", operationID: "stale", expectedRevision: 0 })).toMatchObject({ ok: false, error: "revision" })
    expect(env.prompts).toHaveLength(1)
  })

  test("failed Pause persistence is repairable with its original operation and revision", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    await env.boundary("s1")
    env.set.failProject(true)
    await expect(env.control("s1", { action: "pause", expectedRevision: 0 })).rejects.toThrow("projection failed")
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(1)
    env.set.failProject(false)
    expect(await env.control("s1", { action: "pause", expectedRevision: 0 })).toMatchObject({ ok: true, controlRevision: 1 })
    await env.reload()
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(1)
  })

  test("failed Resume persistence remains stopped and retries once with the same receipt", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    await env.control("s1", { action: "pause", operationID: "pause" })
    env.set.failProject(true)
    await expect(env.control("s1", { action: "resume", operationID: "resume", expectedRevision: 1 })).rejects.toThrow("projection failed")
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(0)
    expect(await env.control("s1", { action: "resume", operationID: "other" })).toMatchObject({ ok: false, error: "persistence-pending" })
    env.set.failProject(false)
    expect(await env.control("s1", { action: "resume", operationID: "resume", expectedRevision: 1 })).toMatchObject({ ok: true, controlRevision: 2 })
    expect(await env.control("s1", { action: "resume", operationID: "resume", expectedRevision: 1 })).toMatchObject({ ok: true, controlRevision: 2 })
    expect(env.prompts).toHaveLength(1)
  })

  test("service disposal rejects a queued control and prevents admission after an await", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    env.set.head("human")
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    env.set.beforeRead(async () => { entered.resolve(); await gate.promise })
    const boundary = env.boundary("s1")
    await entered.promise
    const queued = env.control("s1", { action: "resume" })
    env.dispose()
    gate.resolve()
    const outcomes = await Promise.allSettled([boundary, queued])
    expect(outcomes.map((result) => result.status)).toEqual(["rejected", "rejected"])
    expect(env.prompts).toHaveLength(0)
    expect(env.status("s1")).toBeUndefined()
  })

  test("restored non-plugin receipt cannot supply completion evidence", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    env.metadata.s1["opencode.session.goal_status"] = JSON.stringify({ runID: "run-1", condition: "ship it", phase: "working", stopped: false, stopReason: "", controlRevision: 0, continues: 1, active: { promptID: "human" } })
    env.set.head("human")
    env.set.messages("s1", assistantText("[goal:evidence] untrusted\n[goal:complete]"))
    await env.boundary("s1")
    expect(env.clears).toHaveLength(0)
    expect(env.prompts).toHaveLength(0)
    expect(env.status("s1")).toMatchObject({ stopped: true, stopReason: "invalid-active-receipt" })
  })

  test("old projection cannot overwrite a paused replacement", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "old", "run-1")
    await env.boundary("s1")
    const paused = JSON.stringify({ runID: "run-2", condition: "new", phase: "paused", stopped: true, stopReason: "paused", controlRevision: 3, continues: 2, active: null })
    env.set.beforeUpdate(async () => { env.setGoal("s1", "new", "run-2"); env.metadata.s1["opencode.session.goal_status"] = paused })
    await expect(env.control("s1", { action: "pause" })).rejects.toThrow("CAS rejected")
    expect(env.metadata.s1["opencode.session.goal_status"]).toBe(paused)
    await env.reload()
    await env.boundary("s1")
    expect(env.prompts).toHaveLength(1)
  })

  test("an aborted queued control performs no projection or admission", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    env.set.head("human")
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    env.set.beforeRead(async () => { entered.resolve(); await gate.promise })
    const boundary = env.boundary("s1")
    await entered.promise
    const controller = new AbortController()
    const control = env.invoke({ sessionID: "s1", action: "resume" }, { sessionID: "s1", signal: controller.signal })
    controller.abort(new Error("cancelled"))
    gate.resolve()
    await boundary
    await expect(control).rejects.toThrow("cancelled")
    expect(env.status("s1")?.controlRevision).toBe(0)
  })
  test("pause invalidates a pre-admission await and prevents its prompt", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    env.set.head("human")
    env.set.beforeRead(async () => { entered.resolve(); await gate.promise })
    const boundary = env.boundary("s1")
    await entered.promise
    const pause = env.control("s1", { action: "pause", runID: "run-1", expectedRevision: 0 })
    gate.resolve()
    await Promise.all([boundary, pause])
    expect(env.prompts).toHaveLength(0)
    expect(env.status("s1")).toMatchObject({ stopped: true, controlRevision: 1 })
  })

  test("slash controls use the same serialized lifecycle as the service", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    await env.command("pause")
    expect(env.status("s1")).toMatchObject({ stopped: true, controlRevision: 1 })
    await env.command("resume")
    expect(env.status("s1")).toMatchObject({ stopped: false, controlRevision: 2 })
    expect(env.prompts).toHaveLength(1)
  })

  test("operation receipts evict the oldest entry after 128 operations", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    await env.control("s1", { action: "pause", expectedRevision: 0, operationID: "first" })
    for (let i = 0; i < 128; i++) await env.control("s1", { action: "pause", operationID: `receipt-${i}` })
    expect(await env.control("s1", { action: "pause", expectedRevision: 0, operationID: "first" })).toMatchObject({ ok: false, error: "revision" })
    expect(await env.control("s1", { action: "pause", expectedRevision: 0, operationID: "receipt-127" })).toMatchObject({ ok: true, controlRevision: 1 })
  })
  test("pause and resume serialize with controlRevision and bounded receipts", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    await env.boundary("s1")
    const paused = (await env.control("s1", { action: "pause", runID: "run-1", expectedRevision: 0 })) as Record<string, unknown>
    expect(paused).toMatchObject({ ok: true, runID: "run-1", controlRevision: 1 })
    expect(env.status("s1")).toMatchObject({ phase: "paused", stopped: true, controlRevision: 1 })
    const repeated = (await env.control("s1", { action: "pause", runID: "run-1", expectedRevision: 0 })) as Record<string, unknown>
    expect(repeated.controlRevision).toBe(1)
    expect(env.status("s1")?.controlRevision).toBe(1)
    const stale = (await env.control("s1", { action: "pause", runID: "run-1", expectedRevision: 0, operationID: "op-2" })) as Record<string, unknown>
    expect(stale).toMatchObject({ ok: false, error: "revision" })
    const resumed = (await env.control("s1", { action: "resume", runID: "run-1", operationID: "op-3" })) as Record<string, unknown>
    expect(resumed).toMatchObject({ ok: true, controlRevision: 2 })
    expect(env.policy()?.({ sessionID: "s1" })).toBe(true)
  })

  test("stale run and session mismatch are rejected", async () => {
    const env = await harness({ cooldownMs: 0 })
    env.setGoal("s1", "ship it", "run-1")
    await env.boundary("s1")
    const stale = (await env.control("s1", { action: "pause", runID: "other" })) as Record<string, unknown>
    expect(stale).toMatchObject({ ok: false, error: "stale-run" })
    const mismatch = (await env.control("s1", { action: "pause", runID: "run-1" }, "other-session")) as Record<string, unknown>
    expect(mismatch).toMatchObject({ ok: false, error: "session-mismatch" })
    const unknown = (await env.control("s404", { action: "pause" })) as Record<string, unknown>
    expect(unknown).toMatchObject({ ok: false, error: "no-active-goal" })
  })
})
