import { For, Show, createMemo, createSignal, type Component } from "solid-js"

// Feature 3 — Automations UI.
// Self-contained panel: weekly schedule editor (compiles to cron expressions),
// interval trigger, action configurator (send-to-session / new-session / cli),
// list with enable toggle, and run history. Designed to back `pages/automations`
// and to be driven against mocked `/automation` routes. The cron compilation is
// shared with the server-side scheduler contract (`trigger.expressions`).

export type ActionType = "session_command" | "new_session" | "cli"

export interface AutomationAction {
  type: ActionType
  // session_command
  session_id?: string
  prompt?: string
  // new_session
  agent?: string
  model?: string
  auto_focus?: boolean
  // cli
  command?: string
  args?: string[]
  cwd?: string
}

export type Trigger =
  | { type: "cron"; expressions: string[] }
  | { type: "interval"; seconds: number }

export interface Automation {
  id: string
  name: string
  enabled: boolean
  trigger: Trigger
  action: AutomationAction
  last_run_at?: number
  next_run_at?: number
}

export interface AutomationRun {
  id: string
  automation_id: string
  status: "running" | "succeeded" | "failed"
  exit_code?: number
  duration_ms?: number
  started_at: number
  output?: string
}

// Weekday editor state. DOW uses cron convention 0=Sunday .. 6=Saturday.
export const WEEKDAYS: { dow: number; label: string }[] = [
  { dow: 1, label: "Mon" },
  { dow: 2, label: "Tue" },
  { dow: 3, label: "Wed" },
  { dow: 4, label: "Thu" },
  { dow: 5, label: "Fri" },
  { dow: 6, label: "Sat" },
  { dow: 0, label: "Sun" },
]

export interface WeeklySchedule {
  // selected weekdays
  days: number[]
  // "HH:MM" entries
  times: string[]
}

// Compile a weekly schedule into one cron expression per (day, time).
export function compileWeekly(schedule: WeeklySchedule): string[] {
  const expressions: string[] = []
  for (const day of schedule.days) {
    for (const time of schedule.times) {
      const [h, m] = time.split(":")
      const hh = Number(h ?? 0)
      const mm = Number(m ?? 0)
      if (Number.isNaN(hh) || Number.isNaN(mm)) continue
      expressions.push(`${mm} ${hh} * * ${day}`)
    }
  }
  return expressions.sort()
}

const ACTION_LABEL: Record<ActionType, string> = {
  session_command: "Send to session",
  new_session: "Open new session",
  cli: "Run command (no LLM)",
}

function formatTs(ts?: number) {
  if (!ts) return "—"
  return new Date(ts).toLocaleString()
}

export const AutomationsPanel: Component<{
  automations: Automation[]
  runs?: AutomationRun[]
  onCreate?: (automation: Automation) => void
}> = (props) => {
  return (
    <div data-component="automations-panel" class="flex flex-col gap-4 p-4">
      <div class="flex items-center justify-between">
        <h2 class="text-16-strong text-text-strong">Automations</h2>
        <Show when={props.onCreate}>
          <button
            data-action="automation-new"
            class="rounded-md bg-accent-primary-base px-3 py-1.5 text-13-medium text-white hover:bg-accent-primary-base-hover"
          >
            New automation
          </button>
        </Show>
      </div>
      <For each={props.automations} fallback={<div class="text-14-regular text-text-weak">No automations yet.</div>}>
        {(automation) => <AutomationCard automation={automation} runs={props.runs?.filter((r) => r.automation_id === automation.id) ?? []} />}
      </For>
    </div>
  )
}

