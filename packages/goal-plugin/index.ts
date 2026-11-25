/**
 * In-repo session goal plugin (replaces the external npm opencode-goal-plugin).
 *
 * Loop kernel: an `event` hook on the three turn boundaries re-syncs the goal
 * runtime from session metadata and continues the session through
 * `host.sessions.prompt` until the model reports `[goal:complete]` with a
 * `[goal:evidence]` line, or reports `[goal:blocked]`, or the hard
 * max-continuations cap pauses the run. The host atomically fences Goal
 * admission and status projection. The `opencode-goal-plugin/control` v1
 * service and goal_status display shape stay compatible with the app.
 */
export const id = "opencode-goal-plugin"

const GOAL_METADATA_KEY = "opencode.session.goal"
const GOAL_RUN_METADATA_KEY = "opencode.session.goal_run"
const GOAL_STATUS_METADATA_KEY = "opencode.session.goal_status"

const DEFAULT_MAX_CONTINUATIONS = 50
const COOLDOWN_MS = 1500

type GoalPhase = "working" | "verification-pending" | "verifying" | "paused" | "achieved"

type GoalRuntime = {
  condition: string
  runID: string
  phase: GoalPhase
  stopped: boolean
  stopReason: string
  controlRevision: number
  generation: number
  continues: number
  active: { promptID: string } | null
  deferred: { runID: string; headID: string } | null
  receipts: Map<string, ControlOutcome>
  lastBoundary: number
  statusVersion?: string
  allowTerminalHead: boolean
  pendingControl?: { operationID: string; action: "pause" | "resume"; candidate: GoalRuntime }
}

type ControlOutcome = {
  ok: boolean
  runID: string
  controlRevision: number
  status: Record<string, unknown> | null
  error?: string
}

type SessionMetadata = Record<string, unknown>

type PluginClient = {
  session: {
    get(args: { path: { id: string } }): Promise<unknown>
    update(args: { path: { id: string }; body: { metadataPatch: unknown } }): Promise<unknown>
    messages(args: { path: { id: string }; query?: Record<string, unknown> }): Promise<unknown>
  }
}

type PluginHost = {
  signal?: AbortSignal
  sessions: {
    prompt(args: {
      sessionID: string
      text: string
      expectedLatestInputID?: string | null
      goal?: { condition: string; runID: string; expectedStatus?: string; status: string }
    }): Promise<{ id: string; goalStatus?: string }>
    admissionHead(args: { sessionID: string }): Promise<{ id: string | null }>
    inputOrigin(args: { sessionID: string; inputID: string }): Promise<string>
    execution: {
      read(args: { sessionID: string; messageID: string }): Promise<{
        phase?: string
        activity?: { status?: string; closed_seq?: number }
        questions?: unknown[]
        laterInputs?: unknown[]
        laterAdmissions?: unknown[]
        assistants?: Array<{ id?: string; data?: unknown }>
      } | null>
    }
    goalOwnership: {
      register(policy: (input: { sessionID: string }) => boolean): Promise<void> | void
      clear(args: { sessionID: string; condition: string; runID: string }): Promise<void>
      project(args: { sessionID: string; condition: string; runID: string; expectedStatus?: string; status: string }): Promise<boolean>
    }
  }
}

type PluginInput = {
  client: PluginClient
  directory: string
  host: PluginHost
  services?: {
    register(definition: {
      id: string
      version: number
      input: ReturnType<typeof standardSchema>
      output: ReturnType<typeof standardSchema>
      execute(input: unknown, context: { sessionID?: string; signal: AbortSignal }): Promise<unknown>
      dispose?(): void
    }): unknown
  }
}

type PluginOptions = { maxContinuations?: number; cooldownMs?: number }

const clampCap = (value: unknown) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return DEFAULT_MAX_CONTINUATIONS
  return value
}

const clampCooldown = (value: unknown) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return COOLDOWN_MS
  return value
}

