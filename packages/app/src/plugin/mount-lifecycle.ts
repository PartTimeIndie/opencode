import { abortPluginWork } from "./abort"

export type PluginMountResult = void | (() => void) | Promise<void | (() => void)>

export function mountPluginElement(input: {
  element: HTMLElement
  mount(signal: AbortSignal): PluginMountResult
  onError?: (error: unknown) => void
}) {
  const controller = new AbortController()
  let cleanup: (() => void) | undefined

  const dispose = () => {
    const next = cleanup
    cleanup = undefined
    abortPluginWork(controller)
    try {
      next?.()
    } finally {
      input.element.replaceChildren()
    }
  }

  let result: PluginMountResult
  try {
    result = input.mount(controller.signal)
  } catch (error) {
    input.onError?.(error)
    input.element.replaceChildren()
    return dispose
  }
  if (result instanceof Promise) {
    void result
      .then((next) => {
        if (controller.signal.aborted) {
          if (typeof next === "function") next()
          return
        }
        cleanup = typeof next === "function" ? next : undefined
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        input.onError?.(error)
        input.element.replaceChildren()
      })
  } else {
    cleanup = typeof result === "function" ? result : undefined
  }

  return dispose
}
