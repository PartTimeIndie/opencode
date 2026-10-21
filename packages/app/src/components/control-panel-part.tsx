import { Button } from "@opencode-ai/ui/button"
import { Markdown } from "@opencode-ai/ui/markdown"
import { createMemo, createSignal, createUniqueId, For, Match, onCleanup, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { authTokenFromCredentials } from "@/utils/server"
import type { CustomPart } from "@/plugin/custom-part"
import { ExplorableReview, type ExplorableSection, type ExplorableVariant } from "@/components/explorable-review"
import { OnDemandDiff } from "@/components/on-demand-diff"
import { LocalMediaSource } from "@/components/local-media-source"
import { OnDemandExpectation } from "@/components/on-demand-surface"
import { AgentHandoffForm } from "@/components/agent-handoff"
import { controlPanelExpectation, controlPanelTitle, splitControlPanelControls } from "@/utils/control-panel-presentation"
import {
  agentHandoffPresentation,
  agentHandoffStep,
  actionHint,
  actionStatusLabel,
  containsAgentHandoff,
  evaluateSurfaceExpression,
  isClientExecutableSurfaceAction,
  matchingSurfaceActions,
  setValuePath,
  surfaceStyle,
  surfaceTargetValue,
  type ConfigTarget,
  type SurfaceAction,
  type SurfaceActionStep,
  type SurfaceEffect,
} from "@/components/control-surface-runtime"

type Option = {
  id?: string
  label: string
  description?: string
  tooltip?: string
  pros?: string[]
  cons?: string[]
  details?: unknown
}

type Control = {
  id: string
  type: string
  label: string
  description?: string
  tooltip?: string
  markdown?: string
  options?: Option[]
  recommended?: string
  recommendedOptions?: string[]
  allowOther?: boolean
  allowFeedback?: boolean
  min?: number
  max?: number
  step?: number
  defaultValue?: unknown
  value?: unknown
  placeholder?: string
  language?: string
  content?: string
  sections?: ExplorableSection[]
  before?: string
  after?: string
  filePath?: string
  emojis?: string[]
  src?: string
  poster?: string
}

type PartData = {
  version: 1
  controlID: string
  title?: string
  markdown?: string
  controls: Control[]
  values?: Record<string, unknown>
  effects?: SurfaceEffect[]
  actions?: SurfaceAction[]
}

type SaveState = { status: "idle" | "saving" | "saved" | "error"; message?: string }

const numericTypes = new Set(["slider", "number_stepper", "duration", "range", "scrubber"])
const selectTypes = new Set([
  "pick_one",
  "confirm",
  "show_options",
  "thumbs",
  "emoji_react",
  "select",
  "segmented",
  "radio_group",
  "loop_type",
  "blend_mode",
])
const multiTypes = new Set(["pick_many", "checkbox_group"])
const textTypes = new Set(["ask_text", "ask_code", "ask_file", "ask_image", "file_picker", "asset_picker"])
const textActionDebounceMs = 220

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSurfaceEffect(value: unknown): value is SurfaceEffect {
  return isRecord(value) && typeof value.id === "string" && typeof value.target === "string" && typeof value.value === "string"
}

function isSurfaceAction(value: unknown): value is SurfaceAction {
  return isRecord(value) && typeof value.id === "string" && isRecord(value.trigger) && Array.isArray(value.steps)
}

function readData(value: unknown): PartData | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.controlID !== "string" || !Array.isArray(value.controls)) return
  const controls = value.controls.filter((control): control is Control =>
    isRecord(control) && typeof control.id === "string" && typeof control.type === "string" && typeof control.label === "string",
  )
  return {
    version: 1,
    controlID: value.controlID,
    title: typeof value.title === "string" ? value.title : undefined,
    markdown: typeof value.markdown === "string" ? value.markdown : undefined,
    controls,
    values: isRecord(value.values) ? value.values : undefined,
    effects: Array.isArray(value.effects) ? (value.effects.filter(isSurfaceEffect) as SurfaceEffect[]) : undefined,
    actions: Array.isArray(value.actions) ? (value.actions.filter(isSurfaceAction) as SurfaceAction[]) : undefined,
  }
}

function optionKey(option: Option) {
  return option.id ?? option.label
}

