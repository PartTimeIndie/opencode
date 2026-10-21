import { Button } from "@opencode-ai/ui/button"
import type {
  SurfaceBlockingRequest,
  SurfaceControlRequest,
  SurfaceRequest,
} from "@opencode-ai/sdk/v2/client"
import { createMemo, Show } from "solid-js"
import { OnDemandPopup } from "@/components/on-demand-surface"
import { AgentHandoffForm, type AgentHandoffAction } from "@/components/agent-handoff"
import type { HandoffRequestIdentity } from "@/utils/handoff-request"
import { SDKProvider } from "@/context/sdk"
import type { useLanguage } from "@/context/language"
import { directoryKey } from "@/utils/path-key"
import { SessionSurfaceProviders } from "../session/composer/session-surface-providers"
import { SessionQuestionDock } from "../session/composer/session-question-dock"
import { handoffPopupKey, pendingHandoffStep } from "./question-popup-match"

export type QuestionPopupRequest = {
  directory: string
  request: SurfaceBlockingRequest
}

export type ActiveQuestionPopup = QuestionPopupRequest & {
  sessionTitle: string
  projectName: string
  description: string
  href: string
  detached: boolean
}

export type AgentHandoffPopupRequest = {
  directory: string
  request: SurfaceControlRequest
}

export type ActiveAgentHandoffPopup = AgentHandoffPopupRequest & {
  sessionTitle: string
  projectName: string
  description: string
  href: string
}

export function questionPopupKey(directory: string, request: Pick<SurfaceRequest, "id" | "sessionID">) {
  return `${directoryKey(directory)}:${request.sessionID}:${request.id}`
}

export function HandoffPopup(props: {
  popup: ActiveAgentHandoffPopup | undefined
  goToSession: (href: string) => void
  minimize: (directory: string, request: SurfaceControlRequest) => void
  dismiss: (directory: string, request: SurfaceControlRequest) => void
  complete: (request: HandoffRequestIdentity) => void | Promise<void>
  planAndGoToSession: (directory: string, request: SurfaceControlRequest) => void
  language: ReturnType<typeof useLanguage>
}) {
  const popupKey = createMemo(() =>
    props.popup ? handoffPopupKey(props.popup.directory, props.popup.request) : undefined,
  )
  const pending = createMemo(() => (props.popup ? pendingHandoffStep(props.popup.request) : undefined))

  return (
    <Show when={popupKey()} keyed>
      {(_) => (
        <Show when={props.popup}>
          {(popup) => (
            <Show when={pending()} keyed fallback={undefined}>
              {(handoff) => {
                // Revision and token may be revised while the popup is open;
                // reading them inside this memo keeps the confirmation target
                // in sync instead of freezing the first approved revision.
                const action = createMemo<AgentHandoffAction | undefined>(() => {
                  const token = popup().request.tool?.confirmationToken
                  if (!token) return undefined
                  return {
                    id: handoff.action.id,
                    target: {
                      kind: "request",
                      id: popup().request.id,
                      revision: popup().request.revision,
                      token,
                    },
                  }
                })
                return (
                  <OnDemandPopup
                    kind="control-panel"
                    title={props.language.t("notification.handoff.title")}
                    description={popup().description}
                    actions={
                      <>
                        <Button
                          variant="secondary"
                          size="normal"
                          onClick={() => {
                            props.dismiss(popup().directory, popup().request)
                            props.goToSession(popup().href)
                          }}
                        >
                          {props.language.t("notification.action.goToSession")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="normal"
                          onClick={() => props.minimize(popup().directory, popup().request)}
                        >
                          {props.language.t("notification.action.minimizeQuestion")}
                        </Button>
                      </>
                    }
                  >
                    <SessionSurfaceProviders directory={popup().directory} sessionID={popup().request.sessionID}>
                      <div data-slot="control-panel-popup-body">
                        <AgentHandoffForm
                          sessionID={popup().request.sessionID}
                          step={handoff.step}
                          action={action()}
                          planningMessageID={popup().request.tool?.messageID}
                          onCancel={() => props.planAndGoToSession(popup().directory, popup().request)}
                          onComplete={props.complete}
                        />
                      </div>
                    </SessionSurfaceProviders>
                  </OnDemandPopup>
                )
              }}
            </Show>
          )}
        </Show>
      )}
    </Show>
  )
}

export function QuestionPopup(props: {
  popup: ActiveQuestionPopup | undefined
  goToSession: (href: string) => void
  minimize: (directory: string, request: SurfaceBlockingRequest) => void
  dismiss: (directory: string, request: SurfaceBlockingRequest) => void
  language: ReturnType<typeof useLanguage>
}) {
  const popupKey = createMemo(() =>
    props.popup ? questionPopupKey(props.popup.directory, props.popup.request) : undefined,
  )

  return (
    <Show when={popupKey()} keyed>
      {(_) => (
        <Show when={props.popup}>
          {(popup) => (
            <OnDemandPopup
              kind="question"
              title={props.language.t("notification.question.title")}
              description={popup().description}
              actions={
                <>
                  <Button
                    variant="secondary"
                    size="normal"
                    onClick={() => {
                      props.dismiss(popup().directory, popup().request)
                      props.goToSession(popup().href)
                    }}
                  >
                    {props.language.t("notification.action.goToSession")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="normal"
                    onClick={() => props.minimize(popup().directory, popup().request)}
                  >
                    {props.language.t("notification.action.minimizeQuestion")}
                  </Button>
                </>
              }
            >
              <SDKProvider directory={popup().directory}>
                <SessionQuestionDock
                  request={popup().request}
                  autofocus={false}
                  fill
                  onLocalDismiss={() => props.dismiss(popup().directory, popup().request)}
                  onSubmit={() => props.dismiss(popup().directory, popup().request)}
                />
              </SDKProvider>
            </OnDemandPopup>
          )}
        </Show>
      )}
    </Show>
  )
}
