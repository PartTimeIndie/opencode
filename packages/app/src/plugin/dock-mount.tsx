import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createEffect, createMemo, on, onCleanup, untrack } from "solid-js"
import type { DockArea, DockItem } from "./app-runtime"
import { mountPluginElement } from "./mount-lifecycle"

export function PluginDockMount(props: { item: DockItem; area: DockArea; visible: boolean }) {
  let root: HTMLDivElement | undefined
  let cleanup: (() => void) | undefined
  const bounds = createMemo(() => {
    const rect = root?.getBoundingClientRect()
    return {
      width: rect?.width ?? 0,
      height: rect?.height ?? 0,
    }
  })

  const dispose = () => {
    cleanup?.()
    cleanup = undefined
  }

  createResizeObserver(
    () => root,
    () => {
      window.dispatchEvent(
        new CustomEvent("opencode:dock-resize", {
          detail: {
            item: props.item.id,
            area: props.area,
            bounds: bounds(),
            visible: props.visible,
          },
        }),
      )
    },
  )

  createEffect(on(() => `${props.item.id}:${props.area}:${props.visible}`, () => {
    const element = root
    if (!element || !props.visible) {
      dispose()
      return
    }

    const item = untrack(() => props.item)
    dispose()
    cleanup = mountPluginElement({
      element,
      mount: (signal) =>
        item.mount({
          element,
          area: props.area,
          bounds: bounds(),
          visible: props.visible,
          signal,
        }),
      onError: (error) => {
        console.error("[app-plugin] dock item mount failed", { id: item.id, error })
        element.replaceChildren()
      },
    })
  }))

  onCleanup(dispose)

  return (
    <div
      ref={root}
      data-component="plugin-dock-mount"
      data-dock-item={props.item.id}
      class="size-full min-w-0 min-h-0 overflow-auto"
    />
  )
}