const AutomationCard: Component<{ automation: Automation; runs: AutomationRun[] }> = (props) => {
  const triggerSummary = createMemo(() => {
    const t = props.automation.trigger
    if (t.type === "interval") return `every ${t.seconds}s`
    return t.expressions.join(", ") || "—"
  })
  return (
    <div data-component="automation-card" data-automation-id={props.automation.id} class="rounded-lg border border-border-weak-base bg-surface-base p-3">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-14-medium text-text-strong">{props.automation.name}</span>
            <span
              class="rounded-full px-2 py-0.5 text-11-medium"
              classList={{
                "bg-accent-success-transparent-active text-accent-success-active": props.automation.enabled,
                "bg-surface-raised-base text-text-weak": !props.automation.enabled,
              }}
            >
              {props.automation.enabled ? "enabled" : "disabled"}
            </span>
          </div>
          <div class="mt-0.5 text-12-regular text-text-weak">
            <span data-slot="automation-trigger">{triggerSummary()}</span> · {ACTION_LABEL[props.automation.action.type]}
          </div>
        </div>
        <div class="text-right text-11-regular text-text-subtle">
          <div>last: {formatTs(props.automation.last_run_at)}</div>
          <div>next: {formatTs(props.automation.next_run_at)}</div>
        </div>
      </div>
      <Show when={props.runs.length > 0}>
        <div class="mt-2 border-t border-border-weak-base pt-2">
          <div class="mb-1 text-11-medium text-text-weak">Recent runs</div>
          <div class="flex flex-col gap-1">
            <For each={props.runs.slice(0, 3)}>
              {(run) => (
                <div data-run-id={run.id} class="flex items-center justify-between text-12-regular">
                  <span
                    classList={{
                      "text-accent-success-active": run.status === "succeeded",
                      "text-accent-danger-active": run.status === "failed",
                      "text-text-weak": run.status === "running",
                    }}
                  >
                    {run.status}
                  </span>
                  <span class="text-text-subtle">{formatTs(run.started_at)}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

// Interactive editor used by the "new automation" flow and the preview route.
export const AutomationEditor: Component<{
  initial?: Partial<{ name: string; schedule: WeeklySchedule; action: AutomationAction }>
  onSubmit?: (automation: Automation) => void
}> = (props) => {
  const [name, setName] = createSignal(props.initial?.name ?? "")
  const [days, setDays] = createSignal<number[]>(props.initial?.schedule?.days ?? [1, 2, 3, 4, 5])
  const [times, setTimes] = createSignal<string[]>(props.initial?.schedule?.times ?? ["09:00"])
  const [actionType, setActionType] = createSignal<ActionType>(props.initial?.action?.type ?? "cli")
  const [command, setCommand] = createSignal(props.initial?.action?.command ?? "bun")
  const [cwd, setCwd] = createSignal(props.initial?.action?.cwd ?? "")

  const compiled = createMemo(() => compileWeekly({ days: days(), times: times() }))

  const toggleDay = (dow: number) =>
    setDays((prev) => (prev.includes(dow) ? prev.filter((d) => d !== dow) : [...prev, dow]))

  const addTime = () => setTimes((prev) => [...prev, "12:00"])
  const removeTime = (idx: number) => setTimes((prev) => prev.filter((_, i) => i !== idx))
  const setTime = (idx: number, value: string) =>
    setTimes((prev) => prev.map((t, i) => (i === idx ? value : t)))

  const submit = () => {
    props.onSubmit?.({
      id: `auto_${Date.now()}`,
      name: name() || "Untitled",
      enabled: true,
      trigger: { type: "cron", expressions: compiled() },
      action: { type: actionType(), command: command(), args: [], cwd: cwd() },
    })
  }

  return (
    <div data-component="automation-editor" class="flex flex-col gap-3 rounded-lg border border-border-weak-base bg-surface-base p-3">
      <label class="flex flex-col gap-1">
        <span class="text-12-medium text-text-strong">Name</span>
        <input
          data-field="automation-name"
          class="rounded-md border border-border-weak-base bg-background-stronger px-2 py-1 text-13-regular text-text-strong"
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
        />
      </label>

      <div>
        <div class="mb-1 text-12-medium text-text-strong">Repeat on</div>
        <div class="flex flex-wrap gap-1.5">
          <For each={WEEKDAYS}>
            {(day) => (
              <button
                data-weekday={day.dow}
                class="rounded-md border px-2.5 py-1 text-12-medium"
                classList={{
                  "border-accent-primary-base bg-accent-primary-transparent-active text-accent-primary-active": days().includes(day.dow),
                  "border-border-weak-base bg-surface-base text-text-weak": !days().includes(day.dow),
                }}
                onClick={() => toggleDay(day.dow)}
              >
                {day.label}
              </button>
            )}
          </For>
        </div>
      </div>

      <div>
        <div class="mb-1 text-12-medium text-text-strong">Times</div>
        <div class="flex flex-col gap-1.5">
          <For each={times()}>
            {(time, idx) => (
              <div class="flex items-center gap-2">
                <input
                  type="time"
                  data-field="automation-time"
                  class="rounded-md border border-border-weak-base bg-background-stronger px-2 py-1 text-13-regular text-text-strong"
                  value={time}
                  onInput={(e) => setTime(idx(), e.currentTarget.value)}
                />
                <button data-action="time-remove" class="text-12-regular text-text-subtle hover:text-text-strong" onClick={() => removeTime(idx())}>
                  remove
                </button>
              </div>
            )}
          </For>
          <button data-action="time-add" class="self-start text-12-medium text-accent-primary-active hover:underline" onClick={addTime}>
            + Add time
          </button>
        </div>
      </div>

      <div class="rounded-md bg-background-stronger px-2 py-1.5">
        <span class="text-11-medium text-text-weak">Compiled cron: </span>
        <span data-slot="compiled-cron" class="text-11-regular text-text-strong">
          {compiled().join("  |  ") || "—"}
        </span>
      </div>

      <div>
        <div class="mb-1 text-12-medium text-text-strong">Action</div>
        <select
          data-field="automation-action-type"
          class="rounded-md border border-border-weak-base bg-background-stronger px-2 py-1 text-13-regular text-text-strong"
          value={actionType()}
          onChange={(e) => setActionType(e.currentTarget.value as ActionType)}
        >
          <option value="cli">Run command (no LLM)</option>
          <option value="session_command">Send to session</option>
          <option value="new_session">Open new session</option>
        </select>
        <Show when={actionType() === "cli"}>
          <div class="mt-1.5 flex flex-col gap-1">
            <input
              data-field="automation-command"
              class="rounded-md border border-border-weak-base bg-background-stronger px-2 py-1 text-13-regular text-text-strong"
              placeholder="command"
              value={command()}
              onInput={(e) => setCommand(e.currentTarget.value)}
            />
            <input
              data-field="automation-cwd"
              class="rounded-md border border-border-weak-base bg-background-stronger px-2 py-1 text-13-regular text-text-strong"
              placeholder="working directory (optional)"
              value={cwd()}
              onInput={(e) => setCwd(e.currentTarget.value)}
            />
          </div>
        </Show>
      </div>

      <button
        data-action="automation-submit"
        class="self-start rounded-md bg-accent-primary-base px-3 py-1.5 text-13-medium text-white hover:bg-accent-primary-base-hover"
        onClick={submit}
      >
        Save automation
      </button>
    </div>
  )
}
