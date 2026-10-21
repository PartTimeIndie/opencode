import { createScheduledAppRunner } from "./app-runner.js"
const ICON = new URL("./assets/scheduled-jobs-icon.svg", import.meta.url).href
const GENERATE_ICON = new URL("./assets/generate-cron-icon.svg", import.meta.url).href

const DEFAULT_SETTINGS = {
  autoOpen: false,
  refreshSeconds: 0,
}

const SCHEDULE_MODES = [
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "hourly", label: "Every N hours" },
  { value: "minutes", label: "Every N minutes" },
  { value: "custom", label: "Custom cron" },
]

const WEEKDAYS = [
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
  { value: "0", label: "Sunday" },
]

const HOUR_INTERVALS = ["1", "2", "3", "4", "6", "8", "12"].map((value) => ({ value, label: `${value} hours` }))
const MINUTE_INTERVALS = ["5", "10", "15", "30"].map((value) => ({ value, label: `${value} minutes` }))
const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }))
const TIMEOUT_OPTIONS = [
  { value: "", label: "No timeout" },
  { value: "60", label: "1 minute" },
  { value: "300", label: "5 minutes" },
  { value: "900", label: "15 minutes" },
  { value: "1800", label: "30 minutes" },
  { value: "3600", label: "1 hour" },
  { value: "16200", label: "4 hours 30 minutes" },
]
const JOB_TYPES = [
  { value: "llm", label: "LLM job" },
  { value: "powershell", label: "PowerShell command" },
  { value: "cmd", label: "CMD command" },
]
const RUN_TARGET_OPTIONS = [
  { value: "app", label: "App" },
  { value: "cli", label: "CLI" },
]
const APP_SESSION_OPTIONS = [
  { value: "new", label: "New session each run" },
  { value: "job", label: "Reusable job session" },
  { value: "current", label: "Current session" },
]
const THINKING_OPTIONS = [
  { value: "", label: "Default" },
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Xhigh" },
]
const PERMISSION_OPTIONS = [
  { value: "ask", label: "Ask for approval", description: "Deny non-interactive approval prompts." },
  { value: "approve_for_me", label: "Approve for me", description: "Use the configured safety reviewer for actions." },
  { value: "full_access", label: "Full access", description: "Allow OpenCode tool actions without approval prompts." },
]
// The model policy follows the user decision that every scheduled OpenCode run
// uses the Settings-configured model chain. Chain routing (including the
// dynamic "default" reference) is compliant; direct single-model runs always
// need an explicitly confirmed exception. No model is ever implied here.
const MODEL_POLICY_REASON_MIN_LENGTH = 8
const MODEL_POLICY_REASON_MAX_LENGTH = 500
const VERIFICATION_FIXTURE_ID = /^[a-f0-9]{32}$/
const VERIFICATION_SCOPE_ID = /^[a-z0-9][a-z0-9_-]{2,127}$/i
const VERIFICATION_PREFLIGHT_TOKEN = /^[a-z0-9][a-z0-9_-]{7,95}$/i
const VERIFICATION_JOB_SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/
const VERIFICATION_SOURCE = "scheduled-jobs-app-verification"
const VERIFICATION_OPERATIONS = ["create", "get", "logs", "outcome", "delete"]
const FIELD_HELP = {
  name: "Human-readable job name. Existing job names stay locked because Windows task names are derived from them.",
  description: "Optional plain-language explanation of what this job does. It is shown in the job list and details, but never changes what the job runs.",
  schedule: "Cron expression used by the scheduler. Presets update this automatically; Custom cron lets you edit it.",
  scheduleMode: "Preset for the recurrence pattern. It writes the cron expression below.",
  scheduleTime: "Local time for daily, weekday, weekly, and monthly runs.",
  scheduleWeekday: "Day of week for weekly runs.",
  scheduleMonthDay: "Day of month for monthly runs.",
  scheduleHourInterval: "Runs every selected number of hours at minute 00.",
  scheduleMinuteInterval: "Runs every selected number of minutes throughout each hour.",
  runOnce: "Run this job only once. After a successful run, the scheduler deletes the job automatically.",
  generatePrompt: "Describe the timing in natural language to generate a cron expression.",
  jobType: "Choose whether the job runs an OpenCode LLM prompt or a direct Windows shell command.",
  prompt: "Prompt submitted when the LLM job runs.",
  runTarget: "App opens OpenCode via deep link and submits the prompt. CLI runs opencode run in the background.",
  appSessionStrategy: "Choose whether each app run creates a new session, reuses this job's saved session, or targets the current session captured when this editor opens.",
  appResetHistory: "Replace the reusable job session with a fresh session before submitting the new prompt.",
  agent: "Agent to use for this LLM run. Blank uses the project default.",
  modelChain: "Settings model chain resolved and validated by the app at each execution. Direct keeps legacy single-model behavior.",
  model: "Model to use for this LLM run. New jobs run on the Settings default model chain; Direct routing requires an explicit model plus a confirmed model-policy exception.",
  variant: "Thinking or variant level passed to the model when supported. Direct model runs must state the thinking level explicitly.",
  modelPolicyExceptionConfirmed: "Required when this LLM job intentionally differs from the scheduled-job model policy.",
  modelPolicyExceptionReason: `Explain why this exact model and thinking combination is needed (${MODEL_POLICY_REASON_MIN_LENGTH}-${MODEL_POLICY_REASON_MAX_LENGTH} characters).`,
  accessControl: "Approval mode for CLI runs. App runs use normal app and session permissions.",
  workdirProject: "Project directory where the scheduled job runs.",
  workdir: "Custom project directory path for the scheduled job.",
  attachUrl: "Optional OpenCode attach URL passed to CLI runs.",
  runFormat: "Optional opencode run output format for CLI runs.",
  share: "Pass --share to CLI runs when set to Yes.",
  continue: "Pass --continue to CLI runs when set to Yes.",
  timeoutSeconds: "Maximum runtime before the scheduler stops the process.",
  shellCommand: "Command that Windows executes on the schedule. Generated commands are saved as direct shell jobs.",
}

export default {
  id: "scheduled-jobs-app",
  app(api) {
    const state = {
      settings: readSettings(api),
      jobs: [],
      options: {
        agents: [],
        models: [],
        projects: [],
        commands: [],
        loaded: false,
      },
      query: api.kv.get("query", ""),
      selected: api.kv.get("selected", ""),
      view: "overview",
      editor: undefined,
      confirmDelete: "",
      logs: {},
      busy: "",
      error: "",
      notice: "",
      runnerNotice: "",
      panels: new Set(),
      controls: [],
      renderQueued: false,
      skipEditorDraftSync: false,
      timer: undefined,
    }

    const runner = createScheduledAppRunner(api, (input) => schedulerRequest(api, input), (notice) => {
      state.notice = [notice.title, notice.description].filter(Boolean).join(": ")
      state.runnerNotice = state.notice
      renderAll(state)
    })
    api.host.navigation.registerHandoffHandler({ id: "run", handle: runner.handle })
    void runner.resume()

    api.settings.register({
      id: "scheduledJobsSettings",
      title: "Scheduled Jobs",
      sections: [
        {
          title: "General",
          fields: [
            {
              key: "autoOpen",
              type: "boolean",
              label: "Open on load",
              description: "Open the Scheduled Jobs dock item automatically when the plugin loads.",
              default: DEFAULT_SETTINGS.autoOpen,
            },
            {
              key: "refreshSeconds",
              type: "number",
              label: "Refresh seconds",
              description: "Optional background refresh interval. Set 0 to refresh only after actions or when pressing Refresh.",
              min: 0,
              max: 300,
              default: DEFAULT_SETTINGS.refreshSeconds,
            },
          ],
        },
      ],
    })

    api.settings.subscribe((settings) => {
      state.settings = normalizeSettings(settings)
      resetTimer(api, state)
      renderAll(state)
    })

    api.commands.register({
      id: "scheduledJobs.open",
      title: "Open Scheduled Jobs",
      run() {
        api.dock.open.item("scheduledJobs", { area: "left" })
      },
    })

    api.automation.register({
      id: "verificationFixture",
      title: "Scheduled job verification fixture",
      description: "Creates and inspects one isolated real-schedule app fixture without exposing general scheduler or shell access.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          operation: { type: "string", enum: VERIFICATION_OPERATIONS },
          fixtureId: { type: "string", pattern: VERIFICATION_FIXTURE_ID.source },
          expectedScopeId: { type: "string", pattern: VERIFICATION_SCOPE_ID.source },
          workdir: { type: "string" },
          schedule: { type: "string", description: "One exact local minute/hour/day/month cron with wildcard weekday." },
          prompt: { type: "string" },
          model: { type: "string", description: "Explicit provider/model used by the isolated app run." },
          preflightToken: { type: "string", pattern: VERIFICATION_PREFLIGHT_TOKEN.source },
          timeoutSeconds: { type: "number", minimum: 60, maximum: 3600 },
          lines: { type: "number", minimum: 1, maximum: 200 },
          runId: { type: "string", pattern: "^[a-f0-9]{32}$" },
        },
        required: ["operation", "fixtureId", "expectedScopeId", "workdir"],
      },
      run(input) {
        return runSchedulerVerificationFixture(api, input)
      },
    })

    const dockState = api.dock.state.item("scheduledJobs")
    api.dock.register({
      id: "scheduledJobs",
      title: "Scheduled Jobs",
      icon: ICON,
      defaultArea: "left",
      minWidth: 300,
      minHeight: 260,
      preferredWidth: 440,
      preferredHeight: 520,
      mount(context) {
        return mountScheduledJobs(api, state, context)
      },
    })

    if (state.settings.autoOpen || !dockState.area)
      api.dock.open.item("scheduledJobs", { area: "left", reveal: false })

    api.lifecycle.onDispose(() => {
      clearInterval(state.timer)
    })
  },
}

function readSettings(api) {
  return normalizeSettings({
    autoOpen: api.settings.get("autoOpen", DEFAULT_SETTINGS.autoOpen),
    refreshSeconds: api.settings.get("refreshSeconds", DEFAULT_SETTINGS.refreshSeconds),
  })
}

function normalizeSettings(settings) {
  const refreshSeconds = Number(settings.refreshSeconds)
  const normalizedRefreshSeconds = Number.isFinite(refreshSeconds) ? Math.max(0, Math.min(300, Math.floor(refreshSeconds))) : DEFAULT_SETTINGS.refreshSeconds
  return {
    autoOpen: settings.autoOpen !== false,
    refreshSeconds: normalizedRefreshSeconds === 20 ? DEFAULT_SETTINGS.refreshSeconds : normalizedRefreshSeconds,
  }
}

function mountScheduledJobs(api, state, context) {
  const root = document.createElement("section")
  root.className = "oc-scheduled-jobs"
  const style = styleNode()
  const view = document.createElement("div")
  view.className = "oc-scheduled-jobs__view"
  root.append(style, view)
  context.element.replaceChildren(root)

  const render = () => scheduleRender(state, () => renderPanel(api, state, view))
  state.panels.add(render)

  const abort = () => {
    syncEditorDraftFromView(state, view)
    state.panels.delete(render)
    context.element.replaceChildren()
    unsubscribeProjects()
    if (state.panels.size === 0) clearInterval(state.timer)
  }
  const unsubscribeProjects = api.host.projects.subscribe((projects) => {
    state.options = { ...state.options, projects: normalizeProjects(projects) }
    renderAll(state)
  })
  context.signal.addEventListener("abort", abort, { once: true })

  render()
  void refreshJobs(api, state, { preserveNotice: true })
  resetTimer(api, state)
  return abort
}

function resetTimer(api, state) {
  clearInterval(state.timer)
  state.timer = undefined
  if (!state.panels.size || state.settings.refreshSeconds <= 0) return
  state.timer = setInterval(() => {
    if (!state.busy && !state.editor) void refreshJobs(api, state, { quiet: true })
  }, state.settings.refreshSeconds * 1000)
}

function scheduleRender(state, render) {
  if (state.renderQueued) return
  state.renderQueued = true
  queueMicrotask(() => {
    state.renderQueued = false
    render()
  })
}

function renderAll(state) {
  for (const render of state.panels) render()
}

async function refreshJobs(api, state, options = {}) {
  if (state.busy === "refresh") {
    renderAll(state)
    return
  }
  const previousSnapshot = options.quiet ? jobsSnapshot(state) : ""
  const previousSelected = state.selected
  const previousNotice = state.notice
  const previousError = state.error
  if (!options.quiet) state.busy = "refresh"
  state.error = ""
  if (!options.quiet) renderAll(state)
  try {
    const result = await schedulerRequest(api, {
      path: "/scheduler/jobs",
      query: { allScopes: true, includeLegacy: true },
    })
    state.jobs = normalizeJobs(result.data?.jobs ?? [])
    if (state.selected && !state.jobs.some((job) => jobKey(job) === state.selected)) {
      state.selected = ""
      if (state.view === "logs") state.view = "overview"
    }
    if (!state.selected && state.jobs[0]) state.selected = jobKey(state.jobs[0])
    state.notice = ((options.preserveNotice || options.quiet) && previousNotice === state.runnerNotice ? previousNotice : "") || result.output || ""
  } catch (error) {
    state.error = errorMessage(error)
  } finally {
    if (!options.quiet) {
      state.busy = ""
      renderAll(state)
      return
    }
    if (previousSnapshot !== jobsSnapshot(state) || previousSelected !== state.selected || previousNotice !== state.notice || previousError !== state.error) renderAll(state)
  }
}

function jobsSnapshot(state) {
  return JSON.stringify(state.jobs)
}

async function refreshOptions(api, state) {
  const current = api.host.navigation.current()
  const query = current.directory ? { directory: current.directory } : undefined
  state.options = { ...state.options, projects: normalizeProjects(api.host.projects.list()) }
  renderAll(state)
  const [agents, providers, commands] = await Promise.all([
    optionalRequest(api, { path: "/agent", query }),
    optionalRequest(api, { path: "/provider", query }),
    optionalRequest(api, { path: "/command", query }),
  ])
  state.options = {
    agents: normalizeAgents(agents),
    models: normalizeModels(providers),
    projects: normalizeProjects(api.host.projects.list()),
    commands: normalizeCommands(commands),
    loaded: true,
  }
  renderAll(state)
}

async function optionalRequest(api, input) {
  try {
    return await schedulerRequest(api, input)
  } catch {
    return undefined
  }
}

async function schedulerRequest(api, input) {
  const response = await schedulerResponse(api, input)
  const body = response.body
  if (response.status >= 400) throw Object.assign(new Error(resultText(body) || `Scheduler error ${response.status}`), { status: response.status })
  if (body && body.success === false) throw new Error(resultText(body) || "Scheduler action failed")
  return body || {}
}

