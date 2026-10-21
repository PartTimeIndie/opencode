import { createEffect, onCleanup } from "solid-js"
import type { SlotItem } from "./app-runtime"
import { mountPluginElement } from "./mount-lifecycle"

export function PluginSlotMount(props: { item: SlotItem }) {
  let root: HTMLDivElement | undefined
  let cleanup: (() => void) | undefined

  const dispose = () => {
    cleanup?.()
    cleanup = undefined
  }

  createEffect(() => {
    const element = root
    if (!element) {
      dispose()
      return
    }

    dispose()
    cleanup = mountPluginElement({
      element,
      mount: (signal) => props.item.mount({ element, signal }),
      onError: (error) => {
        console.error("[app-plugin] slot mount failed", { id: props.item.id, slot: props.item.slot, error })
        element.replaceChildren()
      },
    })
  })

  onCleanup(dispose)

  return (
    <div
      ref={root}
      data-component="plugin-slot-mount"
      data-plugin-slot-item={props.item.id}
      class="contents"
    />
  )
}
