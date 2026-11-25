import { For, Show } from "solid-js"
import { useAppPluginRuntime } from "./app-runtime"
import { PluginSlotMount } from "./slot-mount"
import type { UISlotID } from "./ui-slots"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"

export function PluginSlotOutlet(props: { slot: UISlotID; class?: string; target?: { directory: string; sessionID: string } }) {
  const plugins = useAppPluginRuntime()
  const items = () => plugins.slotItems(props.slot)

  return (
    <Show when={items().length > 0}>
      <For each={items()}>{(item) => item.menu ? (
        <Show when={props.target}>{(target) => <MenuV2.CheckboxItem
          checked={item.menu!.state(target()).checked}
          disabled={item.menu!.state(target()).disabled}
          onChange={() => void item.menu!.run(target())}
        >{item.menu!.state(target()).label}</MenuV2.CheckboxItem>}</Show>
      ) : <PluginSlotMount item={item} context={props.target ? { slot: props.slot, ...props.target } : undefined} />}</For>
    </Show>
  )
}