async function schedulerResponse(api, input) {
  if (!input.path.startsWith("/scheduler/")) return api.host.http.request({ ...input, signal: input.signal ?? api.lifecycle.signal })
  if (!api.services?.call) throw new Error("The installed OpenCode build does not support plugin services.")
  const result = await api.services.call({ pluginID: "opencode-scheduler", serviceID: "jobs", version: 1,
    input: { ...input, method: input.method ?? "GET" }, directory: input.directory,
  })
  if (!result.ok) throw new Error(`Scheduler backend unavailable: ${result.error}`)
  return result.data
}

export async function runSchedulerVerificationFixture(api, input) {
  const options = verificationFixtureInput(input)
  const exact = verificationFixtureGetRequest(options)
  if (options.operation === "create") {
    await requireMissingVerificationFixture(api, exact)
    const result = await schedulerRequest(api, {
      path: "/scheduler/jobs",
      method: "POST",
      body: {
        name: verificationFixtureName(options.fixtureId),
        description: verificationFixtureDescription(options.fixtureId),
        source: VERIFICATION_SOURCE,
        schedule: options.schedule,
        workdir: options.workdir,
        runOnce: false,
        timeoutSeconds: options.timeoutSeconds,
        prompt: options.prompt,
        runTarget: "app",
        appSessionStrategy: "new",
        accessControl: { mode: "ask" },
        ...(options.model
          ? {
              model: options.model,
              variant: options.variant,
              modelPolicyException: {
                model: options.model,
                variant: options.variant,
                reason: "Isolated scheduler verification explicitly requested this direct model.",
              },
            }
          : { modelChain: "default" }),
        preflight: verificationFixturePreflight(options.preflightToken),
      },
    }).catch((error) => rollbackFailedVerificationFixture(api, undefined, options, error))
    try {
      return verificationFixtureResult(
        options,
        "job",
        requireVerificationFixtureJob(result, options, options.preflightToken),
      )
    } catch (error) {
      return rollbackFailedVerificationFixture(api, result, options, error)
    }
  }

  const job = requireVerificationFixtureJob(await schedulerRequest(api, exact), options)
  if (options.operation === "get") return verificationFixtureResult(options, "job", job)
  if (options.operation === "logs") {
    const result = await schedulerRequest(api, {
      path: `${exact.path}/logs`,
      query: { ...exact.query, lines: options.lines },
    })
    return verificationFixtureResult(options, "logs", result.data?.logs || result.output || "")
  }
  if (options.operation === "outcome") {
    if (job.lastRunRunId !== options.runId) {
      throw new Error(`Verification fixture run ${options.runId} is not the fixture's current run.`)
    }
    const result = await schedulerRequest(api, {
      path: `${exact.path}/outcome`,
      query: { ...exact.query, runId: options.runId },
      directory: options.workdir,
    })
    return verificationFixtureResult(options, "outcome", result.data)
  }

  await schedulerRequest(api, {
    path: exact.path,
    method: "DELETE",
    query: exact.query,
  })
  await requireMissingVerificationFixture(api, exact)
  return verificationFixtureResult(options, "deleted", true)
}

export function verificationFixtureInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Scheduled verification fixture input must be an object.")
  }
  const operation = typeof input.operation === "string" ? input.operation : ""
  if (!VERIFICATION_OPERATIONS.includes(operation)) {
    throw new Error(`Scheduled verification fixture operation must be one of: ${VERIFICATION_OPERATIONS.join(", ")}.`)
  }
  const allowed = new Set([
    "operation",
    "fixtureId",
    "expectedScopeId",
    "workdir",
    ...(operation === "create" ? ["schedule", "prompt", "model", "variant", "preflightToken", "timeoutSeconds"] : []),
    ...(operation === "logs" ? ["lines"] : []),
    ...(operation === "outcome" ? ["runId"] : []),
  ])
  const unknown = Object.keys(input).find((key) => !allowed.has(key))
  if (unknown) throw new Error(`Scheduled verification fixture does not allow "${unknown}" for ${operation}.`)

  const fixtureId = verificationString(input, "fixtureId", 32)
  if (!VERIFICATION_FIXTURE_ID.test(fixtureId)) {
    throw new Error("Scheduled verification fixtureId must be exactly 32 lowercase hexadecimal characters.")
  }
  const expectedScopeId = verificationString(input, "expectedScopeId", 128)
  if (!VERIFICATION_SCOPE_ID.test(expectedScopeId)) {
    throw new Error("Scheduled verification expectedScopeId contains unsupported characters.")
  }
  const workdir = verificationWorkdir(input.workdir)
  if (operation === "create") {
    const preflightToken = verificationString(input, "preflightToken", 96)
    if (!VERIFICATION_PREFLIGHT_TOKEN.test(preflightToken)) {
      throw new Error("Scheduled verification preflightToken must contain 8-96 letters, numbers, underscores, or dashes.")
    }
    const model = verificationModel(input.model)
    const variant = verificationVariant(input.variant)
    // Direct-model fixtures must state the thinking level explicitly; the
    // chain-based fixture path never implies one.
    if (model !== undefined && variant === undefined) {
      throw new Error("Scheduled verification fixture requires an explicit variant when model is set.")
    }
    return {
      operation,
      fixtureId,
      expectedScopeId,
      workdir,
      schedule: verificationSchedule(input.schedule),
      prompt: verificationPrompt(input.prompt),
      model,
      variant,
      preflightToken,
      timeoutSeconds: verificationInteger(input.timeoutSeconds, 60, 3600, 900, "timeoutSeconds"),
    }
  }
  if (operation === "logs") {
    return {
      operation,
      fixtureId,
      expectedScopeId,
      workdir,
      lines: verificationInteger(input.lines, 1, 200, 200, "lines"),
    }
  }
  if (operation === "outcome") {
    const runId = verificationString(input, "runId", 32)
    if (!VERIFICATION_FIXTURE_ID.test(runId)) {
      throw new Error("Scheduled verification runId must be exactly 32 lowercase hexadecimal characters.")
    }
    return { operation, fixtureId, expectedScopeId, workdir, runId }
  }
  return { operation, fixtureId, expectedScopeId, workdir }
}

function verificationString(input, key, max) {
  const value = input[key]
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Scheduled verification ${key} must be a non-empty string of at most ${max} characters.`)
  }
  return value.trim()
}

function verificationWorkdir(value) {
  const input = verificationString({ workdir: value }, "workdir", 520)
  if (!/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(input)) {
    throw new Error("Scheduled verification workdir must be an absolute Windows path.")
  }
  if (input.split(/[\\/]/).includes("..")) {
    throw new Error("Scheduled verification workdir must not contain parent-directory segments.")
  }
  return input
}

function verificationPrompt(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 200_000 ||
    /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new Error("Scheduled verification prompt must be non-empty, valid text of at most 200000 characters.")
  }
  return value.trim()
}

function verificationModel(value) {
  if (value === undefined) return undefined
  const model = verificationString({ model: value }, "model", 256)
  const separator = model.indexOf("/")
  if (separator < 1 || separator === model.length - 1) {
    throw new Error("Scheduled verification model must use provider/model format.")
  }
  return model
}

function verificationVariant(value) {
  if (value === undefined) return undefined
  return verificationString({ variant: value }, "variant", 32)
}

function verificationSchedule(value) {
  const schedule = verificationString({ schedule: value }, "schedule", 32)
  const parts = schedule.match(/^(\d{1,2}) (\d{1,2}) (\d{1,2}) (\d{1,2}) \*$/)
  if (
    !parts ||
    Number(parts[1]) > 59 ||
    Number(parts[2]) > 23 ||
    Number(parts[3]) < 1 ||
    Number(parts[3]) > 31 ||
    Number(parts[4]) < 1 ||
    Number(parts[4]) > 12
  ) {
    throw new Error("Scheduled verification schedule must be an exact minute hour day month * cron.")
  }
  return schedule
}

function verificationInteger(value, min, max, fallback, key) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Scheduled verification ${key} must be an integer from ${min} through ${max}.`)
  }
  return value
}

function verificationFixtureName(fixtureId) {
  return `Scheduler verification ${fixtureId}`
}

function verificationFixtureSlug(fixtureId) {
  return `${VERIFICATION_SOURCE}-scheduler-verification-${fixtureId}`
}

function verificationFixtureDescription(fixtureId) {
  return `Isolated scheduled app verification fixture ${fixtureId}.`
}

function verificationFixturePreflight(token) {
  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", `Write-Output '${token}'`],
    timeoutSeconds: 30,
  }
}

function verificationFixtureGetRequest(options) {
  return {
    path: `/scheduler/jobs/${verificationFixtureSlug(options.fixtureId)}`,
    query: { workdir: options.workdir, scopeId: options.expectedScopeId },
  }
}

async function requireMissingVerificationFixture(api, request) {
  const response = await schedulerResponse(api, request)
  if (response.status === 404) return
  const body = response.body ?? parseJson(response.text)
  if (response.status >= 400) throw Object.assign(new Error(resultText(body) || `Scheduler error ${response.status}`), { status: response.status })
  throw new Error("Scheduled verification fixture already exists or was not deleted.")
}

async function rollbackVerificationFixture(api, result, options) {
  const rollback = verificationFixtureRollbackTargets(result, options)
  const failures = [...rollback.failures]
  for (const target of rollback.targets) {
    await rollbackVerificationFixtureTarget(api, target, options).catch((error) => {
      failures.push(error instanceof Error ? error.message : String(error))
    })
  }
  if (failures.length) throw new Error(failures.join(" "))
}

async function rollbackVerificationFixtureTarget(api, target, options) {
  const request = {
    path: `/scheduler/jobs/${target.slug}`,
    query: { workdir: options.workdir, scopeId: target.scopeId },
  }
  const response = await schedulerResponse(api, request)
  if (response.status === 404) return
  const current = response.body ?? parseJson(response.text)
  if (response.status >= 400) throw new Error(resultText(current) || `Scheduler error ${response.status}`)
  const job = current?.data?.job
  if (
    !job ||
    typeof job !== "object" ||
    job.slug !== target.slug ||
    job.scopeId !== target.scopeId ||
    !sameWindowsPath(job.workdir, options.workdir) ||
    (target.requirePreflightToken && !verificationFixturePreflightTokenMatches(job, options.preflightToken))
  ) {
    throw new Error("Rollback target did not match the fixture that was just created.")
  }
  await schedulerRequest(api, { ...request, method: "DELETE" })
  await requireMissingVerificationFixture(api, request)
}

async function rollbackFailedVerificationFixture(api, result, options, error) {
  const message = error instanceof Error ? error.message : String(error)
  try {
    await rollbackVerificationFixture(api, result, options)
  } catch (rollbackError) {
    const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
    throw new Error(`${message} Automatic rollback failed: ${rollbackMessage}`, { cause: rollbackError })
  }
  throw new Error(`${message} The created fixture was rolled back and exact absence was verified.`)
}

function verificationFixtureRollbackTargets(result, options) {
  const expected = {
    slug: verificationFixtureSlug(options.fixtureId),
    scopeId: options.expectedScopeId,
    requirePreflightToken: false,
  }
  const created = result?.data?.job
  if (!created || typeof created !== "object") return { targets: [expected], failures: [] }
  if (
    created.slug === expected.slug &&
    created.scopeId === expected.scopeId &&
    sameWindowsPath(created.workdir, options.workdir)
  ) {
    return { targets: [expected], failures: [] }
  }
  if (
    typeof created.slug !== "string" ||
    !VERIFICATION_JOB_SLUG.test(created.slug) ||
    created.slug.includes("..") ||
    typeof created.scopeId !== "string" ||
    !VERIFICATION_SCOPE_ID.test(created.scopeId) ||
    !sameWindowsPath(created.workdir, options.workdir) ||
    !verificationFixturePreflightTokenMatches(created, options.preflightToken)
  ) {
    return {
      targets: [expected],
      failures: ["Create response did not safely identify an exact rollback target."],
    }
  }
  return {
    targets: [
      {
        slug: created.slug,
        scopeId: created.scopeId,
        requirePreflightToken: true,
      },
      expected,
    ],
    failures: [],
  }
}

function verificationFixturePreflightTokenMatches(job, token) {
  const preflight = job?.run?.preflight
  return (
    typeof token === "string" &&
    preflight?.command === "powershell.exe" &&
    Array.isArray(preflight.args) &&
    preflight.args.length === 4 &&
    preflight.args[0] === "-NoProfile" &&
    preflight.args[1] === "-NonInteractive" &&
    preflight.args[2] === "-Command" &&
    preflight.args[3] === `Write-Output '${token}'`
  )
}

function requireVerificationFixtureJob(result, options, preflightToken) {
  const job = result?.data?.job
  const run = job?.run
  const preflight = run?.preflight
  const expectedCommand = typeof preflightToken === "string" ? `Write-Output '${preflightToken}'` : undefined
  if (
    !job ||
    typeof job !== "object" ||
    job.name !== verificationFixtureName(options.fixtureId) ||
    job.slug !== verificationFixtureSlug(options.fixtureId) ||
    job.scopeId !== options.expectedScopeId ||
    !sameWindowsPath(job.workdir, options.workdir) ||
    job.description !== verificationFixtureDescription(options.fixtureId) ||
    job.runOnce === true ||
    (expectedCommand && job.source !== VERIFICATION_SOURCE) ||
    (expectedCommand && job.schedule !== options.schedule) ||
    (expectedCommand && job.prompt !== options.prompt) ||
    (expectedCommand && job.timeoutSeconds !== options.timeoutSeconds) ||
    !run ||
    typeof run !== "object" ||
    run.runTarget !== "app" ||
    run.appSessionStrategy !== "new" ||
    run.accessControl?.mode !== "ask" ||
    (expectedCommand && run.prompt !== options.prompt) ||
    (expectedCommand && options.model && run.model !== options.model) ||
    preflight?.command !== "powershell.exe" ||
    !Array.isArray(preflight.args) ||
    preflight.args.length !== 4 ||
    preflight.args[0] !== "-NoProfile" ||
    preflight.args[1] !== "-NonInteractive" ||
    preflight.args[2] !== "-Command" ||
    preflight.timeoutSeconds !== 30 ||
    (expectedCommand ? preflight.args[3] !== expectedCommand : !/^Write-Output '[a-z0-9][a-z0-9_-]{7,95}'$/i.test(preflight.args[3]))
  ) {
    throw new Error("Scheduled verification fixture identity did not match the isolated app-job contract.")
  }
  return job
}

function sameWindowsPath(left, right) {
  const normalize = (value) => String(value || "").replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
  return normalize(left) === normalize(right)
}

function verificationFixtureResult(options, key, value) {
  return {
    ok: true,
    operation: options.operation,
    fixtureId: options.fixtureId,
    slug: verificationFixtureSlug(options.fixtureId),
    expectedScopeId: options.expectedScopeId,
    workdir: options.workdir,
    [key]: value,
  }
}

