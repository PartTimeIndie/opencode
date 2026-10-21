import { For, Show } from "solid-js"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@opencode-ai/ui/dock-prompt"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { permissionAllowsAlways } from "@/utils/permission-options"

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()
  const review = () =>
    props.request.metadata["$opencode.permission.safety_review"] as
      { cause?: string; context?: { goal?: string; action?: string }; attempts?: { role?: string; model?: string; status?: string; reason?: string }[] } | undefined
  const technical = () => review()?.cause === "reviewers_unavailable"

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.permission}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">
            {language.t("notification.permission.title")}
          </div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding}>
              {language.t("ui.permission.deny")}
            </Button>
            <Show when={permissionAllowsAlways(props.request)}>
              <Button
                variant="secondary"
                size="normal"
                onClick={() => props.onDecide("always")}
                disabled={props.responding}
              >
                {language.t("ui.permission.allowAlways")}
              </Button>
            </Show>
            <Button variant="primary" size="normal" onClick={() => props.onDecide("once")} disabled={props.responding}>
              {language.t("ui.permission.allowOnce")}
            </Button>
          </div>
        </>
      }
    >
      <Show when={review()}>
        {(value) => (
          <div data-slot="permission-row">
            <span data-slot="permission-spacer" aria-hidden="true" />
            <div data-slot="permission-hint" class="grid gap-2">
              <Show when={value().context?.goal}>
                {(goal) => <div><strong>Goal (your request):</strong> {goal()}</div>}
              </Show>
              <div><strong>Agent's next step:</strong> {value().context?.action ?? `Request ${props.request.permission} access for the resources below.`}</div>
              <div><strong>Your decision:</strong> Allow this step, or deny it so the agent looks for a different authorized approach. Denial does not authorize the same action through another route.</div>
              <details class="text-text-muted">
                <summary>{technical() ? "Safety review unavailable" : "Why manual approval is needed"}</summary>
                <div>{technical() ? "The configured reviewers did not provide a verdict." : "The reviewers could not approve this action."}</div>
                <For each={value().attempts ?? []}>
                  {(attempt) => <div>{attempt.role}: {attempt.model ?? "not configured"} — {attempt.status}{attempt.reason ? ` (${attempt.reason})` : ""}</div>}
                </For>
              </details>
            </div>
          </div>
        )}
      </Show>
      <Show when={toolDescription()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{toolDescription()}</div>
        </div>
      </Show>

      <Show when={props.request.patterns.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={props.request.patterns}>
              {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
            </For>
          </div>
        </div>
      </Show>
    </DockPrompt>
  )
}