function initialValue(data: PartData, control: Control) {
  const value = data.values?.[control.id] ?? control.value ?? control.defaultValue
  if (value !== undefined) return value
  if (multiTypes.has(control.type) || control.type === "rank") return []
  if (control.type === "rate") return Object.fromEntries((control.options ?? []).map((option) => [optionKey(option), control.min ?? 1]))
  if (control.type === "toggle") return false
  if (control.type === "vector2") return { x: 0, y: 0 }
  if (control.type === "vector3") return { x: 0, y: 0, z: 0 }
  if (numericTypes.has(control.type)) return control.min ?? 0
  if (control.type === "color") return "#ffffff"
  return ""
}

function textValue(value: unknown) {
  if (typeof value === "string") return value
  if (value === undefined || value === null) return ""
  return JSON.stringify(value, null, 2)
}

function numericValue(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function vectorValue(value: unknown, key: "x" | "y" | "z") {
  if (isRecord(value) && typeof value[key] === "number") return value[key]
  return 0
}

export function ControlPanelPart(props: {
  part: CustomPart
  actionTarget?: { kind: "request"; id: string; revision: number; token: string }
  hideTitle?: boolean
  onHandoffDecision?: () => void
  onValuesChange?: (values: Record<string, unknown>) => void
}) {
  const server = useServer()
  const sdk = useSDK()
  const platform = usePlatform()
  const sync = useSync()
  const data = createMemo(() => readData(props.part.data))
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingTasks = new Map<string, () => Promise<void>>()
  const [store, setStore] = createStore({ values: {} as Record<string, unknown>, saves: {} as Record<string, SaveState> })
  let disposed = false

  const value = (control: Control) => store.values[control.id] ?? (data() ? initialValue(data()!, control) : undefined)
  const saveState = (control: Control) => store.saves[control.id] ?? { status: "idle" as const }
  const values = () => Object.fromEntries((data()?.controls ?? []).map((control) => [control.id, value(control)]))
  const context = () => ({ values: values() })
  const planningModel = createMemo(() => {
    const message = (sync().data.message[props.part.sessionID] ?? []).find((item) => item.id === props.part.messageID)
    if (!message || message.role !== "assistant") return
    return { ref: `${message.providerID}/${message.modelID}`, variant: message.variant }
  })
  const split = createMemo(() => splitControlPanelControls(data()?.controls ?? []))
  const information = () => split().information
  const actions = () => split().actions
  const hasHandoff = () => data()?.actions?.some((action) => containsAgentHandoff(action)) === true
  const expectation = () =>
    hasHandoff()
      ? "Expected: confirm or cancel the requested agent switch."
      : controlPanelExpectation(data()?.controls ?? [])
  const changeActionFor = (control: Control) =>
    matchingSurfaceActions(data()?.actions, "change", control.id, values()).find((action) =>
      action.steps.some((step) => step.type === "configWrite" || step.type === "livePublish"),
    )
  const clickActionsFor = (control: Control, fallback: unknown = control.value ?? control.id) => {
    const nextValues = { ...values(), [control.id]: fallback }
    return matchingSurfaceActions(data()?.actions, "click", control.id, nextValues).filter(isClientExecutableSurfaceAction)
  }
  const clickActionFor = (control: Control) => clickActionsFor(control)[0]
  const handoffActionFor = (control: Control) =>
    matchingSurfaceActions(
      data()?.actions,
      "click",
      control.id,
      { ...values(), [control.id]: control.value ?? control.id },
    ).find((action) => containsAgentHandoff(action))

  const applyValue = (control: Control, next: unknown) => {
    const nextValues = { ...values(), [control.id]: next }
    setStore("values", control.id, next)
    props.onValuesChange?.(nextValues)
    for (const action of matchingSurfaceActions(data()?.actions, "change", control.id, nextValues)) {
      runAction(control, action, nextValues, next)
    }
  }

  const applyClick = (control: Control, fallback: unknown = control.value ?? control.id) => {
    const nextValues = { ...values(), [control.id]: fallback }
    for (const action of clickActionsFor(control, fallback)) {
      runAction(control, action, nextValues, fallback)
    }
  }

  const runAction = (control: Control, action: SurfaceAction, values: Record<string, unknown>, fallback: unknown) => {
    action.steps.forEach((step, index) => runActionStep(control, action, step, index, values, fallback))
  }

  const runActionStep = (
    control: Control,
    action: SurfaceAction,
    step: SurfaceActionStep,
    index: number,
    values: Record<string, unknown>,
    fallback: unknown,
  ) => {
    if (step.type === "setValue") {
      const nextValues = setValuePath(values, step.target, evaluateSurfaceExpression(step.value, { values }, fallback))
      const id = step.target.match(/^values\.([A-Za-z0-9_-]+)/)?.[1]
      if (id) {
        setStore("values", id, nextValues[id])
        props.onValuesChange?.(nextValues)
      }
      return
    }
    if (step.type === "configWrite") {
      schedule(control, `action:${control.id}:${action.id}:${index}`, actionDebounceMs(control, step, 120), () =>
        writeConfig(control, step.target, evaluateSurfaceExpression(step.value, { values }, fallback)),
      )
      return
    }
    if (step.type === "livePublish") {
      schedule(control, `action:${control.id}:${action.id}:${index}`, actionDebounceMs(control, step, 80), () =>
        publishLive(control, step.topic, evaluateSurfaceExpression(step.value, { values }, fallback)),
      )
      return
    }
  }

  const actionDebounceMs = (control: Control, step: Extract<SurfaceActionStep, { type: "configWrite" | "livePublish" }>, numericDefault: number) => {
    if (step.debounceMs !== undefined) return step.debounceMs
    if (numericTypes.has(control.type)) return numericDefault
    if (textTypes.has(control.type) || control.type === "color") return textActionDebounceMs
    return 0
  }

  const schedule = (control: Control, key: string, debounce: number, task: () => Promise<void>) => {
    const existing = timers.get(key)
    if (existing) clearTimeout(existing)
    pendingTasks.set(key, task)
    timers.set(
      key,
      setTimeout(() => {
        void runScheduled(control, key)
      }, debounce),
    )
  }

  const runScheduled = async (control: Control, key: string) => {
    const task = pendingTasks.get(key)
    if (!task) return
    timers.delete(key)
    pendingTasks.delete(key)
    setSave(control, { status: "saving" })
    await task()
  }

  const setSave = (control: Control, state: SaveState) => {
    if (disposed) return
    setStore("saves", control.id, state)
  }

  const writeConfig = async (control: Control, target: ConfigTarget, next: unknown) => {
    const conn = server.current
    if (!conn) {
      setSave(control, { status: "error", message: "No server connection" })
      return
    }
    try {
      const url = new URL(`${conn.http.url.replace(/\/+$/, "")}/api/control/config/apply`)
      url.searchParams.set("location[directory]", sdk().directory)
      const response = await (platform.fetch ?? fetch)(url.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(conn.http.password
            ? { Authorization: `Basic ${authTokenFromCredentials({ username: conn.http.username, password: conn.http.password })}` }
            : {}),
        },
        body: JSON.stringify({ target, value: next }),
      })
      if (!response.ok) throw new Error((await response.text()) || response.statusText)
      setSave(control, { status: "saved", message: target.path })
    } catch (error) {
      setSave(control, { status: "error", message: error instanceof Error ? error.message : String(error) })
    }
  }

  const publishLive = async (control: Control, topic: string | undefined, next: unknown) => {
    const conn = server.current
    if (!conn) {
      setSave(control, { status: "error", message: "No server connection" })
      return
    }
    try {
      const url = new URL(`${conn.http.url.replace(/\/+$/, "")}/api/control/live/publish`)
      url.searchParams.set("location[directory]", sdk().directory)
      const response = await (platform.fetch ?? fetch)(url.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(conn.http.password
            ? { Authorization: `Basic ${authTokenFromCredentials({ username: conn.http.username, password: conn.http.password })}` }
            : {}),
        },
        body: JSON.stringify({
          controlID: data()?.controlID ?? props.part.id,
          control: control.id,
          bridge: "session",
          topic,
          value: next,
        }),
      })
      if (!response.ok) throw new Error((await response.text()) || response.statusText)
      setSave(control, { status: "saved", message: topic ?? "live" })
    } catch (error) {
      setSave(control, { status: "error", message: error instanceof Error ? error.message : String(error) })
    }
  }

  onCleanup(() => {
    disposed = true
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    const tasks = Array.from(pendingTasks.values())
    pendingTasks.clear()
    for (const task of tasks) void task()
  })

  return (
    <Show
      when={data()}
      fallback={
        <div data-component="control-panel-card">
          <OnDemandExpectation
            text="Erwartet: Keine Aktion nötig"
            actionNeeded={false}
            slot="control-panel-expectation"
          />
          <div>Invalid Control Panel data</div>
        </div>
      }
    >
      {(part) => (
        <section data-component="control-panel-card" data-control-id={part().controlID}>
          <Show when={!props.hideTitle && (hasHandoff() || !!part().title)}>
            <div data-slot="control-panel-title">{controlPanelTitle(part().title, hasHandoff())}</div>
          </Show>
          <OnDemandExpectation
            text={expectation()}
            actionNeeded={actions().length > 0}
            slot="control-panel-expectation"
          />
          <Show when={part().markdown !== undefined && !information().some((control) => (control.markdown ?? control.content)?.trim() === part().markdown?.trim())}>
            <Markdown text={part().markdown ?? ""} cacheKey={`${props.part.id}:markdown`} />
          </Show>
          <Show when={information().length > 0}>
            <section data-slot="control-panel-information" aria-label="Information">
              <div data-slot="control-panel-section-title">Information</div>
              <div data-slot="control-panel-list">
                <For each={information()}>
                  {(control) => {
                    const handoff = handoffActionFor(control)
                    return handoff ? (
                      <AgentHandoffControl
                        action={handoff}
                        actionTarget={props.actionTarget}
                        sessionID={props.part.sessionID}
                        planningModel={planningModel()}
                        onDecision={props.onHandoffDecision}
                      />
                    ) : (
                      <ControlRow
                        control={control}
                        value={value(control)}
                        effects={part().effects}
                        context={context()}
                        state={saveState(control)}
                        action={changeActionFor(control) ?? clickActionFor(control)}
                        onValue={applyValue}
                        onClick={applyClick}
                        canClick={(target, fallback) => clickActionsFor(target, fallback).length > 0}
                      />
                    )
                  }}
                </For>
              </div>
            </section>
          </Show>
          <Show when={actions().length > 0}>
            <section data-slot="control-panel-actions" aria-label="Aktion erforderlich">
              <div data-slot="control-panel-section-title">Aktion erforderlich</div>
              <div data-slot="control-panel-list">
                <For each={actions()}>
                  {(control) => {
                    const handoff = handoffActionFor(control)
                    return handoff ? (
                      <AgentHandoffControl
                        action={handoff}
                        actionTarget={props.actionTarget}
                        sessionID={props.part.sessionID}
                        planningModel={planningModel()}
                        onDecision={props.onHandoffDecision}
                      />
                    ) : (
                      <ControlRow
                        control={control}
                        value={value(control)}
                        effects={part().effects}
                        context={context()}
                        state={saveState(control)}
                        action={changeActionFor(control) ?? clickActionFor(control)}
                        onValue={applyValue}
                        onClick={applyClick}
                        canClick={(target, fallback) => clickActionsFor(target, fallback).length > 0}
                      />
                    )
                  }}
                </For>
              </div>
            </section>
          </Show>
        </section>
      )}
    </Show>
  )
}