function parseJson(text) {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function normalizeJobs(input) {
  return Array.isArray(input)
    ? input
        .filter((job) => job && typeof job === "object")
        .map((job) => ({
          ...job,
          name: typeof job.name === "string" && job.name.trim() ? job.name : job.slug || "Untitled job",
          slug: typeof job.slug === "string" ? job.slug : slugify(job.name || "job"),
          schedule: typeof job.schedule === "string" ? job.schedule : "",
          workdir: typeof job.workdir === "string" ? job.workdir : "",
          description: typeof job.description === "string" ? job.description : "",
          prompt: typeof job.prompt === "string" ? job.prompt : job.run?.prompt || "",
          run: job.run && typeof job.run === "object" ? job.run : {},
        }))
    : []
}

function renderPanel(api, state, view) {
  if (state.skipEditorDraftSync) state.skipEditorDraftSync = false
  else syncEditorDraftFromView(state, view)
  disposeControls(state)
  const scrollState = scheduledJobsScrollState(view)
  const shell = div("oc-scheduled-jobs__shell")
  if (state.view === "overview") shell.append(renderHeader(api, state))
  shell.append(renderStatus(state))

  const body = div("oc-scheduled-jobs__body")
  if (state.view === "overview") body.append(renderJobConfig(api, state))
  if (state.view === "logs") body.append(renderDetails(api, state))
  if (state.view === "edit") body.append(renderEditor(api, state))
  shell.append(body)

  const active = document.activeElement
  const focusTarget = active instanceof HTMLElement && view.contains(active) ? active.closest("[data-focus-key]") : undefined
  const focused = active instanceof HTMLElement && (active.matches("input, textarea, .oc-scheduled-jobs__select-trigger") || focusTarget?.classList.contains("oc-scheduled-jobs__model-picker"))
  const focusName = focused ? focusTarget?.getAttribute("data-focus-key") : undefined
  const selectionStart = focused && canRestoreSelection(active) ? active.selectionStart : undefined
  const selectionEnd = focused && canRestoreSelection(active) ? active.selectionEnd : undefined
  view.querySelectorAll(".oc-scheduled-jobs__select.is-open").forEach((node) => node.dispatchEvent(new CustomEvent("oc-scheduled-jobs-close-select")))
  view.replaceChildren(shell)
  restoreScheduledJobsScroll(view, scrollState)
  if (focusName) {
    const next = view.querySelector(`[data-focus-key="${focusName}"]`)
    const focusable = next?.matches("button, input, textarea, [tabindex]") ? next : next?.querySelector("button, input, textarea, [tabindex]")
    focusable?.focus({ preventScroll: true })
    if (next && selectionStart !== undefined && selectionEnd !== undefined && canRestoreSelection(next)) next.setSelectionRange(selectionStart, selectionEnd)
  }
}

function scheduledJobsScrollState(view) {
  return {
    body: view.querySelector(".oc-scheduled-jobs__body")?.scrollTop ?? 0,
    tree: view.querySelector(".oc-scheduled-jobs__tree")?.scrollTop ?? 0,
    detail: view.querySelector(".oc-scheduled-jobs__detail")?.scrollTop ?? 0,
  }
}

function restoreScheduledJobsScroll(view, scrollState) {
  view.querySelector(".oc-scheduled-jobs__body")?.scrollTo({ top: scrollState.body })
  view.querySelector(".oc-scheduled-jobs__tree")?.scrollTo({ top: scrollState.tree })
  view.querySelector(".oc-scheduled-jobs__detail")?.scrollTo({ top: scrollState.detail })
}

function canRestoreSelection(node) {
  return node instanceof HTMLTextAreaElement || (node instanceof HTMLInputElement && ["text", "search", "tel", "url", "password"].includes(node.type))
}

function syncEditorDraftFromView(state, view) {
  const draft = state.editor?.draft
  if (!draft) return
  view.querySelectorAll("input[data-focus-key], textarea[data-focus-key]").forEach((node) => {
    const key = node.getAttribute("data-focus-key")
    if (!key || !Object.prototype.hasOwnProperty.call(draft, key)) return
    if (node instanceof HTMLInputElement && node.type === "checkbox") {
      draft[key] = String(node.checked)
      return
    }
    if (node.readOnly) return
    draft[key] = node.value
  })
}

function disposeControls(state) {
  for (const dispose of state.controls) dispose()
  state.controls = []
}

function renderHeader(api, state) {
  const header = div("oc-scheduled-jobs__header")
  const title = div("oc-scheduled-jobs__title")
  const img = document.createElement("img")
  img.src = ICON
  img.alt = ""
  title.append(img, text("span", "Scheduled Jobs"))
  header.append(title)

  const actions = div("oc-scheduled-jobs__actions")
  actions.append(
    button("Refresh", "secondary", () => {
      void refreshJobs(api, state)
      void refreshOptions(api, state)
    }),
    button("New", "primary", () => {
      state.editor = { mode: "new", draft: draftFromJob(undefined, api) }
      state.view = "edit"
      state.confirmDelete = ""
      void refreshOptions(api, state)
      renderAll(state)
    }),
  )
  header.append(actions)

  const search = document.createElement("input")
  search.type = "search"
  search.placeholder = "Search jobs"
  search.value = state.query
  search.setAttribute("data-focus-key", "search")
  search.addEventListener("input", () => {
    state.query = search.value
    api.kv.set("query", state.query)
    renderAll(state)
  })
  header.append(search)
  return header
}

function renderStatus(state) {
  const status = div("oc-scheduled-jobs__status")
  if (state.busy) status.append(text("span", state.busy === "refresh" ? "Refreshing..." : state.busy))
  if (state.error) status.append(text("span", state.error, "error"))
  if (!state.busy && !state.error && state.notice) status.append(text("span", compactNotice(state.notice)))
  if (!state.busy && !state.error && !state.notice) status.append(text("span", `${state.jobs.length} jobs`))
  return status
}

function renderJobConfig(api, state) {
  const config = div("oc-scheduled-jobs__config")
  const selected = selectedJob(state)
  if (selected) config.append(renderJobSummary(selected))
  const actions = div("oc-scheduled-jobs__config-actions")
  if (selected) {
    actions.append(
      button("Run", "primary", () => void runJob(api, state, selected)),
      button("Logs", "secondary", () => {
        state.view = "logs"
        void loadLogs(api, state, selected)
      }),
      button("Edit", "secondary", () => {
        openEditor(api, state, selected)
      }),
      button("Delete", "danger", () => {
        state.confirmDelete = jobKey(selected)
        renderAll(state)
      }),
    )
  } else {
    actions.append(text("span", "Select a scheduled job."))
  }
  config.append(actions)
  if (selected && state.confirmDelete === jobKey(selected)) {
    const danger = div("oc-scheduled-jobs__danger")
    danger.append(
      text("span", `Delete ${selected.name}?`),
      button("Cancel", "secondary", () => {
        state.confirmDelete = ""
        renderAll(state)
      }),
      button("Delete", "danger", () => void deleteJob(api, state, selected)),
    )
    config.append(danger)
  }
  config.append(renderJobTree(api, state))
  return config
}

function renderJobTree(api, state) {
  const wrap = div("oc-scheduled-jobs__tree")
  const filtered = filteredJobs(state)
  if (!filtered.length) {
    wrap.append(emptyState(state.query ? "No jobs match the current search." : "No scheduled jobs yet."))
    return wrap
  }

  const groups = [
    ["Running", filtered.filter((job) => jobDisplayStatus(job) === "running")],
    ["Failed", filtered.filter((job) => jobDisplayStatus(job) === "failed")],
    ["Stopped", filtered.filter((job) => jobDisplayStatus(job) === "stopped")],
    ["Scheduled", filtered.filter((job) => !["running", "failed", "stopped"].includes(jobDisplayStatus(job)))],
  ].filter((group) => group[1].length)

  for (const [label, jobs] of groups) {
    const group = div("oc-scheduled-jobs__group")
    group.append(text("div", `${label} (${jobs.length})`, "oc-scheduled-jobs__group-title"))
    for (const job of jobs) group.append(renderJobRow(api, state, job))
    wrap.append(group)
  }
  return wrap
}

function jobDisplayStatus(job) {
  if (
    job.lastRunStatus === "failed" &&
    job.lastRunExitCode === 130 &&
    String(job.lastRunError || "").trim().toLowerCase() === "stopped by user"
  ) return "stopped"
  return job.lastRunStatus || "scheduled"
}

function renderJobRow(api, state, job) {
  const row = div("oc-scheduled-jobs__row")
  if (state.selected === jobKey(job)) row.classList.add("is-active")
  const main = button("", "row-main", (event) => {
    if (event.detail > 1) return openEditor(api, state, job)
    selectJob(api, state, job)
  })
  main.append(text("span", job.name, "oc-scheduled-jobs__row-title"))
  if (job.description) main.append(text("span", job.description, "oc-scheduled-jobs__row-description"))
  const modelPolicy = modelPolicyStatus(job)
  if (modelPolicy.kind !== "default" && modelPolicy.kind !== "shell") {
    main.append(text("span", modelPolicy.label, `oc-scheduled-jobs__row-policy is-${modelPolicy.kind}`))
  }
  main.append(text("span", describeSchedule(job.schedule), "oc-scheduled-jobs__row-subtitle"))
  main.append(text("span", job.workdir || "global scope", "oc-scheduled-jobs__row-path"))
  row.append(main)
  return row
}

function selectJob(api, state, job, shouldRender = true) {
  state.selected = jobKey(job)
  state.editor = undefined
  state.confirmDelete = ""
  api.kv.set("selected", state.selected)
  if (shouldRender) renderAll(state)
}

function openEditor(api, state, job) {
  state.editor = { mode: "edit", key: jobKey(job), draft: draftFromJob(job, api), original: job }
  state.view = "edit"
  state.confirmDelete = ""
  void refreshOptions(api, state)
  renderAll(state)
}

function renderJobSummary(job) {
  const summary = div("oc-scheduled-jobs__summary")
  const heading = div("oc-scheduled-jobs__summary-heading")
  heading.append(text("strong", job.name), text("span", `${describeSchedule(job.schedule)} · ${jobDisplayStatus(job)}`))
  summary.append(heading)
  if (job.description) summary.append(text("p", job.description))
  summary.append(text("p", jobSummary(job)))
  return summary
}

function renderDetails(api, state) {
  const panel = div("oc-scheduled-jobs__detail")
  const job = selectedJob(state)
  if (!job) {
    panel.append(emptyState("Select a job or create a new one."))
    return panel
  }

  const top = div("oc-scheduled-jobs__detail-top")
  const heading = div("oc-scheduled-jobs__detail-heading")
  heading.append(text("h3", job.name), text("p", job.slug))
  top.append(backButton(state), heading)
  panel.append(top)

  const jobType = jobTypeFromJob(job)
  const appSessionID = typeof job.run?.appSessionID === "string" ? job.run.appSessionID : ""
  panel.append(infoGrid([
    ["Schedule", `${job.schedule} (${describeSchedule(job.schedule)})`],
    ["Description", job.description || "-"],
    ["Status", jobDisplayStatus(job)],
    ["Last run", formatDate(job.lastRunAt)],
    ["Exit code", job.lastRunExitCode === undefined ? "-" : String(job.lastRunExitCode)],
    ["Workdir", job.workdir || "-"],
    ["Run once", booleanLabel(job.runOnce)],
    ["Run target", jobType === "llm" ? runTargetLabel(runTargetFromJob(job)) : "-"],
    ["App session", jobType === "llm" && runTargetFromJob(job) === "app" ? appSessionLabel(job.run?.appSessionStrategy) : "-"],
    ["Replace session", jobType === "llm" && runTargetFromJob(job) === "app" ? booleanLabel(job.run?.appResetHistory) : "-"],
    ["App session ID", appSessionID || "-"],
    ["Model", job.run?.model || "-"],
    ["Thinking", thinkingLabel(job.run?.variant)],
    ["Model policy", jobType === "llm" ? modelPolicyStatus(job).detail : "-"],
    ["Permissions", accessControlLabel(job.run?.accessControl)],
    ["Timeout", job.timeoutSeconds ? `${job.timeoutSeconds}s` : "-"],
  ]))

  if (appSessionID) {
    const appSession = div("oc-scheduled-jobs__detail-actions")
    appSession.append(button("Open app session", "secondary", () => void openAppSession(api, state, job, appSessionID)))
    panel.append(appSession)
  }

  const prompt = job.run?.prompt || job.prompt
  if (prompt) panel.append(section("Prompt", prompt))
  if (jobType !== "llm") panel.append(section("Command", shellCommandDisplay(job)))
  if (job.lastRunError) panel.append(section("Last error", job.lastRunError, "error"))

  const log = state.logs[jobKey(job)]
  if (log !== undefined) panel.append(section("Logs", log || "No logs yet.", "pre"))

  return panel
}

function renderEditor(api, state) {
  const editor = state.editor
  const draft = editor.draft
  const panel = div("oc-scheduled-jobs__detail")
  const title = editor.mode === "new" ? "New scheduled job" : "Edit scheduled job"
  const top = div("oc-scheduled-jobs__detail-top")
  top.append(backButton(state), text("h3", title))
  panel.append(top)

  const form = div("oc-scheduled-jobs__form")
  form.append(inputField("Name", draft.name, "name", (value) => (draft.name = value), editor.mode === "edit"))
  form.append(textAreaField("Description", draft.description, "description", (value) => (draft.description = value), "What does this job do?"))
  form.append(scheduleField(state, draft))
  form.append(checkboxField("Run once and delete after success", draft.runOnce === "true", "runOnce", (checked) => {
    draft.runOnce = checked ? "true" : "false"
  }))
  form.append(selectField("Job type", draft.jobType, "jobType", (value) => {
    draft.jobType = value || "llm"
    draft.generateMessage = ""
    renderAll(state)
  }, JOB_TYPES))
  if (draft.jobType === "llm") {
    form.append(textAreaField("Prompt", draft.prompt, "prompt", (value) => (draft.prompt = value), "Prompt to run on schedule"))
    form.append(selectField("Run target", draft.runTarget, "runTarget", (value) => {
      draft.runTarget = value || "app"
      if (draft.runTarget !== "app" && draft.modelChain && draft.modelChain !== "default") {
        // Named Settings chains only run on the app target; CLI runs resolve
        // the Settings default chain themselves.
        draft.modelChain = "default"
        draft.modelPolicyExceptionConfirmed = "false"
      }
      state.skipEditorDraftSync = true
      renderAll(state)
    }, RUN_TARGET_OPTIONS))
    if (draft.runTarget === "app") {
      form.append(selectField("Session", draft.appSessionStrategy, "appSessionStrategy", (value) => {
        draft.appSessionStrategy = value || "new"
        if (draft.appSessionStrategy === "current") {
          applyCurrentSessionTarget(draft)
        }
        renderAll(state)
      }, APP_SESSION_OPTIONS))
      if (draft.appSessionStrategy === "job") {
        form.append(checkboxField("Replace session before run", draft.appResetHistory === "true", "appResetHistory", (checked) => {
          draft.appResetHistory = checked ? "true" : "false"
        }))
      }
      if (draft.appSessionStrategy === "current") {
        form.append(section("Current session target", draft.appSessionID || "No open chat session detected."))
      }
    }
    form.append(selectField("Agent", draft.agent, "agent", (value) => (draft.agent = value), agentOptions(state), "Default agent"))
    form.append(selectField("Model routing", draft.modelChain ? `chain:${draft.modelChain}` : "direct", "modelChain", (value) => {
      draft.modelChain = value === "direct" ? "" : value.replace(/^chain:/, "")
      draft.modelPolicyExceptionConfirmed = "false"
      state.skipEditorDraftSync = true
      renderAll(state)
    }, modelChainOptions(api, draft.runTarget)))
    if (!draft.modelChain) {
      form.append(modelField(api, state, draft))
      form.append(selectField("Thinking", draft.variant, "variant", (value) => {
        draft.variant = value
        draft.modelPolicyExceptionConfirmed = "false"
        state.skipEditorDraftSync = true
        renderAll(state)
      }, THINKING_OPTIONS))
      form.append(modelPolicyExceptionField(state, draft))
    }
    form.append(selectField("Permissions", draft.accessControl, "accessControl", (value) => (draft.accessControl = value || "ask"), PERMISSION_OPTIONS))
  } else {
    form.append(shellCommandField(api, state, draft))
  }
  form.append(projectField(api, state, draft))
  if (draft.jobType === "llm") {
    form.append(inputField("Attach URL", draft.attachUrl, "attachUrl", (value) => (draft.attachUrl = value), false, "Optional opencode attach URL"))
    form.append(selectField("Run format", draft.runFormat, "runFormat", (value) => (draft.runFormat = value), [
      { value: "", label: "Default" },
      { value: "json", label: "JSON" },
    ]))
    form.append(selectField("Share", draft.share, "share", (value) => (draft.share = value), booleanOptions("Default")))
    form.append(selectField("Continue", draft.continue, "continue", (value) => (draft.continue = value), booleanOptions("Default")))
  }
  form.append(selectField("Timeout", draft.timeoutSeconds, "timeoutSeconds", (value) => (draft.timeoutSeconds = value), TIMEOUT_OPTIONS))
  panel.append(form)

  const actions = div("oc-scheduled-jobs__detail-actions")
  actions.append(
    button(editor.mode === "new" ? "Create" : "Save", "primary", () => void saveJob(api, state)),
  )
  panel.append(actions)
  panel.append(section("Cron examples", "0 9 * * * = daily at 09:00\n0 */6 * * * = every 6 hours\n30 8 * * 1 = Monday 08:30", "pre"))
  return panel
}

async function saveJob(api, state) {
  const editor = state.editor
  if (!editor) return
  state.busy = editor.mode === "new" ? "Creating job" : "Saving job"
  state.error = ""
  renderAll(state)
  try {
    const invalid = validateCron(editor.draft.schedule)
    if (invalid) {
      state.error = invalid
      return
    }
    if (editor.draft.jobType === "llm" && !editor.draft.prompt.trim()) {
      state.error = "Prompt is required for LLM jobs."
      return
    }
    const modelPolicyError = editor.draft.jobType === "llm" && !editor.draft.modelChain ? modelPolicyExceptionValidationError(editor.draft) : ""
    if (modelPolicyError) {
      state.error = modelPolicyError
      return
    }
    if (editor.draft.jobType === "llm" && editor.draft.runTarget === "app" && editor.draft.appSessionStrategy === "current") {
      applyCurrentSessionTarget(editor.draft)
    }
    if (editor.draft.jobType === "llm" && editor.draft.runTarget === "app" && editor.draft.appSessionStrategy === "current" && !editor.draft.appSessionID) {
      state.error = "Current session jobs can only be created from an open chat."
      return
    }
    if (editor.draft.jobType !== "llm" && !editor.draft.shellCommand.trim()) {
      state.error = "Command is required for shell jobs."
      return
    }
    const body = payloadFromDraft(editor.draft)
    if (editor.mode === "new") {
      await schedulerRequest(api, { path: "/scheduler/jobs", method: "POST", body })
    } else {
      const name = encodeURIComponent(editor.original.slug || editor.original.name)
      await schedulerRequest(api, {
        path: `/scheduler/jobs/${name}`,
        method: "PATCH",
        body: { ...body, lookupWorkdir: editor.original.workdir, scopeId: editor.original.scopeId },
      })
    }
    state.editor = undefined
    state.view = "overview"
    await refreshJobs(api, state, { quiet: true })
  } catch (error) {
    state.error = errorMessage(error)
  } finally {
    state.busy = ""
    renderAll(state)
  }
}

function applyCurrentSessionTarget(draft) {
  draft.appSessionID = draft.sourceSessionID || draft.appSessionID || ""
  if (draft.sourceWorkdir) {
    draft.workdir = draft.sourceWorkdir
    draft.workdirCustom = false
  }
}

async function runJob(api, state, job) {
  state.busy = "Running job"
  state.error = ""
  renderAll(state)
  try {
    const currentClient = runTargetFromJob(job) === "app"
    if (currentClient && typeof api.host.navigation.handoff !== "function") {
      throw new Error("Current-client scheduled jobs require an updated OpenCode client.")
    }
    const result = await schedulerRequest(api, {
      path: `/scheduler/jobs/${encodeURIComponent(job.slug || job.name)}/${currentClient ? "run-current-client" : "run"}`,
      method: "POST",
      body: { lookupWorkdir: job.workdir, scopeId: job.scopeId, ...(currentClient ? { currentClient: true } : {}) },
    })
    const handoff = scheduledJobRunHandoff(result)
    if (handoff) {
      const accepted = await api.host.navigation.handoff(handoff)
      if (!accepted.ok) throw new Error(accepted.error || "Scheduled app handoff failed")
      state.notice = result.output || "Scheduled app job dispatched to the current OpenCode client."
      await refreshJobs(api, state, { quiet: true })
      return
    }
    state.notice = result.output || "Job started"
    await refreshJobs(api, state, { quiet: true })
    if (!state.jobs.some((item) => jobKey(item) === jobKey(job))) {
      state.view = "overview"
      return
    }
    await loadLogs(api, state, job, { quiet: true })
    state.view = "logs"
  } catch (error) {
    state.error = errorMessage(error)
  } finally {
    state.busy = ""
    renderAll(state)
  }
}

async function openAppSession(api, state, job, sessionID) {
  state.error = ""
  try {
    const response = await api.host.http.request({ path: `/session/${encodeURIComponent(sessionID)}`, query: { directory: job.workdir }, signal: api.lifecycle.signal })
    if (!response.ok) throw new Error("Session is unavailable")
    api.host.navigation.openSession({ directory: job.workdir, sessionID, area: "middle" })
  } catch {
    state.notice = "The configured app session no longer exists on this connected OpenCode server."
    renderAll(state)
  }
}

function scheduledJobRunHandoff(result) {
  const handoff = result?.data?.handoff
  if (!handoff || handoff.pluginID !== "scheduled-jobs-app" || handoff.handlerID !== "run" || typeof handoff.directory !== "string" || !handoff.directory) return
  const payload = handoff.payload
  if (!payload || typeof payload.scopeId !== "string" || !payload.scopeId || typeof payload.slug !== "string" || !payload.slug || typeof payload.runId !== "string" || !/^[a-f0-9]{32}$/.test(payload.runId)) return
  return handoff
}

async function loadLogs(api, state, job, options = {}) {
  if (!options.quiet) state.busy = "Loading logs"
  state.error = ""
  renderAll(state)
  try {
    const result = await schedulerRequest(api, {
      path: `/scheduler/jobs/${encodeURIComponent(job.slug || job.name)}/logs`,
      query: { workdir: job.workdir, scopeId: job.scopeId, lines: 200 },
    })
    state.logs[jobKey(job)] = result.data?.logs || result.output || ""
  } catch (error) {
    state.error = errorMessage(error)
  } finally {
    if (!options.quiet) state.busy = ""
    renderAll(state)
  }
}

async function deleteJob(api, state, job) {
  state.busy = "Deleting job"
  state.error = ""
  renderAll(state)
  try {
    await schedulerRequest(api, {
      path: `/scheduler/jobs/${encodeURIComponent(job.slug || job.name)}`,
      method: "DELETE",
      query: { workdir: job.workdir, scopeId: job.scopeId },
    })
    state.confirmDelete = ""
    state.selected = ""
    await refreshJobs(api, state, { quiet: true })
  } catch (error) {
    state.error = errorMessage(error)
  } finally {
    state.busy = ""
    renderAll(state)
  }
}

function draftFromJob(job, api) {
  const current = api.host.navigation.current()
  const savedAppSessionID = job?.run?.appSessionID || ""
  const sourceSessionID = savedAppSessionID || current.sessionID || ""
  const sourceWorkdir = savedAppSessionID ? job?.workdir || "" : current.directory || ""
  const schedule = job?.schedule || "0 9 * * *"
  const scheduleTime = parseScheduleTime(schedule) || "09:00"
  const jobType = jobTypeFromJob(job)
  return {
    name: job?.name || "",
    description: job?.description || "",
    schedule,
    scheduleMode: scheduleMode(schedule),
    scheduleTime,
    scheduleWeekday: parseWeeklyDay(schedule) || "1",
    scheduleMonthDay: parseMonthDay(schedule) || "1",
    scheduleHourInterval: parseHourInterval(schedule) || "6",
    scheduleMinuteInterval: parseMinuteInterval(schedule) || "15",
    runOnce: job?.runOnce === true ? "true" : "false",
    generatePrompt: "",
    generateMessage: "",
    showGenerate: false,
    jobType,
    prompt: job?.run?.prompt || job?.prompt || "",
    shellCommand: shellCommandFromJob(job),
    runTarget: job ? runTargetFromJob(job) : "app",
    appSessionStrategy: appSessionStrategyFromJob(job),
    appSessionID: savedAppSessionID || sourceSessionID,
    sourceSessionID,
    sourceWorkdir,
    appResetHistory: booleanDraftValue(job?.run?.appResetHistory),
    agent: job?.run?.agent || "",
    ...scheduledJobModelRoutingDraft(job),
    modelPolicyExceptionConfirmed: modelPolicyExceptionMatches(job?.run) ? "true" : "false",
    modelPolicyExceptionReason: modelPolicyExceptionReason(job?.run),
    accessControl: accessControlDraftValue(job?.run?.accessControl),
    workdir: job?.workdir || current.directory || "",
    workdirCustom: false,
    attachUrl: job?.run?.attachUrl || job?.attachUrl || "",
    runFormat: job?.run?.runFormat || "",
    share: booleanDraftValue(job?.run?.share),
    continue: booleanDraftValue(job?.run?.continue),
    timeoutSeconds: job?.timeoutSeconds ? String(job.timeoutSeconds) : "",
  }
}

function jobTypeFromJob(job) {
  if (job?.run?.prompt || job?.prompt || job?.run?.runTarget === "app" || job?.run?.runTarget === "cli") return "llm"
  const shellCommand = String(job?.run?.shellCommand || "").toLowerCase()
  if (shellCommand.includes("cmd")) return "cmd"
  if (shellCommand.includes("powershell") || shellCommand.includes("pwsh")) return "powershell"
  const command = String(job?.invocation?.command || "").toLowerCase()
  if (command.includes("cmd")) return "cmd"
  if (command.includes("powershell") || command.includes("pwsh")) return "powershell"
  return "llm"
}

function storedModelPolicyException(run) {
  const value = run?.modelPolicyException
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  if (typeof value.model !== "string" || typeof value.variant !== "string" || typeof value.reason !== "string") return
  const model = value.model.trim()
  const variant = value.variant.trim()
  const reason = value.reason.trim()
  if (!model || !variant || reason.length < MODEL_POLICY_REASON_MIN_LENGTH || reason.length > MODEL_POLICY_REASON_MAX_LENGTH) return
  return { model, variant, reason }
}

function modelPolicyExceptionMatches(run) {
  const exception = storedModelPolicyException(run)
  if (!exception) return false
  return exception.model === String(run?.model || "").trim() && exception.variant === String(run?.variant || "").trim()
}
function modelPolicyExceptionReason(run) {
  return storedModelPolicyException(run)?.reason || ""
}

export function modelPolicyStatus(job) {
  if (jobTypeFromJob(job) !== "llm") return { kind: "shell", label: "Shell job", detail: "Not applicable to shell jobs." }
  if (job.run?.modelChain) {
    const label = job.run.modelChain === "default" ? "Settings default chain" : `Settings chain: ${job.run.modelChain}`
    return { kind: "chain", label, detail: `${label}; resolved and validated by the app when this job runs.` }
  }
  if (modelPolicyExceptionMatches(job.run)) {
    return {
      kind: "exception",
      label: `Explicit model exception: ${modelPolicyExceptionReason(job.run)}`,
      detail: `Explicit exception for ${job.run?.model || "app default"} with ${job.run?.variant || "default"} thinking: ${modelPolicyExceptionReason(job.run)}`,
    }
  }
  return {
    kind: "unresolved",
    label: "Unresolved model-policy exception — edit and confirm",
    detail: "Direct single-model runs deviate from the Settings default chain policy. Edit this job to confirm an exception or switch the routing to the Settings default chain.",
  }
}

function runTargetFromJob(job) {
  return job?.run?.runTarget === "app" ? "app" : "cli"
}

function appSessionStrategyFromJob(job) {
  return appSessionStrategyValue(job?.run?.appSessionStrategy)
}

function shellCommandFromJob(job) {
  const args = Array.isArray(job?.run?.shellArgs)
    ? job.run.shellArgs.map(String)
    : Array.isArray(job?.invocation?.args)
      ? job.invocation.args.map(String)
      : []
  const commandIndex = args.findIndex((arg) => arg.toLowerCase() === "-command")
  if (commandIndex >= 0) return args[commandIndex + 1] || ""
  const cmdIndex = args.findIndex((arg) => arg.toLowerCase() === "/c")
  if (cmdIndex >= 0) return args.slice(cmdIndex + 1).join(" ")
  if (typeof job?.run?.arguments === "string" && job.run.arguments.trim()) {
    if (job.run.shellCommand || /^(powershell|cmd)(\.exe)?$/i.test(String(job.run.command || ""))) return job.run.arguments
    return [job.run.command, job.run.arguments].filter(Boolean).join(" ")
  }
  if (args.length) return args.join(" ")
  return ""
}

function shellCommandDisplay(job) {
  const command = String(job?.run?.command || "").trim()
  const argumentsValue = typeof job?.run?.arguments === "string" ? job.run.arguments.trim() : ""
  const logical = argumentsValue
    ? /^(powershell|cmd)(\.exe)?$/i.test(command)
      ? argumentsValue
      : [command, argumentsValue].filter(Boolean).join(" ")
    : ""
  const script = logical || shellCommandFromJob(job).trim()
  if (script) return script
  const fallback = job?.run?.shellCommand || job?.invocation?.command || job?.run?.command
  return fallback ? String(fallback) : "Command details unavailable"
}

function jobSummary(job) {
  if (jobTypeFromJob(job) === "llm") return String(job.run?.prompt || job.prompt || "Prompt details unavailable")
  return shellCommandDisplay(job)
}

function shellInvocation(draft) {
  if (draft.jobType === "cmd") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", draft.shellCommand.trim()],
    }
  }
  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", draft.shellCommand.trim()],
  }
}

