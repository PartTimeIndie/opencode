import { For, Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { DockTray } from "@opencode-ai/ui/dock-surface"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"

export function SessionFollowupDock(props: {
  items: { id: string; text: string }[]
  sending?: string
  failed?: string
  paused?: boolean
  onPause?: () => void
  onResume?: () => void
  onSend: (id: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onMove: (id: string, beforeID: string) => void
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({
    collapsed: false,
    dragging: undefined as string | undefined,
  })

  const toggle = () => setStore("collapsed", (value) => !value)
  const total = createMemo(() => props.items.length)
  const label = createMemo(() =>
    language.t(total() === 1 ? "session.followupDock.summary.one" : "session.followupDock.summary.other", {
      count: total(),
    }),
  )
  const preview = createMemo(() => props.items[0]?.text ?? "")
  const onDragStart = (event: DragEvent, id: string) => {
    setStore("dragging", id)
    event.dataTransfer?.setData("text/plain", id)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
  }
  const onDrop = (event: DragEvent, beforeID: string) => {
    const id = event.dataTransfer?.getData("text/plain") || store.dragging
    if (!id || id === beforeID) return
    event.preventDefault()
    props.onMove(id, beforeID)
    setStore("dragging", undefined)
  }

  return (
    <DockTray
      data-component="session-followup-dock"
      style={{
        "margin-bottom": "-0.875rem",
        "border-bottom-left-radius": 0,
        "border-bottom-right-radius": 0,
      }}
    >
      <div
        class="pl-3 pr-2 py-2 flex items-center gap-2"
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          toggle()
        }}
      >
        <span class="shrink-0 text-13-medium text-text-strong cursor-default">{label()}</span>
        <Show when={props.paused}>
          <span class="shrink-0 rounded bg-surface-base px-1.5 py-0.5 text-11-regular text-text-weak">Paused</span>
        </Show>
        <Show when={!props.paused && props.onPause}>
          <Button
            size="small"
            variant="secondary"
            class="shrink-0"
            data-action="followup-pause"
            title={language.t("session.followupDock.pause.description")}
            aria-label={language.t("session.followupDock.pause.description")}
            onClick={() => props.onPause?.()}
          >
            {language.t("session.followupDock.pause.label")}
          </Button>
        </Show>
        <Show when={props.paused && props.onResume}>
          <Button
            size="small"
            variant="secondary"
            class="shrink-0"
            data-action="followup-resume"
            title={language.t("session.followupDock.resume.description")}
            aria-label={language.t("session.followupDock.resume.description")}
            onClick={() => props.onResume?.()}
          >
            {language.t("session.followupDock.resume.label")}
          </Button>
        </Show>
        <Show when={store.collapsed && preview()}>
          <span class="min-w-0 flex-1 truncate text-13-regular text-text-base cursor-default">{preview()}</span>
        </Show>
        <div class="ml-auto shrink-0">
          <IconButton
            data-collapsed={store.collapsed ? "true" : "false"}
            icon="chevron-down"
            size="normal"
            variant="ghost"
            style={{ transform: `rotate(${store.collapsed ? 180 : 0}deg)` }}
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.stopPropagation()
              toggle()
            }}
            aria-label={
              store.collapsed ? language.t("session.followupDock.expand") : language.t("session.followupDock.collapse")
            }
          />
        </div>
      </div>

      <Show when={store.collapsed}>
        <div class="h-5" aria-hidden="true" />
      </Show>

      <Show when={!store.collapsed}>
        <div class="px-3 pb-7 flex flex-col gap-1.5 max-h-42 overflow-y-auto no-scrollbar">
          <For each={props.items}>
            {(item) => (
              <div
                data-followup-id={item.id}
                draggable={!props.sending}
                class="flex items-center gap-2 min-w-0 py-1 rounded-md px-1"
                classList={{
                  "bg-surface-base": store.dragging === item.id,
                  "border border-icon-danger-base": props.failed === item.id,
                }}
                onDragStart={(event) => onDragStart(event, item.id)}
                onDragEnd={() => setStore("dragging", undefined)}
                onDragOver={(event) => {
                  if (!store.dragging || store.dragging === item.id) return
                  event.preventDefault()
                  if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
                }}
                onDrop={(event) => onDrop(event, item.id)}
              >
                <span class="shrink-0 cursor-grab text-12-regular text-text-weak" aria-hidden="true">
                  ::
                </span>
                <span class="min-w-0 flex-1 truncate text-13-regular text-text-strong">{item.text}</span>
                <Show when={props.failed === item.id}>
                  <span class="shrink-0 text-11-regular text-icon-danger-base">Failed</span>
                </Show>
                <Button
                  size="small"
                  variant="secondary"
                  class="shrink-0"
                  disabled={!!props.sending}
                  onClick={() => props.onSend(item.id)}
                >
                  {language.t("session.followupDock.sendNow")}
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  class="shrink-0"
                  disabled={!!props.sending}
                  onClick={() => props.onEdit(item.id)}
                >
                  {language.t("session.followupDock.edit")}
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  class="shrink-0"
                  disabled={!!props.sending}
                  onClick={() => props.onDelete(item.id)}
                >
                  {language.t("common.delete")}
                </Button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </DockTray>
  )
}