function AgentHandoffControl(props: {
  action: SurfaceAction
  actionTarget?: { kind: "request"; id: string; revision: number; token: string }
  sessionID: string
  planningModel?: { ref: string; variant?: string }
  onDecision?: () => void
}) {
  const step = () => agentHandoffStep(props.action)
  return (
    <Show
      when={step() && props.actionTarget}
      fallback={
        <div
          data-component="agent-handoff-request"
          data-state="blocked"
          role="alert"
          aria-label={agentHandoffPresentation.blockedTitle}
          class="flex min-w-0 flex-col gap-3 rounded-lg border-2 border-border-warning-selected bg-v2-state-bg-warning p-4 shadow-[0_0_0_1px_var(--border-warning-base),0_8px_24px_rgba(0,0,0,0.18)]"
        >
          <strong class="text-xs tracking-[0.12em] text-text-warning-base">
            ⚠ {agentHandoffPresentation.blockedBadge}
          </strong>
          <strong>{agentHandoffPresentation.blockedTitle}</strong>
          <span class="text-sm text-text-weak">{agentHandoffPresentation.blockedDescription}</span>
          <Button size="large" variant="secondary" disabled>
            Agent switch blocked
          </Button>
        </div>
      }
    >
      <AgentHandoffForm
        sessionID={props.sessionID}
        step={step()!}
        action={{ id: props.action.id, target: props.actionTarget! }}
        planningModel={props.planningModel}
        onCancel={props.onDecision}
        onComplete={props.onDecision}
      />
    </Show>
  )
}