function scheduleField(state, draft) {
  const wrap = div("oc-scheduled-jobs__field oc-scheduled-jobs__schedule-field")
  wrap.append(labelNode("Schedule", "schedule"))

  const controls = div("oc-scheduled-jobs__schedule-controls")
  controls.append(selectControl("Repeat", draft.scheduleMode, "scheduleMode", (value) => {
    draft.scheduleMode = value
    updateScheduleFromControls(state, draft)
  }, SCHEDULE_MODES, "Choose how often the job runs."))

  if (["daily", "weekdays", "weekly", "monthly"].includes(draft.scheduleMode)) {
    const time = document.createElement("input")
    time.type = "time"
    time.value = draft.scheduleTime || "09:00"
    time.setAttribute("data-focus-key", "scheduleTime")
    time.addEventListener("input", () => {
      draft.scheduleTime = time.value
      updateScheduleFromControls(state, draft)
    })
    controls.append(formControl("Time", time, "Local time for the scheduled run.", "scheduleTime"))
  }

  if (draft.scheduleMode === "weekly") {
    controls.append(selectControl("Weekday", draft.scheduleWeekday, "scheduleWeekday", (value) => {
      draft.scheduleWeekday = value
      updateScheduleFromControls(state, draft)
    }, WEEKDAYS, "Day of week for this job."))
  }

  if (draft.scheduleMode === "monthly") {
    controls.append(selectControl("Day", draft.scheduleMonthDay, "scheduleMonthDay", (value) => {
      draft.scheduleMonthDay = value
      updateScheduleFromControls(state, draft)
    }, MONTH_DAYS, "Day of month for this job."))
  }

  if (draft.scheduleMode === "hourly") {
    controls.append(selectControl("Interval", draft.scheduleHourInterval, "scheduleHourInterval", (value) => {
      draft.scheduleHourInterval = value
      updateScheduleFromControls(state, draft)
    }, HOUR_INTERVALS, "Runs at minute 00."))
  }

  if (draft.scheduleMode === "minutes") {
    controls.append(selectControl("Interval", draft.scheduleMinuteInterval, "scheduleMinuteInterval", (value) => {
      draft.scheduleMinuteInterval = value
      updateScheduleFromControls(state, draft)
    }, MINUTE_INTERVALS, "Runs throughout the hour."))
  }

  wrap.append(controls)

  const cronRow = div("oc-scheduled-jobs__cron-row")
  const cron = document.createElement("input")
  cron.value = draft.schedule || ""
  cron.placeholder = "0 9 * * *"
  cron.title = helpFor("schedule")
  cron.setAttribute("data-focus-key", "schedule")
  cron.readOnly = draft.scheduleMode !== "custom"
  cron.addEventListener("input", () => {
    draft.schedule = cron.value
    draft.scheduleMode = "custom"
    draft.generateMessage = ""
    renderAll(state)
  })
  const generate = document.createElement("button")
  generate.type = "button"
  generate.className = "oc-scheduled-jobs__button oc-scheduled-jobs__button--secondary oc-scheduled-jobs__generate"
  generate.title = helpFor("generatePrompt")
  const img = document.createElement("img")
  img.src = GENERATE_ICON
  img.alt = ""
  generate.append(img, text("span", "Generate from prompt"))
  generate.addEventListener("click", () => {
    draft.showGenerate = !draft.showGenerate
    renderAll(state)
  })
  cronRow.append(cron, generate)
  wrap.append(cronRow)
  wrap.append(text("div", `Cron: ${draft.schedule || "-"} (${describeSchedule(draft.schedule)})`, "oc-scheduled-jobs__hint"))

  if (draft.showGenerate) {
    const promptRow = div("oc-scheduled-jobs__prompt-generate")
    const prompt = document.createElement("input")
    prompt.value = draft.generatePrompt || ""
    prompt.placeholder = "e.g. every day at 07:30, montags 8 Uhr, alle 6 Stunden"
    prompt.title = helpFor("generatePrompt")
    prompt.setAttribute("data-focus-key", "generatePrompt")
    prompt.addEventListener("input", () => {
      draft.generatePrompt = prompt.value
    })
    const run = button("Generate", "primary", () => {
      const result = generateCronFromPrompt(draft.generatePrompt)
      if (result.error) {
        draft.generateMessage = result.error
        renderAll(state)
        return
      }
      draft.schedule = result.schedule
      draft.scheduleMode = scheduleMode(result.schedule)
      draft.scheduleTime = parseScheduleTime(result.schedule) || draft.scheduleTime
      draft.scheduleWeekday = parseWeeklyDay(result.schedule) || draft.scheduleWeekday
      draft.scheduleMonthDay = parseMonthDay(result.schedule) || draft.scheduleMonthDay
      draft.scheduleHourInterval = parseHourInterval(result.schedule) || draft.scheduleHourInterval
      draft.scheduleMinuteInterval = parseMinuteInterval(result.schedule) || draft.scheduleMinuteInterval
      draft.generateMessage = result.explanation
      renderAll(state)
    })
    promptRow.append(prompt, run)
    wrap.append(promptRow)
  }

  if (draft.generateMessage) wrap.append(text("div", draft.generateMessage, "oc-scheduled-jobs__generated"))
  return wrap
}