const controlIssues = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["control request must be an object"]
  const record = value as Record<string, unknown>
  const issues: string[] = []
  if (typeof record.sessionID !== "string" || !record.sessionID.trim()) issues.push("sessionID is required")
  if (record.action !== "pause" && record.action !== "resume") issues.push(`action must be "pause" or "resume"`)
  if (record.runID !== undefined && typeof record.runID !== "string") issues.push("runID must be a string")
  if (typeof record.operationID !== "string" || !record.operationID.trim()) issues.push("operationID is required")
  if (
    record.expectedRevision !== undefined &&
    (typeof record.expectedRevision !== "number" || !Number.isSafeInteger(record.expectedRevision) || record.expectedRevision < 0)
  )
    issues.push("expectedRevision must be a non-negative integer")
  return issues
}

const controlOutputIssues = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["control result must be an object"]
  const record = value as Record<string, unknown>
  const issues: string[] = []
  if (typeof record.ok !== "boolean") issues.push("ok must be a boolean")
  if (typeof record.runID !== "string") issues.push("runID must be a string")
  if (typeof record.controlRevision !== "number" || !Number.isSafeInteger(record.controlRevision) || record.controlRevision < 0)
    issues.push("controlRevision must be a non-negative integer")
  if (record.ok === false && typeof record.error !== "string") issues.push("error is required when ok is false")
  if (record.ok === true && record.status !== null && (!record.status || typeof record.status !== "object"))
    issues.push("status must be an object or null")
  return issues
}

const standardSchema = (validate: (value: unknown) => string[]) => ({
  "~standard": {
    version: 1 as const,
    vendor: "opencode-goal-plugin",
    validate: (value: unknown) => {
      const issues = validate(value)
      return issues.length ? { issues: issues.map((message) => ({ message })) } : { value }
    },
  },
})

const unwrap = (response: unknown) => {
  if (response && typeof response === "object" && "error" in response && response.error) throw new Error("Goal session transport failed")
  if (response && typeof response === "object" && "data" in response) return (response as { data?: unknown }).data
  return response
}

const metadataOf = (session: unknown): SessionMetadata => {
  if (!session || typeof session !== "object") return {}
  const metadata = (session as { metadata?: unknown }).metadata
  return metadata && typeof metadata === "object" ? (metadata as SessionMetadata) : {}
}

const statusOf = (rt: GoalRuntime) => ({
  runID: rt.runID,
  condition: rt.condition,
  phase: rt.phase,
  stopped: rt.stopped,
  stopReason: rt.stopReason,
  controlRevision: rt.controlRevision,
  continues: rt.continues,
  active: rt.active,
})

const markerScan = (text: string) => {
  const blockedAt = text.lastIndexOf("[goal:blocked]")
  const completeAt = text.lastIndexOf("[goal:complete]")
  if (completeAt >= 0 && completeAt >= blockedAt) {
    const before = text.slice(0, completeAt)
    const evidenceAt = before.lastIndexOf("[goal:evidence]")
    if (evidenceAt < 0) return { kind: "working" as const }
    const evidence = before
      .slice(evidenceAt + "[goal:evidence]".length, completeAt)
      .replace(/[\-*\s]/g, " ")
      .trim()
    if (!evidence) return { kind: "working" as const }
    return { kind: "achieved" as const, evidence }
  }
  if (blockedAt >= 0) {
    const before = text.slice(0, blockedAt).trimEnd()
    const blocker = before.split("\n").at(-1)?.trim() ?? ""
    if (!blocker) return { kind: "working" as const }
    return { kind: "blocked" as const, blocker }
  }
  return { kind: "working" as const }
}

const protocolLines = [
  "Keep working until the goal is fully satisfied.",
  `When fully satisfied, put a \`[goal:evidence]\` line summarizing what you verified immediately before \`[goal:complete]\`. A \`[goal:complete]\` without evidence is rejected.`,
  `If user input is required, explain the concrete blocker in the line immediately before \`[goal:blocked]\`. A \`[goal:blocked]\` without a concrete blocker is rejected.`,
]