function ControlRow(props: {
  control: Control
  value: unknown
  effects?: SurfaceEffect[]
  context: { values: Record<string, unknown> }
  state: SaveState
  action?: SurfaceAction
  onValue: (control: Control, value: unknown) => void
  onClick: (control: Control, value?: unknown) => void
  canClick: (control: Control, value?: unknown) => boolean
}) {
  const labelID = createUniqueId()
  const descriptionID = createUniqueId()
  const describedBy = () => (props.control.description ? descriptionID : undefined)

  return (
    <div
      data-slot="control-panel-row"
      data-control-type={props.control.type}
      title={props.control.tooltip?.trim() || undefined}
    >
      <div data-slot="control-panel-row-head">
        <div data-slot="control-panel-labels">
          <div id={labelID} data-slot="control-panel-label" title={props.control.tooltip?.trim() || undefined}>
            {props.control.label}
          </div>
          <Show when={props.control.description}>
            {(description) => (
              <div id={descriptionID} data-slot="control-panel-description">
                {description()}
              </div>
            )}
          </Show>
        </div>
        <Status state={props.state} action={props.action} />
      </div>
      <Show when={props.control.markdown}>
        {(markdown) => <Markdown text={markdown()} cacheKey={`${props.control.id}:markdown`} />}
      </Show>
      <Switch
        fallback={
          <JsonFallback
            control={props.control}
            value={props.value}
            labelID={labelID}
            descriptionID={describedBy()}
            onValue={props.onValue}
          />
        }
      >
        <Match when={selectTypes.has(props.control.type)}>
          <OptionButtons
            control={props.control}
            value={props.value}
            multi={false}
            labelID={labelID}
            descriptionID={describedBy()}
            onValue={props.onValue}
          />
        </Match>
        <Match when={multiTypes.has(props.control.type)}>
          <OptionButtons
            control={props.control}
            value={props.value}
            multi
            labelID={labelID}
            descriptionID={describedBy()}
            onValue={props.onValue}
          />
        </Match>
        <Match when={textTypes.has(props.control.type)}>
          <textarea
            data-slot="control-panel-input"
            data-kind={props.control.type}
            aria-labelledby={labelID}
            aria-describedby={describedBy()}
            rows={props.control.type === "ask_code" ? 8 : 3}
            value={textValue(props.value)}
            placeholder={props.control.placeholder}
            onInput={(event) => props.onValue(props.control, event.currentTarget.value)}
          />
        </Match>
        <Match when={numericTypes.has(props.control.type)}>
          <NumericControl
            control={props.control}
            value={props.value}
            labelID={labelID}
            descriptionID={describedBy()}
            onValue={props.onValue}
          />
        </Match>
        <Match when={props.control.type === "toggle"}>
          <button
            type="button"
            data-slot="control-panel-toggle"
            data-on={props.value === true}
            aria-labelledby={labelID}
            aria-describedby={describedBy()}
            aria-pressed={props.value === true}
            onClick={() => props.onValue(props.control, props.value !== true)}
          >
            {props.value === true ? "On" : "Off"}
          </button>
        </Match>
        <Match when={props.control.type === "color"}>
          <input
            data-slot="control-panel-color"
            type="color"
            aria-labelledby={labelID}
            aria-describedby={describedBy()}
            value={typeof props.value === "string" ? props.value : "#ffffff"}
            onInput={(event) => props.onValue(props.control, event.currentTarget.value)}
          />
        </Match>
        <Match when={props.control.type === "vector2" || props.control.type === "vector3"}>
          <VectorControl
            control={props.control}
            value={props.value}
            descriptionID={describedBy()}
            onValue={props.onValue}
          />
        </Match>
        <Match when={props.control.type === "image_preview"}>
          <ImagePreviewControl control={props.control} effects={props.effects} context={props.context} />
        </Match>
        <Match when={props.control.type === "video_preview" || props.control.type === "audio_preview"}>
          <MediaPreviewControl control={props.control} effects={props.effects} context={props.context} />
        </Match>
        <Match when={["show_plan", "review_section", "details", "accordion", "tabs", "object_tree", "table"].includes(props.control.type)}>
          <ReviewControl control={props.control} />
        </Match>
        <Match when={props.control.type === "show_diff"}>
          <OnDemandDiff filePath={props.control.filePath} before={props.control.before} after={props.control.after} />
        </Match>
        <Match
          when={[
            "button",
            "button_group",
            "command_trigger",
            "reset",
            "apply",
            "revert",
            "open_browser",
            "capture_screenshot",
          ].includes(props.control.type)}
        >
          <Show
            when={props.control.type === "button_group"}
            fallback={
              <Button size="small" variant="secondary" disabled={!props.canClick(props.control)} onClick={() => props.onClick(props.control)}>
                {props.control.label}
              </Button>
            }
          >
            <div
              data-slot="control-panel-options"
              role="group"
              aria-labelledby={labelID}
              aria-describedby={describedBy()}
            >
              <For each={props.control.options ?? []}>
                {(option) => (
                  <button
                    type="button"
                    data-slot="control-panel-option"
                    title={option.tooltip?.trim() || undefined}
                    disabled={!props.canClick(props.control, optionKey(option))}
                    onClick={() => props.onClick(props.control, optionKey(option))}
                  >
                    <span>{option.label}</span>
                    <Show when={option.description}>{(description) => <small>{description()}</small>}</Show>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </Match>
      </Switch>
      <ActionHint action={props.action} />
    </div>
  )
}

function OptionButtons(props: {
  control: Control
  value: unknown
  multi: boolean
  labelID: string
  descriptionID?: string
  onValue: (control: Control, value: unknown) => void
}) {
  const selected = (option: Option) => {
    const key = optionKey(option)
    if (props.multi && Array.isArray(props.value)) return props.value.includes(key)
    return props.value === key || props.value === option.label
  }
  return (
    <div
      data-slot="control-panel-options"
      data-multi={props.multi || undefined}
      role={props.multi ? "group" : "radiogroup"}
      aria-labelledby={props.labelID}
      aria-describedby={props.descriptionID}
    >
      <For each={props.control.options ?? props.control.emojis?.map((label): Option => ({ label })) ?? []}>
        {(option) => (
          <button
            type="button"
            data-slot="control-panel-option"
            data-selected={selected(option)}
            role={props.multi ? "checkbox" : "radio"}
            aria-checked={selected(option)}
            title={option.tooltip?.trim() || undefined}
            onClick={() => {
              const key = optionKey(option)
              if (!props.multi) {
                props.onValue(props.control, key)
                return
              }
              const current = Array.isArray(props.value) ? props.value : []
              props.onValue(props.control, current.includes(key) ? current.filter((item) => item !== key) : [...current, key])
            }}
          >
            <span>{option.label}</span>
            <Show when={option.description}>
              {(description) => <small>{description()}</small>}
            </Show>
          </button>
        )}
      </For>
    </div>
  )
}

function NumericControl(props: {
  control: Control
  value: unknown
  labelID: string
  descriptionID?: string
  onValue: (control: Control, value: unknown) => void
}) {
  const fallback = props.control.min ?? 0
  const current = () => numericValue(props.value, fallback)
  return (
    <div data-slot="control-panel-number">
      <Show when={props.control.type === "slider" || props.control.type === "range" || props.control.type === "scrubber"}>
        <input
          type="range"
          aria-labelledby={props.labelID}
          aria-describedby={props.descriptionID}
          min={props.control.min ?? 0}
          max={props.control.max ?? 100}
          step={props.control.step ?? 1}
          value={current()}
          onInput={(event) => props.onValue(props.control, Number(event.currentTarget.value))}
        />
      </Show>
      <input
        data-slot="control-panel-input"
        type="number"
        aria-labelledby={props.labelID}
        aria-describedby={props.descriptionID}
        min={props.control.min}
        max={props.control.max}
        step={props.control.step ?? 1}
        value={current()}
        onInput={(event) => props.onValue(props.control, Number(event.currentTarget.value))}
      />
    </div>
  )
}

function VectorControl(props: {
  control: Control
  value: unknown
  descriptionID?: string
  onValue: (control: Control, value: unknown) => void
}) {
  const set = (key: "x" | "y" | "z", next: number) => {
    props.onValue(props.control, { ...(isRecord(props.value) ? props.value : {}), [key]: next })
  }
  return (
    <div data-slot="control-panel-vector">
      <For each={props.control.type === "vector3" ? (["x", "y", "z"] as const) : (["x", "y"] as const)}>
        {(key) => (
          <label>
            <span>{key}</span>
            <input
              type="number"
              aria-label={`${props.control.label} ${key}`}
              aria-describedby={props.descriptionID}
              value={vectorValue(props.value, key)}
              onInput={(event) => set(key, Number(event.currentTarget.value))}
            />
          </label>
        )}
      </For>
    </div>
  )
}

function ImagePreviewControl(props: { control: Control; effects?: SurfaceEffect[]; context: { values: Record<string, unknown> } }) {
  const src = () => String(surfaceTargetValue(props.effects, `ui.${props.control.id}.src`, props.context) ?? props.control.src ?? "")
  const style = () => surfaceStyle(props.effects, props.control.id, props.context)
  return (
    <div data-slot="control-panel-media-preview" data-media="image">
      <LocalMediaSource source={src()} fallback={<div data-slot="control-panel-media-empty">No image selected</div>}>
        {(value) => <img data-slot="control-panel-image" src={value()} alt={props.control.label} style={style()} />}
      </LocalMediaSource>
    </div>
  )
}

function MediaPreviewControl(props: { control: Control; effects?: SurfaceEffect[]; context: { values: Record<string, unknown> } }) {
  const src = () => String(surfaceTargetValue(props.effects, `ui.${props.control.id}.src`, props.context) ?? props.control.src ?? "")
  const poster = () => String(surfaceTargetValue(props.effects, `ui.${props.control.id}.poster`, props.context) ?? props.control.poster ?? "")
  return (
    <div data-slot="control-panel-media-preview" data-media={props.control.type === "audio_preview" ? "audio" : "video"}>
      <Show when={src()} fallback={<div data-slot="control-panel-media-empty">No media selected</div>}>
        {(value) => (
          <Show
            when={props.control.type === "audio_preview"}
            fallback={
              <video
                data-slot="control-panel-video"
                controls
                aria-label={props.control.label}
                src={value()}
                poster={poster() || undefined}
              />
            }
          >
            <audio data-slot="control-panel-audio" controls aria-label={props.control.label} src={value()} />
          </Show>
        )}
      </Show>
    </div>
  )
}

function ReviewControl(props: { control: Control }) {
  const variant = (): ExplorableVariant => {
    const type = props.control.type
    if (type === "accordion" || type === "details" || type === "tabs" || type === "object_tree" || type === "table") return type
    return "review"
  }
  return (
    <div data-slot="control-panel-review">
      <ExplorableReview
        markdown={props.control.markdown}
        content={props.control.content}
        sections={props.control.sections}
        variant={variant()}
        cacheKey={props.control.id}
      />
    </div>
  )
}

function JsonFallback(props: {
  control: Control
  value: unknown
  labelID: string
  descriptionID?: string
  onValue: (control: Control, value: unknown) => void
}) {
  return (
    <textarea
      data-slot="control-panel-input"
      aria-labelledby={props.labelID}
      aria-describedby={props.descriptionID}
      rows={4}
      value={textValue(props.value)}
      onChange={(event) => {
        try {
          props.onValue(props.control, JSON.parse(event.currentTarget.value))
        } catch {
          props.onValue(props.control, event.currentTarget.value)
        }
      }}
    />
  )
}

function Status(props: { state: SaveState; action?: SurfaceAction }) {
  return (
    <Show when={props.action || props.state.status !== "idle"}>
      <span
        data-slot="control-panel-status"
        data-status={props.state.status}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        title={props.state.message}
      >
        {props.state.status === "idle" ? actionStatusLabel(props.action) : props.state.status}
      </span>
    </Show>
  )
}

function ActionHint(props: { action?: SurfaceAction }) {
  const label = () => actionHint(props.action)
  return (
    <Show when={label()}>
      {(text) => (
        <div data-slot="control-panel-action">
          {text()}
        </div>
      )}
    </Show>
  )
}