function formControl(label, input, hint, key = "") {
  const wrap = div("oc-scheduled-jobs__form-control")
  const help = helpFor(key) || hint
  if (help) input.title = help
  wrap.append(labelNode(label, key, "span", hint), input, text("small", hint))
  return wrap
}

function shellCommandField(api, state, draft) {
  const wrap = div("oc-scheduled-jobs__field")
  wrap.append(labelNode(draft.jobType === "cmd" ? "CMD command" : "PowerShell command", "shellCommand"))
  const row = div("oc-scheduled-jobs__shell-generate")
  const input = document.createElement("textarea")
  input.value = draft.shellCommand || ""
  input.placeholder = draft.jobType === "cmd" ? "Describe the command or paste CMD code" : "Describe the command or paste PowerShell code"
  input.rows = 7
  input.title = helpFor("shellCommand")
  input.setAttribute("data-focus-key", "shellCommand")
  input.addEventListener("input", () => {
    draft.shellCommand = input.value
  })
  const generate = button(draft.jobType === "cmd" ? "Generate CMD" : "Generate PowerShell", "primary", () => void generateShellCommand(api, state, draft))
  row.append(input, generate)
  wrap.append(row)
  wrap.append(text("div", "Uses the Settings default model chain for generation only. Scheduled runs execute the generated command directly.", "oc-scheduled-jobs__hint"))
  return wrap
}

async function generateShellCommand(api, state, draft) {
  if (!draft.shellCommand.trim()) {
    state.error = "Describe what the command should do first."
    renderAll(state)
    return
  }
  state.busy = draft.jobType === "cmd" ? "Generating CMD" : "Generating PowerShell"
  state.error = ""
  renderAll(state)
  try {
    // Fail closed: command generation follows the configured Settings chain
    // (opencode run resolves default_model_chain itself); without one the
    // helper must not silently fall back to whatever catalog model is newest.
    if (!defaultChainOf(api.ui.models.chains())) {
      state.error = "No default model chain is configured in Settings; configure one before generating commands."
      return
    }
    const current = api.host.navigation.current()
    const shell = draft.jobType === "cmd" ? "Windows cmd.exe batch command" : "Windows PowerShell script"
    const result = await schedulerRequest(api, {
      path: "/app/host/command",
      method: "POST",
      body: {
        command: "opencode",
        arguments: [
          "run",
          "--",
          [
            `Convert this request into a ${shell}.`,
            "Return only executable code with no markdown fences and no explanation.",
            "Do not include destructive actions unless the request explicitly asks for them.",
            "Prefer idempotent commands and explicit paths.",
            "",
            draft.shellCommand,
          ].join("\n"),
        ],
        directory: draft.workdir || current.directory,
      },
    })
    state.skipEditorDraftSync = true
    draft.shellCommand = cleanGeneratedCommand(result.output || result.stdout || "")
    state.notice = `${draft.jobType === "cmd" ? "CMD" : "PowerShell"} generated.`
  } catch (error) {
    state.error = errorMessage(error)
  } finally {
    state.busy = ""
    renderAll(state)
  }
}

function cleanGeneratedCommand(value) {
  const text = String(value || "").trim()
  const fenced = text.match(/```(?:powershell|pwsh|ps1|cmd|bat|batch)?\s*([\s\S]*?)```/i)
  return (fenced?.[1] || text).trim()
}

function updateScheduleFromControls(state, draft) {
  const schedule = scheduleFromControls(draft)
  if (!schedule) return
  draft.schedule = schedule
  draft.generateMessage = `Schedule set to ${describeSchedule(schedule)}.`
  renderAll(state)
}

function scheduleFromControls(draft) {
  if (draft.scheduleMode === "custom") return draft.schedule
  if (draft.scheduleMode === "hourly") return `0 */${draft.scheduleHourInterval || "6"} * * *`
  if (draft.scheduleMode === "minutes") return `*/${draft.scheduleMinuteInterval || "15"} * * * *`
  const time = timeParts(draft.scheduleTime)
  if (!time) return
  if (draft.scheduleMode === "daily") return `${time.minute} ${time.hour} * * *`
  if (draft.scheduleMode === "weekdays") return `${time.minute} ${time.hour} * * 1-5`
  if (draft.scheduleMode === "weekly") return `${time.minute} ${time.hour} * * ${draft.scheduleWeekday || "1"}`
  if (draft.scheduleMode === "monthly") return `${time.minute} ${time.hour} ${draft.scheduleMonthDay || "1"} * *`
}

function scheduleMode(schedule) {
  const value = String(schedule || "").trim()
  if (/^\d{1,2}\s+\d{1,2}\s+\*\s+\*\s+(1-5|1,2,3,4,5)$/.test(value)) return "weekdays"
  if (/^\d{1,2}\s+\d{1,2}\s+\*\s+\*\s+[0-6]$/.test(value)) return "weekly"
  if (/^\d{1,2}\s+\d{1,2}\s+\d{1,2}\s+\*\s+\*$/.test(value)) return "monthly"
  if (/^0\s+\*\/\d{1,2}\s+\*\s+\*\s+\*$/.test(value)) return "hourly"
  if (/^\*\/\d{1,2}\s+\*\s+\*\s+\*\s+\*$/.test(value)) return "minutes"
  if (/^\d{1,2}\s+\d{1,2}\s+\*\s+\*\s+\*$/.test(value)) return "daily"
  return "custom"
}

function parseScheduleTime(schedule) {
  const match = String(schedule || "").trim().match(/^(\d{1,2})\s+(\d{1,2})\s+/)
  if (!match) return
  const minute = Number(match[1])
  const hour = Number(match[2])
  if (!validHourMinute(hour, minute)) return
  return `${pad(hour)}:${pad(minute)}`
}

function parseWeeklyDay(schedule) {
  return String(schedule || "").trim().match(/^\d{1,2}\s+\d{1,2}\s+\*\s+\*\s+([0-6])$/)?.[1]
}

function parseMonthDay(schedule) {
  return String(schedule || "").trim().match(/^\d{1,2}\s+\d{1,2}\s+(\d{1,2})\s+\*\s+\*$/)?.[1]
}

function parseHourInterval(schedule) {
  return String(schedule || "").trim().match(/^0\s+\*\/(\d{1,2})\s+\*\s+\*\s+\*$/)?.[1]
}

function parseMinuteInterval(schedule) {
  return String(schedule || "").trim().match(/^\*\/(\d{1,2})\s+\*\s+\*\s+\*\s+\*$/)?.[1]
}

function cronFromTime(value) {
  const time = timeParts(value)
  if (!time) return
  return `${time.minute} ${time.hour} * * *`
}

function timeParts(value) {
  const [hourValue, minuteValue] = String(value || "").split(":")
  const hour = Number(hourValue)
  const minute = Number(minuteValue)
  if (!validHourMinute(hour, minute)) return
  return { hour, minute }
}

function validHourMinute(hour, minute) {
  return Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
}

function validateCron(schedule) {
  const parts = String(schedule || "").trim().split(/\s+/).filter(Boolean)
  if (parts.length !== 5) return "Cron schedule must have five fields: minute hour day month weekday."
  if (!parts.every((part) => /^[\d*/,-]+$/.test(part))) return "Cron schedule contains unsupported characters. Use numbers, *, /, comma and dash."
  return ""
}

function generateCronFromPrompt(input) {
  const value = normalizePrompt(input)
  if (!value) return { error: "Describe when the job should run first." }

  const everyHours = value.match(/(?:every|alle)\s+(\d{1,2})\s*(?:hours?|stunden?)/)
  if (everyHours) {
    const hours = Number(everyHours[1])
    if (Number.isInteger(hours) && hours >= 1 && hours <= 23) return { schedule: `0 */${hours} * * *`, explanation: `Generated ${hours}-hour interval cron.` }
  }

  const everyMinutes = value.match(/(?:every|alle)\s+(\d{1,2})\s*(?:minutes?|minuten?)/)
  if (everyMinutes) {
    const minutes = Number(everyMinutes[1])
    if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 59) return { schedule: `*/${minutes} * * * *`, explanation: `Generated ${minutes}-minute interval cron.` }
  }

  const time = promptTime(value) || { hour: 9, minute: 0 }
  const weekday = promptWeekday(value)
  if (weekday !== undefined) {
    const schedule = `${time.minute} ${time.hour} * * ${weekday}`
    return { schedule, explanation: `Generated ${describeSchedule(schedule)}.` }
  }

  if (/daily|every day|jeden tag|taeglich|täglich/.test(value) || promptTime(value)) {
    const schedule = `${time.minute} ${time.hour} * * *`
    return { schedule, explanation: `Generated ${describeSchedule(schedule)}.` }
  }

  return { error: "I can generate simple daily, weekday, hourly or minute schedules. Try: 'daily at 07:30'." }
}

