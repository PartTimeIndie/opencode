import { For, Show, createEffect, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { DockTray } from "@opencode-ai/ui/dock-surface"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"

export function SessionRevertDock(props: {
  items: { id: string; text: string }[]
  blocked?: boolean
  blockedReason?: "conflict" | "unattributed"
  conflicts?: { resource: string; message: string }[]
  restoring?: string
  disabled?: boolean
  onRestoreCheckpoint: () => void
  onKeepFiles: () => void
  onRestoreMessage: (id: string) => void
  onRestoreBoth: (id: string) => void
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({
    collapsed: true,
  })

  createEffect(() => {
    props.items.length
    props.items[0]?.id
    setStore("collapsed", true)
  })

  const toggle = () => setStore("collapsed", (value) => !value)
  const total = createMemo(() => props.items.length)
  const conflictTotal = createMemo(() => props.conflicts?.length ?? 0)
  const label = createMemo(() =>
    props.blocked
      ? props.blockedReason === "unattributed"
        ? language.t("session.revertDock.unattributedSummary")
        : language.t("session.revertDock.blockedSummary", { count: conflictTotal() })
      : language.t(total() === 1 ? "session.revertDock.summary.one" : "session.revertDock.summary.other", {
          count: total(),
        }),
  )
  const preview = createMemo(() => props.items[0]?.text ?? "")

  return (
    <DockTray data-component="session-revert-dock">
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
        <span
          classList={{
            "shrink-0 text-14-regular cursor-default": true,
            "text-text-warning-base": props.blocked,
            "text-text-strong": !props.blocked,
          }}
        >
          {label()}
        </span>
        <Show when={store.collapsed && preview()}>
          <span class="min-w-0 flex-1 truncate text-14-regular text-text-base cursor-default">{preview()}</span>
        </Show>
        <div class="ml-auto shrink-0 flex items-center gap-1.5">
          <Show when={!props.blocked}>
            <Button
              size="small"
              variant="secondary"
              disabled={props.disabled || !!props.restoring}
              onMouseDown={(event: MouseEvent) => {
                event.preventDefault()
                event.stopPropagation()
              }}
              onClick={(event: MouseEvent) => {
                event.stopPropagation()
                props.onRestoreCheckpoint()
              }}
            >
              {language.t("session.revertDock.restoreCheckpoint")}
            </Button>
          </Show>
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
              store.collapsed ? language.t("session.revertDock.expand") : language.t("session.revertDock.collapse")
            }
          />
        </div>
      </div>

      <Show when={store.collapsed}>
        <div class="h-5" aria-hidden="true" />
      </Show>

      <Show when={!store.collapsed}>
        <div class="px-3 pb-7 flex flex-col gap-1.5 max-h-42 overflow-y-auto no-scrollbar">
          <Show when={props.blocked && props.conflicts?.length}>
            <div class="mb-1 rounded-md border border-icon-warning-base/40 bg-surface-base px-2 py-1.5 text-12-regular text-text-warning-base">
              <div>{language.t("session.revertDock.blockedDescription")}</div>
              <For each={props.conflicts}>
                {(conflict) => (
                  <div class="mt-1 truncate">
                    {conflict.resource}: {conflict.message}
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={props.blocked}>
            <div class="flex items-center gap-2 text-12-regular text-text-warning-base">
              <span>
                {props.blockedReason === "unattributed"
                  ? language.t("session.revertDock.unattributed")
                  : language.t("session.revertDock.conflictWarning")}
              </span>
              <Button size="small" variant="secondary" disabled={props.disabled} onClick={props.onKeepFiles}>
                {language.t("session.revertDock.keepFiles")}
              </Button>
            </div>
          </Show>
          <For each={props.items}>
            {(item) => (
              <div class="flex items-center gap-2 min-w-0 py-1">
                <span class="min-w-0 flex-1 truncate text-13-regular text-text-strong">{item.text}</span>
                <div class="shrink-0 flex items-center gap-1.5">
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={props.blocked || props.disabled || !!props.restoring}
                    onClick={() => props.onRestoreMessage(item.id)}
                  >
                    {language.t("session.revertDock.restoreMessage")}
                  </Button>
                  <Button
                    size="small"
                    variant="primary"
                    disabled={props.blocked || props.disabled || !!props.restoring}
                    onClick={() => props.onRestoreBoth(item.id)}
                  >
                    {language.t("session.revertDock.restoreBoth")}
                  </Button>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </DockTray>
  )
}
