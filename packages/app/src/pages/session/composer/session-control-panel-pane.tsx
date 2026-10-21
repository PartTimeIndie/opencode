import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { createMemo, For, Show, type ParentProps } from "solid-js"
import { ControlPanelPart } from "@/components/control-panel-part"
import { SessionQuestionDock } from "@/pages/session/composer/session-question-dock"
import { controlPanelFormRequest } from "./session-control-panel-form"
import { SessionSurfaceProviders } from "./session-surface-providers"
import type { StoredControlPanel } from "@/context/layout"
import type { DockArea } from "@/plugin/app-runtime"
import type { CustomPart } from "@/plugin/custom-part"

export type ControlPanelPaneInfo = StoredControlPanel & {
  paneID: string
  pinned?: boolean
  dock?: boolean
  requestID?: string
  requestRevision?: number
  requestCapability?: string
  requestMode?: "interactive" | "passive"
  canPinGlobal?: boolean
  toolID?: string
  toolRevision?: number
  toolStateRevision?: number
  sourcePart: CustomPart
}

const areas = ["top", "left", "middle", "right", "bottom"] as const

export function SessionControlPanelPane(props: {
  panel: ControlPanelPaneInfo
  currentArea: DockArea
  pinned: boolean
  onDock: (area: DockArea) => void
  onPin: () => void
  onUnpin: () => void
  onClose: () => void
  onRemove?: () => void
  onValuesChange?: (values: Record<string, unknown>) => void
}) {
  const title = createMemo(() => props.panel.title || props.panel.controlID)
  const formRequest = createMemo(() => controlPanelFormRequest(props.panel))

  return (
    <SessionSurfaceProviders directory={props.panel.directory} sessionID={props.panel.sessionID}>
      <section data-component="control-panel-dock-pane" data-control-id={props.panel.controlID} class="size-full min-h-0 flex flex-col bg-background-stronger">
        <div data-slot="control-panel-pane-header" class="shrink-0 border-b border-border-weaker-base px-3 py-2 flex items-center gap-2">
          <div class="min-w-0 flex-1">
            <div class="truncate text-13-medium text-text-base">{title()}</div>
            <div class="truncate text-11-regular text-text-weak">{props.panel.directory}</div>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <For each={areas}>
              {(area) => (
                <button
                  type="button"
                  data-slot="control-panel-dock-action"
                  data-area={area}
                  data-active={area === props.currentArea}
                  class="h-7 min-w-7 rounded-md px-2 text-11-medium text-text-weak hover:bg-surface-hover-base hover:text-text-base data-[active=true]:bg-surface-selected-base data-[active=true]:text-text-base"
                  onClick={() => props.onDock(area)}
                >
                  {area}
                </button>
              )}
            </For>
            <Button size="small" variant={props.pinned ? "secondary" : "ghost"} onClick={props.pinned ? props.onUnpin : props.onPin}>
              {props.panel.toolID ? "Ausblenden" : props.pinned ? "Angeheftet" : "Anheften"}
            </Button>
            <Show when={props.panel.toolID && props.onRemove}>
              <Button size="small" variant="ghost" onClick={props.onRemove}>
                Entfernen
              </Button>
            </Show>
            <button
              type="button"
              class="h-7 w-7 rounded-md flex items-center justify-center text-icon-weak hover:bg-surface-hover-base hover:text-icon-base"
              aria-label={`Close ${title()}`}
              onClick={props.onClose}
            >
              <Icon name="close-small" size="small" />
            </button>
          </div>
        </div>
        <div data-slot="control-panel-pane-body" class="min-h-0 flex-1 overflow-auto p-3">
          <Show when={props.pinned && props.panel.messageID}>
            <div data-slot="control-panel-snapshot-hint" class="mb-2 rounded-md border border-border-weak-base bg-background-base px-3 py-2 text-11-regular text-text-weak">
              Angehefteter Snapshot aus Session {props.panel.sessionID}
            </div>
          </Show>
          <Show
            when={formRequest()}
            fallback={<ControlPanelPart part={props.panel.sourcePart} actionTarget={props.panel.requestID && props.panel.requestRevision && props.panel.requestCapability ? { kind: "request", id: props.panel.requestID, revision: props.panel.requestRevision, token: props.panel.requestCapability } : undefined} onHandoffDecision={props.onClose} onValuesChange={props.onValuesChange} />}
          >
            {(request) => (
              <SessionQuestionDock
                request={request()}
                autofocus={false}
                actionTarget={
                  props.panel.toolID && props.panel.toolRevision
                    ? { kind: "tool", id: props.panel.toolID, revision: props.panel.toolRevision }
                    : undefined
                }
                onToolDismiss={props.onUnpin}
                onValuesChange={props.onValuesChange}
              />
            )}
          </Show>
        </div>
      </section>
    </SessionSurfaceProviders>
  )
}