function normalizePrompt(input) {
  return String(input || "").trim().toLowerCase().replaceAll("ä", "ae").replaceAll("ö", "oe").replaceAll("ü", "ue")
}

function promptTime(value) {
  const clock = value.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|uhr)?\b/)
  if (!clock) return
  const suffix = clock[3]
  const rawHour = Number(clock[1])
  const minute = Number(clock[2] || 0)
  const hour = suffix === "pm" && rawHour < 12 ? rawHour + 12 : suffix === "am" && rawHour === 12 ? 0 : rawHour
  if (!validHourMinute(hour, minute)) return
  return { hour, minute }
}

function promptWeekday(value) {
  const days = [
    [1, ["monday", "mondays", "montag", "montags"]],
    [2, ["tuesday", "tuesdays", "dienstag", "dienstags"]],
    [3, ["wednesday", "wednesdays", "mittwoch", "mittwochs"]],
    [4, ["thursday", "thursdays", "donnerstag", "donnerstags"]],
    [5, ["friday", "fridays", "freitag", "freitags"]],
    [6, ["saturday", "saturdays", "samstag", "samstags", "sonnabend"]],
    [0, ["sunday", "sundays", "sonntag", "sonntags"]],
  ]
  return days.find((entry) => entry[1].some((word) => value.includes(word)))?.[0]
}

export function payloadFromDraft(draft) {
  const timeoutSeconds = Number(draft.timeoutSeconds)
  const common = {
    name: draft.name.trim(),
    description: draft.description.trim(),
    schedule: draft.schedule.trim(),
    workdir: draft.workdir.trim(),
    runOnce: draft.runOnce === "true",
    timeoutSeconds: Number.isFinite(timeoutSeconds) && timeoutSeconds >= 0 ? Math.floor(timeoutSeconds) : undefined,
  }
  if (draft.jobType !== "llm") {
    return compactObject({
      ...common,
      prompt: "",
      command: "",
      arguments: "",
      invocation: shellInvocation(draft),
    })
  }
  return compactObject({
    ...common,
    prompt: draft.prompt.trim(),
    command: "",
    arguments: "",
    agent: draft.agent.trim(),
    modelChain: draft.modelChain.trim(),
    model: draft.modelChain ? "" : draft.model.trim(),
    variant: draft.modelChain ? "" : draft.variant.trim(),
    modelPolicyException: draft.modelChain ? null : modelPolicyExceptionFromDraft(draft),
    runTarget: draft.runTarget === "cli" ? "cli" : "app",
    appSessionStrategy: draft.runTarget === "app" ? appSessionStrategyValue(draft.appSessionStrategy) : undefined,
    appSessionID: draft.runTarget === "app" && draft.appSessionStrategy === "current" ? draft.appSessionID : undefined,
    appResetHistory:
      draft.runTarget === "app" ? draft.appSessionStrategy === "job" && draft.appResetHistory === "true" : undefined,
    accessControl: accessControlFromDraft(draft.accessControl),
    runFormat: draft.runFormat.trim(),
    share: draft.share === "true" ? true : draft.share === "false" ? false : undefined,
    continue: draft.continue === "true" ? true : draft.continue === "false" ? false : undefined,
    attachUrl: draft.attachUrl.trim(),
  })
}

function booleanDraftValue(value) {
  if (value === true) return "true"
  if (value === false) return "false"
  return ""
}

function accessControlDraftValue(value) {
  const mode = value && typeof value === "object" ? value.mode : undefined
  return PERMISSION_OPTIONS.some((option) => option.value === mode) ? mode : "ask"
}

function accessControlFromDraft(value) {
  if (value === "approve_for_me") return { mode: value }
  if (value === "full_access") return { mode: value }
  return { mode: "ask" }
}

function appSessionStrategyValue(value) {
  if (value === "current") return "current"
  return value === "job" ? "job" : "new"
}

function accessControlLabel(value) {
  const mode = value && typeof value === "object" ? value.mode : undefined
  return PERMISSION_OPTIONS.find((option) => option.value === mode)?.label || "Ask for approval"
}

function runTargetLabel(value) {
  return RUN_TARGET_OPTIONS.find((option) => option.value === value)?.label || "CLI"
}

function appSessionLabel(value) {
  if (value === "current") return "Current session"
  return APP_SESSION_OPTIONS.find((option) => option.value === value)?.label || "New session each run"
}

function booleanLabel(value) {
  return value === true ? "Yes" : "No"
}

function thinkingLabel(value) {
  return THINKING_OPTIONS.find((option) => option.value === value)?.label || (value ? String(value) : "Default")
}

function compactObject(input) {
  return Object.fromEntries(Object.entries(input).filter((entry) => entry[1] !== undefined))
}

function normalizeAgents(input) {
  const items = unwrapList(input, "agents")
  return items
    .filter((agent) => agent && typeof agent === "object" && typeof agent.name === "string" && !agent.hidden)
    .map((agent) => ({
      name: agent.name,
      description: typeof agent.description === "string" ? agent.description : "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function normalizeModels(input) {
  const providers = Array.isArray(input?.all) ? input.all : unwrapList(input, "providers")
  const defaults = input && typeof input === "object" && input.default && typeof input.default === "object" ? input.default : {}
  return providers
    .filter((provider) => provider && typeof provider === "object")
    .flatMap((provider) =>
      Object.entries(provider.models || {}).map((entry) => {
        const model = entry[1] && typeof entry[1] === "object" ? entry[1] : {}
        const providerID = model.providerID || provider.id || ""
        const modelID = model.id || entry[0]
        const label = model.name || modelID
        const providerName = provider.name || providerID
        const description = [providerName, modelID, defaults[providerID] === modelID ? "Default model for this provider" : ""].filter(Boolean).join(" - ")
        return {
          value: `${providerID}/${modelID}`,
          label,
          description,
        }
      }),
    )
    .filter((model) => model.value !== "/")
    .sort((a, b) => a.label.localeCompare(b.label))
}

function normalizeCommands(input) {
  return unwrapList(input, "commands")
    .filter((command) => command && typeof command === "object" && typeof command.name === "string")
    .map((command) => ({
      name: command.name,
      description: typeof command.description === "string" ? command.description : "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function normalizeProjects(input) {
  return Array.isArray(input)
    ? input
        .filter((project) => project && typeof project === "object" && typeof project.worktree === "string")
        .map((project) => ({
          value: project.worktree,
          label: project.name ? `${project.name} - ${project.worktree}` : project.worktree,
        }))
        .sort((a, b) => a.label.localeCompare(b.label))
    : []
}

function unwrapList(input, key) {
  if (Array.isArray(input)) return input
  if (!input || typeof input !== "object") return []
  if (Array.isArray(input.data)) return input.data
  if (Array.isArray(input[key])) return input[key]
  return []
}

function filteredJobs(state) {
  const query = state.query.trim().toLowerCase()
  if (!query) return state.jobs
  return state.jobs.filter((job) => [job.name, job.slug, job.description, job.schedule, job.workdir, job.prompt, job.run?.prompt, shellCommandDisplay(job)].join(" ").toLowerCase().includes(query))
}

function selectedJob(state) {
  return state.jobs.find((job) => jobKey(job) === state.selected)
}

function jobKey(job) {
  return `${job.scopeId || "legacy"}:${job.slug || job.name}`
}

function describeSchedule(schedule) {
  const value = String(schedule || "").trim()
  if (value === "0 9 * * *") return "daily at 09:00"
  if (value === "0 */6 * * *") return "every 6 hours"
  const everyHours = value.match(/^0 \*\/(\d+) \* \* \*$/)
  if (everyHours) return `every ${everyHours[1]} hours`
  const everyMinutes = value.match(/^\*\/(\d+) \* \* \* \*$/)
  if (everyMinutes) return `every ${everyMinutes[1]} minutes`
  const weekdays = value.match(/^(\d+) (\d+) \* \* (1-5|1,2,3,4,5)$/)
  if (weekdays) return `weekdays ${pad(weekdays[2])}:${pad(weekdays[1])}`
  const weekday = value.match(/^(\d+) (\d+) \* \* ([0-6])$/)
  if (weekday) return `${weekdayName(Number(weekday[3]))} ${pad(weekday[2])}:${pad(weekday[1])}`
  const monthly = value.match(/^(\d+) (\d+) (\d+) \* \*$/)
  if (monthly) return `monthly day ${monthly[3]} ${pad(monthly[2])}:${pad(monthly[1])}`
  const daily = value.match(/^(\d+) (\d+) \* \* \*$/)
  if (daily) return `daily ${pad(daily[2])}:${pad(daily[1])}`
  return value || "-"
}

function weekdayName(day) {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day] || "Weekday"
}

function pad(value) {
  return String(value).padStart(2, "0")
}

function shortPath(value) {
  const parts = String(value || "").split(/[\\/]/).filter(Boolean)
  return parts.at(-1) || value || "project"
}

function compactNotice(value) {
  return String(value).replace(/\s+/g, " ").slice(0, 180)
}

function resultText(body) {
  if (!body || typeof body !== "object") return ""
  return typeof body.output === "string" ? body.output : typeof body.message === "string" ? body.message : ""
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "job"
}

function formatDate(value) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString()
}

function div(className) {
  const node = document.createElement("div")
  node.className = className
  return node
}

function text(tag, value, className) {
  const node = document.createElement(tag)
  if (className) node.className = className
  node.textContent = value
  return node
}

function button(label, variant, onClick) {
  const node = document.createElement("button")
  node.type = "button"
  node.className = `oc-scheduled-jobs__button oc-scheduled-jobs__button--${variant}`
  node.textContent = label
  node.addEventListener("click", onClick)
  return node
}

function backButton(state) {
  return button("← Back", "secondary", () => {
    state.editor = undefined
    state.view = "overview"
    renderAll(state)
  })
}

function inputField(label, value, key, onInput, disabled = false, placeholder = "") {
  const wrap = div("oc-scheduled-jobs__field")
  wrap.append(labelNode(label, key))
  const input = document.createElement("input")
  input.value = value || ""
  input.disabled = disabled
  input.placeholder = placeholder
  input.title = helpFor(key)
  input.setAttribute("data-focus-key", key)
  input.addEventListener("input", () => onInput(input.value))
  wrap.append(input)
  return wrap
}

function textAreaField(label, value, key, onInput, placeholder = "") {
  const wrap = div("oc-scheduled-jobs__field")
  wrap.append(labelNode(label, key))
  const input = document.createElement("textarea")
  input.value = value || ""
  input.placeholder = placeholder
  input.rows = 5
  input.title = helpFor(key)
  input.setAttribute("data-focus-key", key)
  input.addEventListener("input", () => onInput(input.value))
  wrap.append(input)
  return wrap
}

function selectField(label, value, key, onInput, options, placeholder = "", config = {}) {
  const wrap = div("oc-scheduled-jobs__field")
  wrap.append(labelNode(label, key))
  wrap.append(selectInput(value, key, onInput, withCurrentOption(options, value, placeholder), configWithTitle(config, key)))
  return wrap
}

function checkboxField(label, checked, key, onInput) {
  const help = helpFor(key)
  const wrap = div("oc-scheduled-jobs__field")
  const control = document.createElement("label")
  control.className = "oc-scheduled-jobs__checkbox"
  if (help) control.title = help
  const input = document.createElement("input")
  input.type = "checkbox"
  input.checked = checked
  input.title = help
  input.setAttribute("data-focus-key", key)
  input.addEventListener("change", () => onInput(input.checked))
  const caption = text("span", label)
  if (help) {
    const marker = text("span", "?", "oc-scheduled-jobs__field-help")
    marker.title = help
    caption.append(marker)
  }
  control.append(input, caption)
  wrap.append(control)
  return wrap
}

function selectControl(label, value, key, onInput, options, hint) {
  return formControl(label, selectInput(value, key, onInput, withCurrentOption(options, value), configWithTitle({}, key)), hint, key)
}

function modelPolicyExceptionField(state, draft) {
  const confirmed = draft.modelPolicyExceptionConfirmed === "true"
  const wrap = div("oc-scheduled-jobs__model-policy")
  wrap.append(text(
    "div",
    confirmed
      ? "Explicit exception selected. Save a reason that applies to this exact model and thinking combination."
      : "Direct single-model routing deviates from the Settings default chain policy.",
    `oc-scheduled-jobs__model-policy-status is-${confirmed ? "confirmed" : "unresolved"}`,
  ))
  wrap.append(checkboxField(
    "Allow this model-policy exception",
    confirmed,
    "modelPolicyExceptionConfirmed",
    (checked) => {
      draft.modelPolicyExceptionConfirmed = checked ? "true" : "false"
      renderAll(state)
    },
  ))
  wrap.append(textAreaField(
    "Exception reason",
    draft.modelPolicyExceptionReason,
    "modelPolicyExceptionReason",
    (value) => (draft.modelPolicyExceptionReason = value),
    "Why is this exact model/thinking combination required?",
  ))
  return wrap
}

export function modelPolicyExceptionValidationError(draft) {
  if (!draft.model.trim() || !draft.variant.trim()) {
    return "A model-policy exception requires an explicit model and thinking level; app defaults cannot be approved as an exception. Switch the routing to the Settings default chain instead."
  }
  if (draft.modelPolicyExceptionConfirmed !== "true") {
    return "Direct single-model LLM jobs require an explicitly confirmed model-policy exception; run them on the Settings default chain unless the direct model is required."
  }
  const length = String(draft.modelPolicyExceptionReason || "").trim().length
  if (length < MODEL_POLICY_REASON_MIN_LENGTH || length > MODEL_POLICY_REASON_MAX_LENGTH) {
    return `Model-policy exception reason must contain ${MODEL_POLICY_REASON_MIN_LENGTH}-${MODEL_POLICY_REASON_MAX_LENGTH} characters.`
  }
  return ""
}

export function modelPolicyExceptionFromDraft(draft) {
  if (draft.modelPolicyExceptionConfirmed !== "true") return
  return {
    model: draft.model.trim(),
    variant: draft.variant.trim(),
    reason: draft.modelPolicyExceptionReason.trim(),
  }
}

function modelField(api, state, draft) {
  const wrap = div("oc-scheduled-jobs__field")
  wrap.append(labelNode("Model", "model"))
  const mount = div("oc-scheduled-jobs__model-picker")
  mount.setAttribute("data-focus-key", "model")
  mount.title = helpFor("model")
  wrap.append(mount)
  const control = api.ui.models.selector({
    element: mount,
    value: draft.model || undefined,
    label: "Model",
    allowClear: true,
    onChange(value) {
      draft.model = value || ""
      draft.modelPolicyExceptionConfirmed = "false"
      state.skipEditorDraftSync = true
      renderAll(state)
    },
  })
  state.controls.push(control.dispose)
  return wrap
}

function selectInput(value, key, onInput, options, config = {}) {
  const wrap = div("oc-scheduled-jobs__select")
  const trigger = document.createElement("button")
  trigger.type = "button"
  trigger.className = "oc-scheduled-jobs__select-trigger"
  trigger.setAttribute("data-focus-key", key)
  if (config.title) trigger.title = config.title
  trigger.setAttribute("aria-haspopup", "listbox")
  trigger.setAttribute("aria-expanded", "false")
  const label = text("span", "", "oc-scheduled-jobs__select-label")
  trigger.append(label, text("span", "", "oc-scheduled-jobs__select-chevron"))

  const menu = div("oc-scheduled-jobs__select-menu")
  menu.hidden = true
  menu.setAttribute("role", "listbox")

  const search = config.searchPlaceholder ? document.createElement("input") : undefined
  if (search) {
    search.type = "search"
    search.placeholder = config.searchPlaceholder
    search.className = "oc-scheduled-jobs__select-search"
    search.setAttribute("aria-label", config.searchPlaceholder)
  }
  const optionList = div("oc-scheduled-jobs__select-options")
  const empty = text("div", config.emptyMessage || "No matching options.", "oc-scheduled-jobs__select-empty")
  empty.hidden = true

  let selectedValue = value || ""
  const items = options.map((option) => {
    const item = document.createElement("button")
    item.type = "button"
    item.className = "oc-scheduled-jobs__select-option"
    item.setAttribute("role", "option")
    item.append(text("span", option.label, "oc-scheduled-jobs__select-option-label"))
    if (option.description) item.append(text("small", option.description, "oc-scheduled-jobs__select-option-description"))
    item.addEventListener("click", (event) => {
      event.stopPropagation()
      selectedValue = option.value
      updateSelected()
      close()
      onInput(selectedValue)
      trigger.focus()
    })
    optionList.append(item)
    return { item, option }
  })
  menu.append(...[search, optionList, empty].filter(Boolean))

  const updateSelected = () => {
    label.textContent = (items.find((entry) => entry.option.value === selectedValue) || items[0])?.option.label || ""
    for (const entry of items) {
      const selected = entry.option.value === selectedValue
      entry.item.classList.toggle("is-selected", selected)
      entry.item.setAttribute("aria-selected", selected ? "true" : "false")
    }
  }
  const visibleItems = () => items.filter((entry) => !entry.item.hidden)
  const updateFilter = () => {
    const query = search?.value.trim().toLowerCase() || ""
    for (const entry of items) {
      const haystack = [entry.option.label, entry.option.description, entry.option.value].join(" ").toLowerCase()
      entry.item.hidden = !!query && !haystack.includes(query)
    }
    empty.hidden = visibleItems().length > 0
  }
  const focusOption = (entry) => {
    entry?.item.focus()
    entry?.item.scrollIntoView({ block: "nearest" })
  }
  const focusAdjacentOption = (current, delta) => {
    const visible = visibleItems()
    const index = visible.findIndex((entry) => entry.item === current || entry.option.value === selectedValue)
    focusOption(visible[Math.max(0, Math.min(visible.length - 1, index + delta))])
  }
  const updatePosition = () => {
    const rect = trigger.getBoundingClientRect()
    const gap = 4
    const viewportPadding = 8
    const below = window.innerHeight - rect.bottom - viewportPadding
    const above = rect.top - viewportPadding
    const maxHeight = Math.max(120, Math.min(320, Math.max(below, above) - gap))
    const menuWidth = Math.min(Math.max(rect.width, config.minMenuWidth || rect.width), window.innerWidth - viewportPadding * 2)
    menu.style.left = `${Math.min(Math.max(viewportPadding, rect.left), window.innerWidth - viewportPadding - menuWidth)}px`
    menu.style.width = `${menuWidth}px`
    menu.style.maxHeight = `${maxHeight}px`
    menu.style.top = below >= 160 || below >= above ? `${rect.bottom + gap}px` : `${Math.max(viewportPadding, rect.top - maxHeight - gap)}px`
  }
  const close = () => {
    wrap.classList.remove("is-open")
    menu.hidden = true
    menu.remove()
    trigger.setAttribute("aria-expanded", "false")
    document.removeEventListener("pointerdown", closeOutside, true)
    window.removeEventListener("resize", updatePosition)
    window.removeEventListener("scroll", updatePosition, true)
  }
  const open = () => {
    document.querySelectorAll(".oc-scheduled-jobs__select.is-open").forEach((node) => node.dispatchEvent(new CustomEvent("oc-scheduled-jobs-close-select")))
    wrap.classList.add("is-open")
    document.body.append(menu)
    menu.hidden = false
    trigger.setAttribute("aria-expanded", "true")
    if (search) search.value = ""
    updateFilter()
    updatePosition()
    document.addEventListener("pointerdown", closeOutside, true)
    window.addEventListener("resize", updatePosition)
    window.addEventListener("scroll", updatePosition, true)
    ;(items.find((entry) => entry.option.value === selectedValue) || visibleItems()[0])?.item.scrollIntoView({ block: "nearest" })
    search?.focus({ preventScroll: true })
  }
  function closeOutside(event) {
    if (!wrap.contains(event.target) && !menu.contains(event.target)) close()
  }

  updateSelected()
  trigger.addEventListener("click", (event) => {
    event.stopPropagation()
    if (wrap.classList.contains("is-open")) {
      close()
      return
    }
    open()
  })
  trigger.addEventListener("oc-scheduled-jobs-open-select", () => {
    if (!wrap.classList.contains("is-open")) open()
  })
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close()
    if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return
    event.preventDefault()
    if (!wrap.classList.contains("is-open")) open()
    focusAdjacentOption(document.activeElement, event.key === "ArrowUp" ? -1 : 1)
  })
  search?.addEventListener("input", updateFilter)
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      close()
      trigger.focus()
      return
    }
    if (event.target === search && event.key === "Enter") {
      visibleItems()[0]?.item.click()
      return
    }
    if (event.target === search && event.key === "ArrowDown") {
      event.preventDefault()
      focusOption(visibleItems()[0])
      return
    }
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return
    event.preventDefault()
    focusAdjacentOption(document.activeElement, event.key === "ArrowUp" ? -1 : 1)
  })
  wrap.addEventListener("oc-scheduled-jobs-close-select", close)
  wrap.append(trigger)
  return wrap
}

