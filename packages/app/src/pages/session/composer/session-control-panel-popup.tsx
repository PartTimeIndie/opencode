import { Button } from "@opencode-ai/ui/button"
import { ControlPanelPart } from "@/components/control-panel-part"
import { SessionQuestionDock } from "./session-question-dock"
import { OnDemandPopup } from "@/components/on-demand-surface"
import { type ControlPanelPaneInfo } from "./session-control-panel-pane"
import { controlPanelFormRequest } from "./session-control-panel-form"
import { SessionSurfaceProviders } from "./session-surface-providers"
import { createMemo, Show } from "solid-js"

export function SessionControlPanelPopup(props: {
  panel: ControlPanelPaneInfo
  onDock: () => void
  onPin: (scope: "project" | "global") => void
  onClose: () => void
}) {
  const formRequest = createMemo(() => controlPanelFormRequest(props.panel))
  return (
    <OnDemandPopup
      kind="control-panel"
      title={props.panel.title || props.panel.controlID}
      description={props.panel.directory}
      onDismiss={props.onClose}
      restoreFocus
      actions={
        <>
          <Button variant="secondary" size="normal" onClick={props.onDock}>
            In Session-Dock
          </Button>
          <Button variant="secondary" size="normal" onClick={() => props.onPin("project")}>
            Als Projektwerkzeug anheften
          </Button>
          {props.panel.canPinGlobal ? (
            <Button variant="secondary" size="normal" onClick={() => props.onPin("global")}>
              App-weit anheften
            </Button>
          ) : null}
          <Button variant="ghost" size="normal" onClick={props.onClose}>
            Schließen
          </Button>
        </>
      }
    >
      <div data-slot="control-panel-popup-body">
        <SessionSurfaceProviders directory={props.panel.directory} sessionID={props.panel.sessionID}>
          <Show when={formRequest()} fallback={<ControlPanelPart part={props.panel.sourcePart} actionTarget={props.panel.requestID && props.panel.requestRevision && props.panel.requestCapability ? { kind: "request", id: props.panel.requestID, revision: props.panel.requestRevision, token: props.panel.requestCapability } : undefined} hideTitle onHandoffDecision={props.onClose} />}>
            {(request) => <SessionQuestionDock request={request()} autofocus />}
          </Show>
        </SessionSurfaceProviders>
      </div>
    </OnDemandPopup>
  )
}