export const GoalPlugin = async ({ client, host, services }: PluginInput, pluginOptions: PluginOptions = {}) => {
  const maxContinuations = clampCap(pluginOptions.maxContinuations)
  const cooldownMs = clampCooldown(pluginOptions.cooldownMs)
  const runtimes = new Map<string, GoalRuntime>()
  const chains = new Map<string, Promise<void>>()
  const lifetime = new AbortController()
  const signal = host.signal ? AbortSignal.any([host.signal, lifetime.signal]) : lifetime.signal
  const check = (controlSignal?: AbortSignal) => { signal.throwIfAborted(); controlSignal?.throwIfAborted() }

  const readGoalMetadata = async (sessionID: string) => {
    check()
    const session = unwrap(await client.session.get({ path: { id: sessionID } }))
    const metadata = metadataOf(session)
    const goal = metadata[GOAL_METADATA_KEY]
    const runID = metadata[GOAL_RUN_METADATA_KEY]
    if (typeof goal !== "string" || !goal.trim() || typeof runID !== "string" || !runID) return null
    const rawStatus = metadata[GOAL_STATUS_METADATA_KEY]
    let saved: Record<string, unknown> | null = null
    if (typeof rawStatus === "string" && rawStatus.length <= 65536) {
      try {
        const value: unknown = JSON.parse(rawStatus)
        if (value && typeof value === "object" && !Array.isArray(value)) saved = value as Record<string, unknown>
      } catch { /* Invalid display metadata is not lifecycle authority. */ }
    }
    const valid = saved?.runID === runID && saved.condition === goal && typeof saved.stopped === "boolean"
      && typeof saved.stopReason === "string" && ["working", "paused", "verification-pending", "verifying"].includes(String(saved.phase))
      && Number.isSafeInteger(saved.controlRevision) && Number(saved.controlRevision) >= 0
      && Number.isSafeInteger(saved.continues) && Number(saved.continues) >= 0
      && (saved.phase === "paused") === saved.stopped
      && (saved.active === null || (typeof saved.active === "object" && saved.active !== null
        && typeof (saved.active as { promptID?: unknown }).promptID === "string"
        && Boolean((saved.active as { promptID: string }).promptID.trim())))
    check()
    return { condition: goal, runID, saved: valid ? saved : null, invalid: rawStatus !== undefined && !valid, rawStatus: typeof rawStatus === "string" ? rawStatus : undefined }
  }

  const writeStatus = async (sessionID: string, rt: GoalRuntime, controlSignal?: AbortSignal) => {
    check(controlSignal)
    const status = JSON.stringify(statusOf(rt))
    const applied = await host.sessions.goalOwnership.project({ sessionID, condition: rt.condition, runID: rt.runID, expectedStatus: rt.statusVersion, status })
    check(controlSignal)
    if (!applied) {
      const current = await readGoalMetadata(sessionID)
      if (!current || current.runID !== rt.runID || current.condition !== rt.condition || current.rawStatus !== status)
        throw new Error("Goal status CAS rejected")
    }
    rt.statusVersion = status
  }

  const syncRuntime = (sessionID: string, goal: { condition: string; runID: string; saved?: Record<string, unknown> | null; invalid?: boolean; rawStatus?: string } | null) => {
    const existing = runtimes.get(sessionID)
    if (!goal) {
      runtimes.delete(sessionID)
      return null
    }
    if (existing && existing.runID === goal.runID) {
      existing.condition = goal.condition
      return existing
    }
    const fresh: GoalRuntime = {
      condition: goal.condition,
      runID: goal.runID,
      phase: goal.invalid || goal.saved?.stopped === true ? "paused" : "working",
      stopped: goal.invalid || goal.saved?.stopped === true,
      stopReason: goal.invalid ? "invalid-saved-status" : typeof goal.saved?.stopReason === "string" ? goal.saved.stopReason : "",
      controlRevision: typeof goal.saved?.controlRevision === "number" ? goal.saved.controlRevision : 0,
      generation: 0,
      continues: typeof goal.saved?.continues === "number" ? goal.saved.continues : 0,
      active: goal.saved?.active ? goal.saved.active as { promptID: string } : null,
      deferred: null,
      receipts: new Map(),
      lastBoundary: 0,
      statusVersion: goal.rawStatus,
      allowTerminalHead: false,
    }
    runtimes.set(sessionID, fresh)
    return fresh
  }

  const inputSettled = async (sessionID: string, inputID: string, allowTerminal = false) => {
    const view = await host.sessions.execution.read({ sessionID, messageID: inputID }).catch(() => null)
    if (!view) return false
    if (view.phase !== "activity" || !(view.activity?.status === "completed" || (allowTerminal && ["failed", "interrupted"].includes(view.activity?.status ?? ""))) || !Number.isFinite(view.activity?.closed_seq))
      return false
    if (view.questions?.length || view.laterInputs?.length || view.laterAdmissions?.length) return false
    return true
  }

  const settleActive = async (sessionID: string, rt: GoalRuntime) => {
    const claim = rt.active
    if (!claim) return
    const origin = await host.sessions.inputOrigin({ sessionID, inputID: claim.promptID }).catch(() => "unknown")
    if (origin !== "plugin") {
      rt.active = null
      rt.stopped = true
      rt.phase = "paused"
      rt.stopReason = "invalid-active-receipt"
      await writeStatus(sessionID, rt)
      return
    }
    const head = await host.sessions.admissionHead({ sessionID })
    if (head.id && head.id !== claim.promptID) {
      rt.active = null
      rt.deferred = { runID: rt.runID, headID: head.id }
      return
    }
    const view = await host.sessions.execution.read({ sessionID, messageID: claim.promptID }).catch(() => null)
    if (view?.phase === "activity" && ["failed", "interrupted"].includes(view.activity?.status ?? "")) {
      rt.active = null
      rt.stopped = true
      rt.phase = "paused"
      rt.stopReason = view.activity?.status === "interrupted" ? "interrupted" : "continuation-failed"
      await writeStatus(sessionID, rt)
      return
    }
    if (!view || view.phase !== "activity" || view.activity?.status !== "completed" || !Number.isFinite(view.activity?.closed_seq))
      return
    if (view.questions?.length || view.laterInputs?.length || view.laterAdmissions?.length) return
    if (rt.stopped) return
    const last = view.assistants?.at(-1)
    // Execution view binds the complete assistant sequence to this exact input.
    // Never borrow markers from a generic, possibly compacted history window.
    if (!last?.id) { rt.active = null; return }
    const unsafe = view.assistants?.some((assistant) => {
      const message = assistant.data as { error?: unknown; failure?: unknown; content?: Array<{ type?: string; state?: { status?: string } }> } | undefined
      return message?.error || message?.failure || message?.content?.some((part) => part.type === "tool" && part.state?.status !== "completed")
    })
    if (unsafe) {
      rt.active = null
      rt.phase = "paused"
      rt.stopped = true
      rt.stopReason = "continuation-failed"
      await writeStatus(sessionID, rt)
      return
    }
    const data = last.data as { content?: Array<{ type?: string; text?: string }> } | undefined
    const text = data?.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? ""
    const outcome = markerScan(text)
    if (outcome.kind === "achieved") {
      // Run-bound CAS clear: a replaced goal must never be cleared by the old run.
      await host.sessions.goalOwnership.clear({ sessionID, condition: rt.condition, runID: rt.runID })
      if (await readGoalMetadata(sessionID)) return
      rt.phase = "achieved"
      rt.stopped = true
      rt.stopReason = ""
      runtimes.delete(sessionID)
      return
    }
    if (outcome.kind === "blocked") {
      rt.phase = "paused"
      rt.stopped = true
      rt.stopReason = "blocked: " + outcome.blocker.slice(0, 200)
      await writeStatus(sessionID, rt)
    }
    rt.active = null
  }

  const launch = async (sessionID: string, rt: GoalRuntime, generation: number) => {
    if (generation !== rt.generation) return
    if (rt.continues >= maxContinuations) {
      rt.phase = "paused"
      rt.stopped = true
      rt.stopReason = "max-continuations"
      await writeStatus(sessionID, rt)
      return
    }
    const head = await host.sessions.admissionHead({ sessionID })
    if (head.id && !(await inputSettled(sessionID, head.id, rt.allowTerminalHead))) {
      rt.deferred = { runID: rt.runID, headID: head.id }
      return
    }
    const goal = await readGoalMetadata(sessionID)
    if (!goal || goal.runID !== rt.runID || goal.condition !== rt.condition || runtimes.get(sessionID) !== rt || rt.stopped) return
    rt.continues += 1
    rt.phase = "working"
    if (rt.generation !== generation || rt.stopped || runtimes.get(sessionID) !== rt) return
    check()
    const result = await host.sessions
      .prompt({
        sessionID,
        text: [
            `[goal] Continue working toward the session goal: "${rt.condition}"`,
            ...protocolLines,
            `Automatic continuations used: ${rt.continues}/${maxContinuations}.`,
          ].join("\n"),
        expectedLatestInputID: head?.id ?? null,
        goal: { condition: rt.condition, runID: rt.runID, expectedStatus: rt.statusVersion, status: JSON.stringify(statusOf(rt)) },
      })
      .then((admitted) => ({ kind: "admitted" as const, admitted }), (error: unknown) => ({ kind: "rejected" as const, error }))
    if (result.kind === "rejected") {
      if (result.error && typeof result.error === "object" && "_tag" in result.error && result.error._tag === "SessionBusyError") {
        // This typed refusal proves there was no admission. Preserve demand for
        // the newer input's real settlement boundary instead of pausing it.
        rt.continues -= 1
        const current = await readGoalMetadata(sessionID)
        if (!current || current.runID !== rt.runID || current.condition !== rt.condition) return
        const latest = await host.sessions.admissionHead({ sessionID })
        if (latest.id) rt.deferred = { runID: rt.runID, headID: latest.id }
        await writeStatus(sessionID, rt)
        return
      }
      // Ambiguous transport admission: pause instead of auto-duplicating (B5).
      rt.phase = "paused"
      rt.stopped = true
      rt.stopReason = "continuation-failed"
      await writeStatus(sessionID, rt)
      return
    }
    rt.active = { promptID: result.admitted.id }
    rt.statusVersion = result.admitted.goalStatus
    rt.allowTerminalHead = false
  }

  const admissionDecision = async (sessionID: string, rt: GoalRuntime): Promise<"launch" | "wait"> => {
    if (rt.deferred && rt.deferred.runID !== rt.runID) rt.deferred = null
    const head = await host.sessions.admissionHead({ sessionID })
    const headID = head?.id ?? null
    if (rt.deferred) {
      if (headID && (await inputSettled(sessionID, headID, rt.allowTerminalHead))) {
        rt.deferred = null
        return "launch"
      }
      if (headID) rt.deferred.headID = headID
      return "wait"
    }
    if (!headID) return "launch"
    const origin = await host.sessions.inputOrigin({ sessionID, inputID: headID }).catch(() => "unknown")
    if (await inputSettled(sessionID, headID, rt.allowTerminalHead)) return "launch"
    if (origin === "plugin") return "wait"
    // A newer human input takes priority: defer exactly one continuation for
    // this run; it re-drives only on a real boundary event.
    rt.deferred = { runID: rt.runID, headID }
    return "wait"
  }

  const runFor = <T>(sessionID: string, work: () => Promise<T>): Promise<T> => {
    const previous = chains.get(sessionID) ?? Promise.resolve()
    const next = previous.then(() => { check(); return work() })
    const tail = next.then(() => undefined, () => undefined)
    chains.set(sessionID, tail)
    void tail.then(() => { if (chains.get(sessionID) === tail) chains.delete(sessionID) })
    return next
  }

  const drive = async (sessionID: string, rt: GoalRuntime) => {
    const generation = rt.generation
    if (rt.active) await settleActive(sessionID, rt)
    if (runtimes.get(sessionID) !== rt) return
    if (rt.stopped) return
    if (rt.active) return // the in-flight continuation is still unsettled; its boundary will drive the next step
    const now = Date.now()
    // Retain this real boundary while cooling down; dropping it can lose the
    // only settlement wakeup. Re-read the durable inbox after the delay.
    if (now - rt.lastBoundary < cooldownMs) await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason) }
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve() }, cooldownMs - (now - rt.lastBoundary))
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
    })
    if (generation !== rt.generation || rt.stopped) return
    rt.lastBoundary = Date.now()
    const decision = await admissionDecision(sessionID, rt)
    if (decision === "launch") await launch(sessionID, rt, generation)
  }

  if (host?.sessions?.goalOwnership?.register) {
    await host.sessions.goalOwnership.register(({ sessionID }) => {
      const rt = runtimes.get(sessionID)
      return rt !== undefined && !rt.stopped
    })
  }

  const applyControl = async (input: {
    sessionID: string
    action: "pause" | "resume"
    operationID: string
    runID?: string
    expectedRevision?: number
  }, context: { sessionID?: string; signal?: AbortSignal }): Promise<ControlOutcome> => {
    check(context.signal)
    if (!context.sessionID || input.sessionID !== context.sessionID)
      return { ok: false, error: "session-mismatch", runID: "", controlRevision: 0, status: null }
    const rt = syncRuntime(input.sessionID, await readGoalMetadata(input.sessionID))
    check(context.signal)
    if (!rt) return { ok: false, error: "no-active-goal", runID: "", controlRevision: 0, status: null }
    if (input.runID && input.runID !== rt.runID)
      return { ok: false, error: "stale-run", runID: rt.runID, controlRevision: rt.controlRevision, status: statusOf(rt) }
    const known = rt.receipts.get(input.operationID)
    if (known) return known
    if (input.expectedRevision !== undefined && input.expectedRevision !== rt.controlRevision)
      return { ok: false, error: "revision", runID: rt.runID, controlRevision: rt.controlRevision, status: statusOf(rt) }
    if (rt.pendingControl && (rt.pendingControl.operationID !== input.operationID || rt.pendingControl.action !== input.action))
      return { ok: false, error: "persistence-pending", runID: rt.runID, controlRevision: rt.controlRevision, status: statusOf(rt) }
    const changed = input.action === "pause" ? !rt.stopped : rt.stopped
    const candidate = rt.pendingControl?.candidate ?? { ...rt, pendingControl: undefined,
      stopped: input.action === "pause", phase: input.action === "pause" ? "paused" as const : "working" as const,
      stopReason: input.action === "pause" ? "paused" : "", continues: input.action === "resume" && changed ? 0 : rt.continues,
      controlRevision: rt.controlRevision + (changed ? 1 : 0), generation: rt.generation + (changed ? 1 : 0),
      allowTerminalHead: input.action === "resume" && changed,
    }
    rt.pendingControl = { operationID: input.operationID, action: input.action, candidate }
    // Keep memory fail-closed until durable CAS confirms the whole transition.
    rt.stopped = true
    await writeStatus(input.sessionID, candidate, context.signal)
    Object.assign(rt, candidate, { pendingControl: undefined })
    if (input.action === "resume" && changed) {
      check(context.signal)
      await drive(input.sessionID, rt)
    }
    const outcome: ControlOutcome = { ok: true, runID: rt.runID, controlRevision: rt.controlRevision, status: statusOf(rt) }
    rt.receipts.set(input.operationID, outcome)
    if (rt.receipts.size > 128) rt.receipts.delete(rt.receipts.keys().next().value!)
    return outcome
  }
  const control = (input: {
    sessionID: string; action: "pause" | "resume"; operationID: string; runID?: string; expectedRevision?: number
  }, context: { sessionID?: string; signal?: AbortSignal }) => {
    check(context.signal)
    const rt = runtimes.get(input.sessionID)
    // A valid pause invalidates a currently awaiting pre-admission check before
    // entering the serialized lane. It cannot undo an already admitted input.
    if (input.action === "pause" && rt && context.sessionID === input.sessionID
      && (!input.runID || input.runID === rt.runID)
      && (input.expectedRevision === undefined || input.expectedRevision === rt.controlRevision)
      && !rt.receipts.has(input.operationID)) rt.generation += 1
    return runFor(input.sessionID, () => { check(context.signal); return applyControl(input, context) })
  }

  if (typeof services?.register === "function") services.register({
    id: "control",
    version: 1,
    input: standardSchema(controlIssues),
    output: standardSchema(controlOutputIssues),
    dispose: () => lifetime.abort(),
    execute: (input, context) =>
      control(
        input as { sessionID: string; action: "pause" | "resume"; operationID: string; runID?: string; expectedRevision?: number },
        context,
      ),
  })

  return {
    "command.execute.before": async (input: { command: string; sessionID: string; arguments: string }) => {
      const action = input.arguments.trim().toLowerCase()
      if (input.command !== "goal" || (action !== "pause" && action !== "resume")) return
      await control({
        sessionID: input.sessionID, action, operationID: crypto.randomUUID(),
      }, { sessionID: input.sessionID })
    },
    event: async ({ event }: { event?: { type?: string; properties?: Record<string, unknown> } }) => {
      const type = event?.type
      if (type !== "session.turn.completed" && type !== "session.idle" && type !== "session.runner.settled") return
      const properties = event?.properties
      const sessionID = typeof properties?.sessionID === "string"
        ? properties.sessionID
        : typeof (properties?.info as { sessionID?: unknown } | undefined)?.sessionID === "string"
          ? (properties?.info as { sessionID: string }).sessionID
          : null
      if (!sessionID) return
      await runFor(sessionID, async () => {
        const goal = await readGoalMetadata(sessionID)
        const rt = syncRuntime(sessionID, goal)
        if (!rt) return
        // Normalize invalid serialized display state through the same guarded
        // owner so the app can offer Continue without trusting corrupt counters.
        if (goal?.invalid && goal.rawStatus !== undefined && rt.stopReason === "invalid-saved-status")
          await writeStatus(sessionID, rt)
        await drive(sessionID, rt)
      })
    },

    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system?: unknown[] },
    ) => {
      if (!input.sessionID) return
      const rt = runtimes.get(input.sessionID) ?? syncRuntime(input.sessionID, await readGoalMetadata(input.sessionID))
      if (!rt || rt.stopped) return
      const blocks = Array.isArray(output.system) ? [...output.system] : []
      if (blocks.some((block) => typeof block === "string" && block.includes("[goal:complete]"))) return
      const remaining = Math.max(0, maxContinuations - rt.continues)
      const goalBlock = [
        `Session goal: "${rt.condition}"`,
        ...protocolLines,
        `Automatic continuations remaining in this run: ${remaining}/${maxContinuations}.`,
      ].join("\n")
      blocks.push(goalBlock)
      output.system = blocks
    },
  }
}

export default { id, server: GoalPlugin }