function withCurrentOption(options, value, placeholder = "") {
  const base = placeholder ? [{ value: "", label: placeholder }, ...options] : options
  if (!value || base.some((option) => option.value === value)) return base
  return [...base, { value, label: value }]
}

function configWithTitle(config, key) {
  const help = helpFor(key)
  if (!help || config.title) return config
  return { ...config, title: help }
}

function labelNode(label, key, tag = "label", fallback = "") {
  const node = text(tag, label)
  const help = helpFor(key) || fallback
  if (!help) return node
  node.title = help
  const marker = text("span", "?", "oc-scheduled-jobs__field-help")
  marker.title = help
  node.append(marker)
  return node
}

function helpFor(key) {
  return FIELD_HELP[key] || ""
}

function projectField(api, state, draft) {
  const wrap = div("oc-scheduled-jobs__field")
  wrap.append(labelNode("Working dir", "workdirProject"))
  const current = api.host.navigation.current()
  const projects = state.options.projects
  const known = draft.workdir === current.directory || projects.some((project) => project.value === draft.workdir)
  const custom = draft.workdirCustom || (draft.workdir && !known)
  const options = [
    ...(current.directory ? [{ value: current.directory, label: `Current: ${shortPath(current.directory)}` }] : []),
    ...projects.filter((project) => project.value !== current.directory),
    { value: "__custom__", label: "Custom path..." },
  ]
  wrap.append(selectInput(custom ? "__custom__" : draft.workdir, "workdirProject", (value) => {
    if (value === "__custom__") {
      draft.workdirCustom = true
      renderAll(state)
      return
    }
    draft.workdir = value
    draft.workdirCustom = false
    renderAll(state)
  }, withCurrentOption(options, custom ? "__custom__" : draft.workdir), configWithTitle({}, "workdirProject")))
  if (custom) {
    const input = document.createElement("input")
    input.value = draft.workdir || current.directory || ""
    input.placeholder = "C:\\Path\\To\\Project"
    input.title = helpFor("workdir")
    input.setAttribute("data-focus-key", "workdir")
    input.addEventListener("input", () => {
      draft.workdir = input.value
    })
    wrap.append(input)
  }
  return wrap
}

function commandOptions(state) {
  return state.options.commands.map((command) => ({ value: command.name, label: command.name, description: command.description }))
}

function agentOptions(state) {
  return state.options.agents.map((agent) => ({ value: agent.name, label: agent.name, description: agent.description }))
}

function modelOptions(state) {
  return state.options.models.map((model) => ({ value: model.value, label: model.label, description: model.description }))
}

export function modelChainOptions(api, runTarget = "app") {
  // Named Settings chains are resolved by the OpenCode client at run time, so
  // they can only be honored by app jobs; CLI runs resolve the Settings default
  // chain themselves and the scheduler rejects named chains for them.
  const named = runTarget === "app"
    ? api.ui.models.chains().map((chain) => ({
        value: `chain:${chain.id}`,
        label: chain.isDefault ? `${chain.name} (default)` : chain.name,
        description: `Settings chain: ${chain.id}`,
      }))
    : []
  return [
    { value: "chain:default", label: "Settings default chain", description: "Resolve the current default model chain when this job runs." },
    ...named,
    { value: "direct", label: "Direct model", description: "Legacy single-model execution without chain fallback." },
  ]
}

// New jobs start on the dynamic Settings default chain ("default" is resolved
// at each run); persisted jobs keep whatever routing they were saved with.
export function scheduledJobModelRoutingDraft(job) {
  return {
    modelChain: job ? job?.run?.modelChain || "" : "default",
    model: job ? job?.run?.model || "" : "",
    variant: job ? job?.run?.variant || "" : "",
  }
}

export function defaultChainOf(chains) {
  return (Array.isArray(chains) ? chains : []).find((chain) => chain?.isDefault)
}

function booleanOptions(defaultLabel) {
  return [
    { value: "", label: defaultLabel },
    { value: "true", label: "Yes" },
    { value: "false", label: "No" },
  ]
}

function infoGrid(rows) {
  const grid = div("oc-scheduled-jobs__info")
  for (const [label, value] of rows) {
    grid.append(text("dt", label), text("dd", value))
  }
  return grid
}

function section(title, body, kind = "") {
  const wrap = div(`oc-scheduled-jobs__section ${kind ? `is-${kind}` : ""}`)
  wrap.append(text("h4", title))
  const content = text(kind === "pre" ? "pre" : "p", body)
  wrap.append(content)
  return wrap
}

function emptyState(message) {
  const node = div("oc-scheduled-jobs__empty")
  node.textContent = message
  return node
}

