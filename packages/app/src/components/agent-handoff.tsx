import { Button } from "@opencode-ai/ui/button"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { Icon } from "@opencode-ai/ui/icon"
import { Show, createEffect, createMemo, createSignal } from "solid-js"
import { SettingsModelTargetPickerV2 } from "@/components/settings-model-target-picker"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useSync } from "@/context/sync"
import { useLocal } from "@/context/local"
import { usePlatform } from "@/context/platform"
import { authTokenFromCredentials } from "@/utils/server"
import { showToast } from "@/utils/toast"
import { uuid } from "@/utils/uuid"
import type { HandoffRequestIdentity } from "@/utils/handoff-request"
import type { SwitchAgentAndPromptStep } from "@/components/control-surface-runtime"
import type { SessionSelectionHandoffSnapshot } from "@/context/session-selection-handoff"
import {
  implementationModelPreferenceKey,
  initialHandoffModelMode,
  initialImplementationModel,
  readImplementationModelPreference,
  resolveHandoffModelTarget,
  writeImplementationModelPreference,
  type StoredImplementationModel,
} from "@/components/agent-handoff-model"

export type AgentHandoffAction = {
  id: string
  target: { kind: "request"; id: string; revision: number; token: string }
}

// Renders the agent-switch confirmation inline inside the session dock (like the
// on-demand-ui / question surface) instead of as a floating modal dialog. A
// missing action means there is no Surface approval token, so the form stays
// visible but blocked; the caller decides whether to offer another route.
export function AgentHandoffForm(props: {
  sessionID: string
  step: SwitchAgentAndPromptStep
  action?: AgentHandoffAction
  planningModel?: StoredImplementationModel
  planningMessageID?: string
  onComplete?: (request: HandoffRequestIdentity) => void | Promise<void>
  onCancel?: () => void
}) {
  const sdk = useSDK()
  const local = useLocal()
  const sync = useSync()
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const planning = createMemo(() => {
    if (props.planningModel) return props.planningModel
    const message = (sync().data.message[props.sessionID] ?? []).find((item) => item.id === props.planningMessageID)
    if (!message || message.role !== "assistant") return
    return { ref: `${message.providerID}/${message.modelID}`, variant: message.variant }
  })
  const preferenceKey = implementationModelPreferenceKey(serverSDK().scope, sdk().directory, props.step.agent)
  const remembered = readImplementationModelPreference(localStorage, preferenceKey)
  const supplied = props.step.model?.mode === "implementation-model" && props.step.model.ref
    ? { ref: props.step.model.ref, variant: props.step.model.variant }
    : undefined
  const target = createMemo(() =>
    sync().data.agent.find((item) => item.name === props.step.agent && item.mode !== "subagent" && !item.hidden),
  )
  const initialImplementation = createMemo(() => {
    const agent = target()
    // Only an explicitly configured agent model target outranks the global
    // default chain. A model merely derived from the agent falls back below
    // it, so "Use implementation default" stays the configured default chain
    // instead of duplicating the planning-model radio's agent model.
    const explicit = agent?.modelTarget
      ? { ref: agent.modelTarget, ...(agent?.variant && !agent.model?.chain ? { variant: agent.variant } : {}) }
      : undefined
    return initialImplementationModel(
      supplied,
      sync().data.config.model ? { ref: `model:${sync().data.config.model}` } : remembered,
      local.model.chain.default(),
      explicit,
    )
  })
  const [mode, setMode] = createSignal<"planning-model" | "implementation-model">(
    initialHandoffModelMode(props.step.model?.mode, initialImplementation()),
  )
  const [implementation, setImplementation] = createSignal<StoredImplementationModel | undefined>(initialImplementation())
  const [changed, setChanged] = createSignal(false)
  createEffect(() => {
    const next = initialImplementation()
    if (changed()) return
    setImplementation(next)
    setMode(initialHandoffModelMode(props.step.model?.mode, next))
  })
  const [warningOpen, setWarningOpen] = createSignal(false)
  const [promptOpen, setPromptOpen] = createSignal(false)
  const [sending, setSending] = createSignal(false)
  const [started, setStarted] = createSignal(false)
  const [error, setError] = createSignal("")
  const selected = createMemo(() => mode() === "planning-model" ? planning() : implementation())
  const ready = createMemo(() => !!target() && !!selected() && !!props.step.prompt.trim())
  const canSubmit = createMemo(() => ready() && !!props.action && !sending() && !started())

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const action = props.action
    const agent = props.step.agent
    const sessionID = props.sessionID
    const prompt = props.step.prompt
    const onComplete = props.onComplete
    const model = selected()
    if (!canSubmit() || !action || !model) return
    const completion = {
      directory: sdk().directory,
      sessionID,
      requestID: action.target.id,
    }
    const resolved = resolveHandoffModelTarget(model.ref, model.variant, local.model.chain.list())
    if (!resolved) {
      setError("Choose a valid model before starting the next turn.")
      return
    }
    // The exact confirmed selection; every composer of this session adopts it
    // through the shared handoff owner without a second switch mutation.
    const snapshot: SessionSelectionHandoffSnapshot = "chain" in resolved && resolved.chain
      ? { agent, chainID: resolved.chain.id }
      : { agent, model: { providerID: resolved.providerID, modelID: resolved.id }, variant: resolved.variant ?? null }
    if (!local.session.handoff.begin(sessionID, snapshot)) {
      setError("An agent switch for this session is already running.")
      return
    }
    setSending(true)
    setError("")
    try {
      // Serialized picker writes started before the lock must settle first; a
      // rejected write means the switch was not started.
      await local.session.settled()
    } catch (cause) {
      local.session.handoff.fail(sessionID)
      setSending(false)
      setError(`A pending selection write failed; the switch was not started: ${cause instanceof Error ? cause.message : String(cause)}`)
      return
    }
    try {
      const headers = new Headers({ "content-type": "application/json", "x-opencode-directory": sdk().directory })
      const http = serverSDK().server.http
      if (http.password) headers.set("authorization", `Basic ${authTokenFromCredentials({ username: http.username, password: http.password })}`)
      const response = await (platform.fetch ?? fetch)(
        new URL(`/api/session/${encodeURIComponent(sessionID)}/switch-agent-and-prompt`, sdk().url),
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent,
            model: resolved,
            prompt: { text: prompt },
            confirmation: {
              requestID: action.target.id,
              revision: action.target.revision,
              actionID: action.id,
              invocationID: uuid(),
              token: action.target.token,
            },
          }),
        },
      )
      if (!response.ok) throw new Error((await response.text()) || response.statusText)
    } catch (cause) {
      // A transport-level rejection leaves the server outcome unknown: no retry,
      // a visible uncertain state, and a targeted canonical read to converge.
      if (cause instanceof TypeError) {
        local.session.handoff.uncertain(sessionID)
        void sync().session.info(sessionID, { force: true })
        setError(`The switch request did not complete; checking the session state: ${cause.message}`)
      } else {
        local.session.handoff.fail(sessionID)
        setError(cause instanceof Error ? cause.message : String(cause))
      }
      setSending(false)
      return
    }

    let cleanup: void | Promise<void> = undefined
    try {
      cleanup = onComplete?.(completion)
    } catch (cause) {
      showToast({
        variant: "error",
        title: "Agent switch started; cleanup failed",
        description: cause instanceof Error ? cause.message : String(cause),
      })
    }
    setStarted(true)
    try {
      local.session.handoff.commit(sessionID, snapshot)
      local.session.restore(
        {
          sessionID,
          agent,
          model: {
            providerID: resolved.providerID,
            modelID: resolved.id,
            variant: resolved.variant,
            chain: "chain" in resolved ? resolved.chain : undefined,
          },
        },
        { force: true },
      )
      if (mode() === "implementation-model") writeImplementationModelPreference(localStorage, preferenceKey, model)
    } catch (cause) {
      setError(`Started ${agent}, but local session state could not be updated: ${cause instanceof Error ? cause.message : String(cause)}`)
    }

    showToast({ title: `Started ${agent}` })
    try {
      await cleanup
    } catch (cause) {
      showToast({
        variant: "error",
        title: "Agent switch started; cleanup failed",
        description: cause instanceof Error ? cause.message : String(cause),
      })
    } finally {
      setSending(false)
    }
  }

  return (
    <form class="flex min-w-0 flex-col gap-2" onSubmit={submit} data-component="agent-handoff">
      <div data-component="agent-handoff-safety-warning">
        <Collapsible variant="ghost" open={warningOpen()} onOpenChange={setWarningOpen}>
          <Collapsible.Trigger
            class="gap-2 rounded-md border border-border-warning-base bg-v2-state-bg-warning px-3 py-1.5 text-left"
            style={{ height: "auto" }}
          >
            <strong class="text-xs tracking-[0.08em] text-text-warning-base">⚠ AGENT SWITCH REQUEST</strong>
            <span class="min-w-0 flex-1 truncate text-xs text-text-weak">Security details</span>
            <span
              class="flex shrink-0 transition-transform"
              style={{ transform: warningOpen() ? "rotate(180deg)" : undefined }}
              aria-hidden="true"
            >
              <Icon name="chevron-down" size="small" />
            </span>
          </Collapsible.Trigger>
          <Collapsible.Content>
            <div
              role="alert"
              class="mt-1 flex flex-col gap-1 rounded-md border border-border-warning-base bg-v2-state-bg-warning px-3 py-2"
            >
              <strong class="text-sm">Verify this security-sensitive action</strong>
              <span class="text-xs text-text-weak">
                You are about to change the active agent and start a new turn. The target, prompt, and model below cannot be hidden by the requesting AI.
              </span>
            </div>
          </Collapsible.Content>
        </Collapsible>
      </div>
      <div data-component="on-demand-expectation" data-action-needed="true">
        Expected: confirm the target agent, exact prompt, and model for the next turn.
      </div>
      <Show when={!props.action}>
        <div
          role="alert"
          class="rounded-md border border-border-warning-base bg-v2-state-bg-warning px-3 py-2 text-xs"
        >
          Switch requests without a Surface approval token stay blocked. Open the source session to handle them.
        </div>
      </Show>
      <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border-warning-base bg-background-base px-3 py-2"><span class="text-xs text-text-weak">Requested target agent</span><strong class="text-sm text-text-base">{props.step.agent}</strong><Show when={!target()}><span class="text-xs text-danger">This agent is hidden, unavailable, or not a primary agent.</span></Show></div>
      <div data-component="agent-handoff-prompt">
        <Collapsible variant="ghost" open={promptOpen()} onOpenChange={setPromptOpen}>
          <Collapsible.Trigger
            class="gap-2 rounded-md border border-border-weak-base bg-background-weak px-3 py-1.5 text-left"
            style={{ height: "auto" }}
          >
            <span class="shrink-0 text-xs text-text-weak">Exact start prompt</span>
            <span class="min-w-0 flex-1 whitespace-normal break-words text-xs text-text-base">{props.step.prompt}</span>
            <span
              class="flex shrink-0 transition-transform"
              style={{ transform: promptOpen() ? "rotate(180deg)" : undefined }}
              aria-hidden="true"
            >
              <Icon name="chevron-down" size="small" />
            </span>
          </Collapsible.Trigger>
          <Collapsible.Content>
            <pre class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border-weak-base bg-background-weak p-2 text-xs">{props.step.prompt}</pre>
          </Collapsible.Content>
        </Collapsible>
      </div>
      <fieldset class="flex min-w-0 flex-col gap-1.5"><legend class="mb-0.5 text-xs text-text-weak">Implementation model</legend>
        <label class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <input class="shrink-0" type="radio" name="handoff-model" disabled={!planning()} checked={mode() === "planning-model"} onChange={() => { setChanged(true); setMode("planning-model") }} />
          <span class="shrink-0">Use planning model</span>
          <Show
            when={planning()}
            fallback={<span class="w-full min-w-0 break-words pl-5 text-xs text-danger sm:w-auto sm:pl-0">(originating turn model unavailable)</span>}
          >
            {(item) => <span class="w-full min-w-0 break-all pl-5 text-xs text-text-weak sm:w-auto sm:pl-0">({item().ref}{item().variant ? ` · ${item().variant}` : ""})</span>}
          </Show>
        </label>
        <label class="flex items-center gap-2 text-sm"><input class="shrink-0" type="radio" name="handoff-model" checked={mode() === "implementation-model"} onChange={() => { setChanged(true); setMode("implementation-model") }} />Use implementation default</label>
        <Show when={mode() === "implementation-model"}><div class="rounded-md border border-border-weak-base p-2"><SettingsModelTargetPickerV2 value={implementation()?.ref ?? ""} label="Implementation model or chain" onChange={(ref) => { setChanged(true); setImplementation({ ref }) }} placeholder="Select model or chain" /></div></Show>
      </fieldset>
      <Show when={error()}><div class="text-xs text-danger">{error()}</div></Show>
      <div data-component="agent-handoff-actions" class="flex flex-wrap justify-end gap-2"><Button type="button" variant="ghost" size="normal" onClick={() => props.onCancel?.()}>Cancel — keep current agent</Button><Button type="submit" variant="primary" size="normal" disabled={!canSubmit()}>{sending() ? "Starting…" : props.step.agent === "build" ? "Switch to build and implement" : props.step.agent === "plan" ? "Switch to plan and start planning" : `Switch to ${props.step.agent} and start`}</Button></div>
    </form>
  )
}
