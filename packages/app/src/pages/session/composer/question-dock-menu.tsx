import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { For, Show } from "solid-js"
import { questionDockAreas, type QuestionDockActions } from "./question-dock-types"

export function QuestionDockMenu(props: {
  dock?: QuestionDockActions
  items?: Array<{ id: string; label: string; onSelect: () => void }>
}) {
  return (
    <MenuV2 gutter={4} modal={false} placement="bottom-end">
      <MenuV2.Trigger
        as={IconButtonV2}
        size="small"
        variant="ghost-muted"
        class="size-6"
        icon={<IconV2 name="menu" />}
        aria-label="Surface menu"
        onClick={(event) => event.stopPropagation()}
      />
      <MenuV2.Portal>
        <MenuV2.Content>
          <Show when={props.items?.length}>
            <MenuV2.Group>
              <For each={props.items}>{(item) => <MenuV2.Item onSelect={item.onSelect}>{item.label}</MenuV2.Item>}</For>
            </MenuV2.Group>
          </Show>
          <Show when={props.dock}>
            {(dock) => (
              <>
                <Show when={props.items?.length}>
                  <MenuV2.Separator />
                </Show>
                <MenuV2.Group>
                  <MenuV2.GroupLabel>In Session-Dock verschieben</MenuV2.GroupLabel>
                  <For each={questionDockAreas}>
                    {(area) => (
                      <MenuV2.Item onSelect={() => dock().onDock(area)}>
                        {area === dock().currentArea && dock().pinned ? "Aktuell: " : ""}
                        {area}
                      </MenuV2.Item>
                    )}
                  </For>
                </MenuV2.Group>
                <Show when={dock().pinned && dock().onUnpin}>
                  {(onUnpin) => (
                    <>
                      <MenuV2.Separator />
                      <MenuV2.Item onSelect={onUnpin()}>Inline anzeigen</MenuV2.Item>
                    </>
                  )}
                </Show>
              </>
            )}
          </Show>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}