function styleNode() {
  const style = document.createElement("style")
  style.textContent = `
    .oc-scheduled-jobs {
      --oc-scheduled-jobs-bg: var(--v2-background-bg-layer-01, var(--color-background, #ffffff));
      --oc-scheduled-jobs-panel: var(--v2-background-bg-layer-02, var(--color-background-stronger, #f8fafc));
      --oc-scheduled-jobs-panel-strong: var(--v2-background-bg-layer-03, var(--color-fill-element, #eef2f7));
      --oc-scheduled-jobs-text: var(--v2-text-text-base, var(--color-text, #111827));
      --oc-scheduled-jobs-text-strong: var(--v2-text-text-base, var(--color-text-strong, #020617));
      --oc-scheduled-jobs-text-muted: var(--v2-text-text-muted, var(--color-text-weak, #64748b));
      --oc-scheduled-jobs-text-faint: var(--v2-text-text-faint, var(--color-text-weaker, #94a3b8));
      --oc-scheduled-jobs-accent: var(--v2-text-text-accent, var(--color-primary, #2563eb));
      --oc-scheduled-jobs-accent-hover: var(--v2-text-text-accent-hover, var(--color-primary, #1d4ed8));
      --oc-scheduled-jobs-border: var(--v2-border-border-base, var(--color-divider, rgba(148, 163, 184, 0.3)));
      --oc-scheduled-jobs-border-strong: var(--v2-border-border-strong, var(--color-divider, rgba(148, 163, 184, 0.42)));
      --oc-scheduled-jobs-danger: var(--v2-state-fg-danger, var(--color-danger, #dc2626));
      --oc-scheduled-jobs-success: var(--v2-state-fg-success, var(--color-success, #059669));
      box-sizing: border-box;
      height: 100%;
      min-height: 0;
      color: var(--oc-scheduled-jobs-text);
      background: var(--oc-scheduled-jobs-bg);
      font: 13px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .oc-scheduled-jobs *, .oc-scheduled-jobs *::before, .oc-scheduled-jobs *::after { box-sizing: border-box; }
    .oc-scheduled-jobs__view,
    .oc-scheduled-jobs__shell {
      height: 100%;
      min-height: 0;
    }
    .oc-scheduled-jobs__shell {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--oc-scheduled-jobs-border);
      background: var(--oc-scheduled-jobs-bg);
    }
    .oc-scheduled-jobs__header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      padding: 12px;
      border-bottom: 1px solid var(--oc-scheduled-jobs-border);
    }
    .oc-scheduled-jobs__title {
      display: flex;
      min-width: 0;
      align-items: center;
      gap: 8px;
      font-weight: 700;
      color: var(--oc-scheduled-jobs-text-strong);
    }
    .oc-scheduled-jobs__title img {
      width: 18px;
      height: 18px;
      flex: 0 0 auto;
    }
    .oc-scheduled-jobs__actions,
    .oc-scheduled-jobs__config-actions,
    .oc-scheduled-jobs__detail-actions,
    .oc-scheduled-jobs__danger {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .oc-scheduled-jobs__header input {
      grid-column: 1 / -1;
      width: 100%;
    }
    .oc-scheduled-jobs input,
    .oc-scheduled-jobs textarea,
    .oc-scheduled-jobs select {
      min-width: 0;
      border: 1px solid var(--oc-scheduled-jobs-border-strong);
      border-radius: 6px;
      background: var(--oc-scheduled-jobs-panel);
      color: var(--oc-scheduled-jobs-text);
      padding: 7px 9px;
      outline: none;
    }
    .oc-scheduled-jobs textarea {
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
    }
    .oc-scheduled-jobs input:focus,
    .oc-scheduled-jobs textarea:focus,
    .oc-scheduled-jobs select:focus {
      border-color: var(--oc-scheduled-jobs-accent);
      box-shadow: 0 0 0 1px var(--oc-scheduled-jobs-accent);
    }
    .oc-scheduled-jobs__status {
      min-height: 30px;
      display: flex;
      align-items: center;
      padding: 0 12px;
      border-bottom: 1px solid var(--oc-scheduled-jobs-border);
      color: var(--oc-scheduled-jobs-text-muted);
      overflow: hidden;
    }
    .oc-scheduled-jobs__status span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .oc-scheduled-jobs__status .error {
      color: var(--oc-scheduled-jobs-danger);
    }
    .oc-scheduled-jobs__body {
      min-height: 0;
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .oc-scheduled-jobs__config {
      min-height: 150px;
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .oc-scheduled-jobs__summary {
      flex: 0 0 auto;
      display: grid;
      gap: 6px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--oc-scheduled-jobs-border);
      background: var(--oc-scheduled-jobs-panel);
    }
    .oc-scheduled-jobs__summary-heading {
      min-width: 0;
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
    .oc-scheduled-jobs__summary-heading strong,
    .oc-scheduled-jobs__summary-heading span,
    .oc-scheduled-jobs__summary p {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .oc-scheduled-jobs__summary-heading span,
    .oc-scheduled-jobs__summary p {
      color: var(--oc-scheduled-jobs-text-muted);
      font-size: 12px;
    }
    .oc-scheduled-jobs__config-actions {
      flex: 0 0 auto;
      padding: 8px;
      border-bottom: 1px solid var(--oc-scheduled-jobs-border);
    }
    .oc-scheduled-jobs__config-actions > span {
      color: var(--oc-scheduled-jobs-text-muted);
      font-size: 12px;
    }
    .oc-scheduled-jobs__tree,
    .oc-scheduled-jobs__detail {
      min-width: 0;
      min-height: 0;
      overflow: auto;
    }
    .oc-scheduled-jobs__tree {
      flex: 1;
      padding: 8px;
    }
    .oc-scheduled-jobs__group + .oc-scheduled-jobs__group {
      margin-top: 12px;
    }
    .oc-scheduled-jobs__group-title {
      padding: 4px 6px 6px;
      color: var(--oc-scheduled-jobs-accent);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .oc-scheduled-jobs__button {
      border: 1px solid var(--oc-scheduled-jobs-border);
      border-radius: 6px;
      padding: 6px 9px;
      color: var(--oc-scheduled-jobs-text);
      background: var(--oc-scheduled-jobs-panel);
      cursor: pointer;
      font: inherit;
      line-height: 1.2;
    }
    .oc-scheduled-jobs__button:hover {
      border-color: var(--oc-scheduled-jobs-border-strong);
      background: var(--oc-scheduled-jobs-panel-strong);
    }
    .oc-scheduled-jobs__button--primary {
      border-color: var(--oc-scheduled-jobs-accent);
      background: var(--oc-scheduled-jobs-accent);
      color: var(--v2-text-text-inverse, #ffffff);
    }
    .oc-scheduled-jobs__button--danger {
      border-color: var(--oc-scheduled-jobs-danger);
      background: transparent;
      color: var(--oc-scheduled-jobs-danger);
    }
    .oc-scheduled-jobs__row {
      display: block;
      align-items: stretch;
      margin: 2px 0;
    }
    .oc-scheduled-jobs__row.is-active .oc-scheduled-jobs__button--row-main {
      border-color: var(--oc-scheduled-jobs-accent);
      background: var(--oc-scheduled-jobs-panel-strong);
    }
    .oc-scheduled-jobs__button--row-main {
      width: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 2px;
      padding: 8px;
      text-align: left;
      background: transparent;
    }
    .oc-scheduled-jobs__row-title,
    .oc-scheduled-jobs__row-description,
    .oc-scheduled-jobs__row-policy,
    .oc-scheduled-jobs__row-subtitle,
    .oc-scheduled-jobs__row-path {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .oc-scheduled-jobs__row-title {
      color: var(--oc-scheduled-jobs-text-strong);
      font-weight: 700;
    }
    .oc-scheduled-jobs__row-description {
      color: var(--oc-scheduled-jobs-text-muted);
      font-size: 12px;
    }
    .oc-scheduled-jobs__row-policy {
      font-size: 11px;
    }
    .oc-scheduled-jobs__row-policy.is-unresolved {
      color: var(--oc-scheduled-jobs-danger);
    }
    .oc-scheduled-jobs__row-policy.is-exception {
      color: var(--oc-scheduled-jobs-text-muted);
    }
    .oc-scheduled-jobs__row-subtitle {
      color: var(--oc-scheduled-jobs-success);
      font-size: 12px;
    }
    .oc-scheduled-jobs__row-path {
      color: var(--oc-scheduled-jobs-text-muted);
      font-size: 11px;
    }
    .oc-scheduled-jobs__detail {
      flex: 1;
      padding: 14px;
    }
    .oc-scheduled-jobs__detail-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    .oc-scheduled-jobs__detail-heading {
      min-width: 0;
    }
    .oc-scheduled-jobs h3,
    .oc-scheduled-jobs h4,
    .oc-scheduled-jobs p {
      margin: 0;
    }
    .oc-scheduled-jobs h3 {
      color: var(--oc-scheduled-jobs-text-strong);
      font-size: 15px;
    }
    .oc-scheduled-jobs h4 {
      margin-bottom: 6px;
      color: var(--oc-scheduled-jobs-accent);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .oc-scheduled-jobs__detail-heading p {
      margin-top: 2px;
      color: var(--oc-scheduled-jobs-text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .oc-scheduled-jobs__info {
      display: grid;
      grid-template-columns: minmax(90px, auto) minmax(0, 1fr);
      gap: 6px 12px;
      margin: 12px 0;
      padding: 10px;
      border: 1px solid var(--oc-scheduled-jobs-border);
      border-radius: 7px;
      background: var(--oc-scheduled-jobs-panel);
    }
    .oc-scheduled-jobs__info dt,
    .oc-scheduled-jobs__info dd {
      min-width: 0;
      margin: 0;
    }
    .oc-scheduled-jobs__info dt {
      color: var(--oc-scheduled-jobs-accent);
      font-weight: 700;
    }
    .oc-scheduled-jobs__info dd {
      color: var(--oc-scheduled-jobs-text);
      overflow-wrap: anywhere;
    }
    .oc-scheduled-jobs__section {
      margin-top: 12px;
      padding: 10px;
      border: 1px solid var(--oc-scheduled-jobs-border);
      border-radius: 7px;
      background: var(--oc-scheduled-jobs-panel);
    }
    .oc-scheduled-jobs__section p,
    .oc-scheduled-jobs__section pre {
      color: var(--oc-scheduled-jobs-text);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .oc-scheduled-jobs__section pre {
      max-height: 280px;
      overflow: auto;
      font-size: 12px;
    }
    .oc-scheduled-jobs__section.is-error p {
      color: var(--oc-scheduled-jobs-danger);
    }
    .oc-scheduled-jobs__form {
      display: grid;
      gap: 10px;
      margin: 12px 0;
    }
    .oc-scheduled-jobs__field {
      display: grid;
      gap: 4px;
    }
    .oc-scheduled-jobs__field label {
      color: var(--oc-scheduled-jobs-accent);
      font-size: 12px;
      font-weight: 700;
    }
    .oc-scheduled-jobs__field-help {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      margin-left: 6px;
      border: 1px solid var(--oc-scheduled-jobs-border);
      border-radius: 999px;
      color: var(--oc-scheduled-jobs-text-muted);
      font-size: 10px;
      line-height: 1;
      vertical-align: middle;
    }
    .oc-scheduled-jobs__field input:disabled,
    .oc-scheduled-jobs__field select:disabled {
      color: var(--oc-scheduled-jobs-text-muted);
      opacity: 0.7;
    }
    .oc-scheduled-jobs__model-policy {
      display: grid;
      gap: 8px;
      padding: 10px;
      border: 1px solid var(--oc-scheduled-jobs-border-strong);
      border-radius: 7px;
      background: var(--oc-scheduled-jobs-panel);
    }
    .oc-scheduled-jobs__model-policy-status {
      font-size: 12px;
    }
    .oc-scheduled-jobs__model-policy-status.is-unresolved {
      color: var(--oc-scheduled-jobs-danger);
    }
    .oc-scheduled-jobs__model-policy-status.is-confirmed {
      color: var(--oc-scheduled-jobs-success);
    }
    .oc-scheduled-jobs__schedule-field {
      gap: 8px;
      padding: 10px;
      border: 1px solid var(--oc-scheduled-jobs-border);
      border-radius: 7px;
      background: var(--oc-scheduled-jobs-panel);
    }
    .oc-scheduled-jobs__schedule-controls,
    .oc-scheduled-jobs__cron-row,
    .oc-scheduled-jobs__prompt-generate {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      align-items: end;
    }
    .oc-scheduled-jobs__cron-row {
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
    }
    .oc-scheduled-jobs__shell-generate {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: start;
    }
    .oc-scheduled-jobs__shell-generate textarea {
      min-height: 160px;
    }
    .oc-scheduled-jobs__prompt-generate {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .oc-scheduled-jobs__form-control {
      min-width: 0;
      display: grid;
      gap: 4px;
    }
    .oc-scheduled-jobs__form-control > span {
      color: var(--oc-scheduled-jobs-accent);
      font-size: 11px;
      font-weight: 700;
    }
    .oc-scheduled-jobs__form-control small,
    .oc-scheduled-jobs__hint {
      color: var(--oc-scheduled-jobs-text-muted);
      font-size: 11px;
    }
    .oc-scheduled-jobs__select {
      position: relative;
      min-width: 0;
    }
    .oc-scheduled-jobs__select-trigger {
      width: 100%;
      min-width: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--oc-scheduled-jobs-border-strong);
      border-radius: 6px;
      background: var(--oc-scheduled-jobs-panel);
      color: var(--oc-scheduled-jobs-text-strong);
      padding: 7px 9px;
      font: inherit;
      font-weight: 650;
      text-align: left;
      cursor: pointer;
      outline: none;
    }
    .oc-scheduled-jobs__select-trigger:hover,
    .oc-scheduled-jobs__select.is-open .oc-scheduled-jobs__select-trigger {
      border-color: var(--oc-scheduled-jobs-border-strong);
      background: var(--oc-scheduled-jobs-panel-strong);
    }
    .oc-scheduled-jobs__select-trigger:focus {
      border-color: var(--oc-scheduled-jobs-accent);
      box-shadow: 0 0 0 1px var(--oc-scheduled-jobs-accent);
    }
    .oc-scheduled-jobs__select-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .oc-scheduled-jobs__checkbox {
      min-width: 0;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--oc-scheduled-jobs-accent);
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
    }
    .oc-scheduled-jobs__checkbox input {
      width: 16px;
      height: 16px;
      margin: 0;
      accent-color: var(--oc-scheduled-jobs-accent);
    }
    .oc-scheduled-jobs__checkbox span {
      min-width: 0;
    }
    .oc-scheduled-jobs__select-chevron {
      width: 8px;
      height: 8px;
      border-right: 1.5px solid currentColor;
      border-bottom: 1.5px solid currentColor;
      opacity: 0.9;
      transform: translateY(-2px) rotate(45deg);
    }
    .oc-scheduled-jobs__select-menu {
      --oc-scheduled-jobs-panel: var(--v2-background-bg-layer-02, var(--color-background-stronger, #0b1220));
      --oc-scheduled-jobs-panel-strong: var(--v2-background-bg-layer-03, var(--color-fill-element, #1f2937));
      --oc-scheduled-jobs-text: var(--v2-text-text-base, var(--color-text, #e5e7eb));
      --oc-scheduled-jobs-text-strong: var(--v2-text-text-base, var(--color-text-strong, #f8fafc));
      --oc-scheduled-jobs-text-muted: var(--v2-text-text-muted, var(--color-text-weak, #9ca3af));
      --oc-scheduled-jobs-accent: var(--v2-text-text-accent, var(--color-primary, #60a5fa));
      --oc-scheduled-jobs-border-strong: var(--v2-border-border-strong, var(--color-divider, rgba(148, 163, 184, 0.42)));
      position: fixed;
      z-index: 10000;
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 6px;
      overflow: hidden;
      border: 1px solid var(--oc-scheduled-jobs-border-strong);
      border-radius: 6px;
      background: var(--v2-background-bg-layer-01, #020817);
      box-shadow: 0 18px 45px rgba(0, 0, 0, 0.35);
    }
    .oc-scheduled-jobs__select-menu[hidden] {
      display: none;
    }
    .oc-scheduled-jobs__select-search {
      width: 100%;
      flex: 0 0 auto;
      margin-bottom: 4px;
      border-color: transparent;
      background: var(--oc-scheduled-jobs-panel-strong);
      color: var(--oc-scheduled-jobs-text);
      padding: 7px 9px;
      border-radius: 6px;
      font: inherit;
      outline: none;
    }
    .oc-scheduled-jobs__select-search:focus {
      border-color: var(--oc-scheduled-jobs-accent);
      box-shadow: 0 0 0 1px var(--oc-scheduled-jobs-accent);
    }
    .oc-scheduled-jobs__select-options {
      min-height: 0;
      overflow: auto;
      display: grid;
      gap: 2px;
    }
    .oc-scheduled-jobs__select-empty {
      padding: 10px 8px;
      color: var(--oc-scheduled-jobs-text-muted);
      font-size: 12px;
    }
    .oc-scheduled-jobs__select-empty[hidden] {
      display: none;
    }
    .oc-scheduled-jobs__select-option {
      width: 100%;
      display: grid;
      gap: 2px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--oc-scheduled-jobs-text-strong);
      padding: 8px;
      font: inherit;
      font-weight: 650;
      text-align: left;
      cursor: pointer;
      outline: none;
    }
    .oc-scheduled-jobs__select-option:hover,
    .oc-scheduled-jobs__select-option:focus,
    .oc-scheduled-jobs__select-option.is-selected {
      background: var(--oc-scheduled-jobs-panel-strong);
    }
    .oc-scheduled-jobs__select-option-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .oc-scheduled-jobs__select-option-description {
      min-width: 0;
      overflow: hidden;
      color: var(--oc-scheduled-jobs-text-muted);
      font-size: 11px;
      font-weight: 500;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .oc-scheduled-jobs__generate {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
    }
    .oc-scheduled-jobs__generate img {
      width: 14px;
      height: 14px;
    }
    .oc-scheduled-jobs__generated {
      color: var(--oc-scheduled-jobs-success);
      font-size: 12px;
    }
    .oc-scheduled-jobs__danger {
      flex: 0 0 auto;
      padding: 8px;
      border-bottom: 1px solid var(--oc-scheduled-jobs-border);
      color: var(--oc-scheduled-jobs-danger);
    }
    .oc-scheduled-jobs__empty {
      padding: 16px;
      color: var(--oc-scheduled-jobs-text-muted);
      text-align: center;
    }
    @media (max-width: 620px) {
      .oc-scheduled-jobs__config {
        min-height: 130px;
      }
      .oc-scheduled-jobs__detail-top {
        display: grid;
      }
      .oc-scheduled-jobs__shell-generate {
        grid-template-columns: minmax(0, 1fr);
      }
    }
  `
  return style
}
