import { For, Show } from "solid-js"
import { useAppPluginRuntime } from "./app-runtime"
import { PluginSlotMount } from "./slot-mount"
import type { UISlotID } from "./ui-slots"

export function PluginSlotOutlet(props: { slot: UISlotID; class?: string }) {
  const plugins = useAppPluginRuntime()
  const items = () => plugins.slotItems(props.slot)

  return (
    <Show when={items().length > 0}>
      <div data-component="plugin-slot-outlet" data-plugin-slot={props.slot} class={props.class}>
        <For each={items()}>{(item) => <PluginSlotMount item={item} />}</For>
      </div>
    </Show>
  )
}
