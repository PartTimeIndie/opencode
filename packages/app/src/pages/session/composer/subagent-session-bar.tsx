import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Spinner } from "@opencode-ai/ui/spinner"
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { errorMessage } from "@/pages/layout/helpers"
import { showToast } from "@/utils/toast"

export function SubagentSessionBar(props: { sessionID: string; inputRef: (el: HTMLDivElement) => void; onOpenParent: () => void }) {
  const language = useLanguage()
  const sdk = useSDK()
  const sync = useSync()
  const [stopping, setStopping] = createSignal(false)

  const info = createMemo(() => sync().session.get(props.sessionID))
  const status = createMemo(() => sync().data.session_status[props.sessionID] ?? { type: "idle" as const })
  const latestAssistant = createMemo(() =>
    (sync().data.message[props.sessionID] ?? []).findLast(
      (message): message is AssistantMessage => message.role === "assistant",
    ),
  )
  const latestUser = createMemo(() =>
    (sync().data.message[props.sessionID] ?? []).findLast((message): message is UserMessage => message.role === "user"),
  )
  const agent = createMemo(() => info()?.agent ?? latestAssistant()?.agent ?? latestUser()?.agent ?? language.t("common.unknown"))
  const model = createMemo(() => {
    const assistant = latestAssistant()
    if (assistant?.providerID && assistant.modelID) return `${assistant.providerID}/${assistant.modelID}`
    const user = latestUser()
    if (user?.model.providerID && user.model.modelID) return `${user.model.providerID}/${user.model.modelID}`
    const sessionModel = info()?.model
    if (sessionModel?.providerID && sessionModel.id) return `${sessionModel.providerID}/${sessionModel.id}`
    return language.t("session.child.unknownModel")
  })
  const variant = createMemo(
    () => latestAssistant()?.variant ?? latestUser()?.model.variant ?? info()?.model?.variant ?? language.t("common.default"),
  )
  const active = createMemo(() => status().type !== "idle")
  const stopDisabled = createMemo(() => !active() || stopping())
  const statusLabel = createMemo(() => {
    if (stopping()) return language.t("session.child.status.stopping")
    if (status().type === "retry") return language.t("session.child.status.retrying")
    if (status().type === "busy") return language.t("session.child.status.running")
    return language.t("session.child.status.idle")
  })

  createEffect(() => {
    if (!active()) setStopping(false)
  })

  const stop = () => {
    if (stopDisabled()) return
    setStopping(true)
    sdk()
      .client.v2.session.interrupt({ sessionID: props.sessionID })
      .catch((err: unknown) => {
        showToast({ title: language.t("common.requestFailed"), description: errorMessage(err, language.t("common.requestFailed")) })
        setStopping(false)
      })
  }

  return (
    <div
      ref={props.inputRef}
      data-component="subagent-session-bar"
      data-state={status().type}
      class="w-full rounded-[12px] border border-border-weak-base bg-background-base p-3 text-text-base shadow-xs-border"
    >
      <div class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <span class="rounded-md bg-surface-base px-2 py-1 text-12-medium text-text-weak">
              {language.t("session.child.readOnly")}
            </span>
            <span data-slot="subagent-status" class="flex items-center gap-1 text-12-medium text-text-weak">
              <Show when={active()}>
                <Spinner class="size-3" />
              </Show>
              {statusLabel()}
            </span>
          </div>
          <div class="grid min-w-0 grid-cols-1 gap-2 text-13-regular sm:grid-cols-3">
            <SubagentValue label={language.t("session.child.agent")} value={agent()} slot="agent" />
            <SubagentValue label={language.t("session.child.model")} value={model()} slot="model" />
            <SubagentValue label={language.t("session.child.thinking")} value={variant()} slot="thinking" />
          </div>
        </div>
        <div class="flex shrink-0 flex-wrap items-center justify-end gap-2 pr-8 sm:pr-0">
          <Button size="small" variant="ghost" onClick={props.onOpenParent}>
            {language.t("session.child.backToParent")}
          </Button>
          <Button
            data-action="subagent-stop"
            size="small"
            variant="secondary"
            disabled={stopDisabled()}
            onClick={stop}
          >
            {language.t("session.child.stop")}
          </Button>
        </div>
      </div>
    </div>
  )
}

function SubagentValue(props: { label: string; value: string; slot: string }) {
  return (
    <div class="min-w-0 rounded-md border border-border-weak-base bg-surface-base px-2 py-1.5">
      <div class="text-11-medium uppercase tracking-wide text-text-faint">{props.label}</div>
      <div data-slot={`subagent-${props.slot}`} class="mt-0.5 truncate text-13-medium text-text-strong" title={props.value}>
        {props.value}
      </div>
    </div>
  )
}
