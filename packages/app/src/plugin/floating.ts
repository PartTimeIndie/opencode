import { abortPluginWork } from "./abort"

export type AppFloatingOptions = {
  id: string
  title: string
  ariaLabel?: string
  sessions: { directory: string; ids: string[] }
  mount(context: { element: HTMLElement; signal: AbortSignal; close(): void }): void | (() => void) | Promise<void | (() => void)>
}

export function createFloatingHost(host: {
  authorized: () => boolean
  track: (dispose: () => void) => () => void
  subscribe: (handler: (navigation: { directory?: string; sessionID?: string }) => void) => () => void
}) {
  const entries = new Map<string, { key: string; close(): void }>()
  return {
    open(input: AppFloatingOptions) {
      if (!host.authorized()) throw new Error("Missing ui:floating capability")
      if (!input.id || !input.sessions.directory || !input.sessions.ids.length || input.sessions.ids.some((id) => !id))
        throw new Error("Floating controls require a stable id and session scope")
      const key = JSON.stringify([input.sessions.directory, [...input.sessions.ids].sort()])
      const previous = entries.get(input.id)
      if (previous?.key === key) return previous
      previous?.close()
      const controller = new AbortController()
      const panel = document.createElement("section")
      const header = document.createElement("header")
      const title = document.createElement("h2")
      const closeButton = document.createElement("button")
      const content = document.createElement("div")
      const mounted: { dispose?: () => void; unsubscribe?: () => void } = {}
      const storageKey = `opencode.app-plugin-floating.position.v1:${input.id}`
      const position = floatingPosition(localStorage.getItem(storageKey))
      let drag: { pointerID: number; x: number; y: number; left: number; top: number } | undefined
      panel.dataset.component = "app-plugin-floating"
      panel.dataset.floatingId = input.id
      panel.setAttribute("role", "dialog")
      panel.setAttribute("aria-modal", "false")
      panel.setAttribute("aria-label", input.ariaLabel ?? input.title)
      // Keep normal composer actions and bottom-right notification actions usable.
      panel.style.cssText = "position:fixed;right:16px;top:96px;z-index:90;display:flex;flex-direction:column;width:min(420px,calc(100vw - 32px));max-height:calc(100dvh - 176px);overflow:hidden;border:1px solid var(--border-base,#555);border-radius:14px;background:var(--background-base,#171717);color:var(--text-strong,#f4f4f4);box-shadow:0 12px 36px rgba(0,0,0,.3)"
      header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px;border-bottom:1px solid var(--border-base,#555);cursor:move;touch-action:none;user-select:none"
      title.textContent = input.title
      title.style.cssText = "margin:0;font:600 14px/1.4 system-ui,sans-serif"
      closeButton.type = "button"
      closeButton.textContent = "Close"
      closeButton.setAttribute("aria-label", `Close ${input.title}`)
      closeButton.style.cssText = "padding:6px 10px;border:1px solid var(--border-base,#555);border-radius:8px;background:transparent;color:inherit;cursor:pointer"
      content.dataset.component = "app-plugin-floating-content"
      content.style.cssText = "min-height:0;overflow:auto;padding:12px"
      header.append(title, closeButton)
      panel.append(header, content)
      document.body.append(panel)
      const setPosition = (x: number, y: number) => {
        const bounds = panel.getBoundingClientRect()
        const width = Math.min(bounds.width || Math.min(420, Math.max(0, window.innerWidth - 32)), Math.max(0, window.innerWidth - 16))
        const height = Math.min(bounds.height || Math.min(480, Math.max(0, window.innerHeight - 176)), Math.max(0, window.innerHeight - 16))
        panel.style.right = "auto"
        panel.style.left = `${Math.round(Math.max(8, Math.min(x, window.innerWidth - width - 8)))}px`
        panel.style.top = `${Math.round(Math.max(8, Math.min(y, window.innerHeight - height - 8)))}px`
      }
      if (position) setPosition(position.x, position.y)
      const clampToViewport = () => {
        const x = Number.parseFloat(panel.style.left)
        const y = Number.parseFloat(panel.style.top)
        if (Number.isFinite(x) && Number.isFinite(y)) setPosition(x, y)
      }
      const pointerDown = (event: PointerEvent) => {
        if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return
        const bounds = panel.getBoundingClientRect()
        drag = { pointerID: event.pointerId, x: event.clientX, y: event.clientY, left: bounds.left || Number.parseFloat(panel.style.left) || window.innerWidth - (bounds.width || 420) - 16, top: bounds.top || Number.parseFloat(panel.style.top) || 96 }
        header.setPointerCapture?.(event.pointerId); event.preventDefault()
      }
      const pointerMove = (event: PointerEvent) => { if (drag && event.pointerId === drag.pointerID) setPosition(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y) }
      const pointerUp = (event: PointerEvent) => {
        if (!drag || event.pointerId !== drag.pointerID) return
        drag = undefined; header.releasePointerCapture?.(event.pointerId)
        localStorage.setItem(storageKey, JSON.stringify({ x: Number.parseFloat(panel.style.left), y: Number.parseFloat(panel.style.top) }))
      }
      const resetPosition = () => { drag = undefined; localStorage.removeItem(storageKey); panel.style.left = ""; panel.style.right = "16px"; panel.style.top = "96px" }
      header.addEventListener("pointerdown", pointerDown); header.addEventListener("pointermove", pointerMove); header.addEventListener("pointerup", pointerUp); header.addEventListener("pointercancel", pointerUp); header.addEventListener("dblclick", resetPosition)
      window.addEventListener("resize", clampToViewport)
      const close = host.track(() => {
        if (controller.signal.aborted) return
        abortPluginWork(controller)
        mounted.unsubscribe?.()
        window.removeEventListener("pagehide", close)
        window.removeEventListener("resize", clampToViewport)
        header.removeEventListener("pointerdown", pointerDown); header.removeEventListener("pointermove", pointerMove); header.removeEventListener("pointerup", pointerUp); header.removeEventListener("pointercancel", pointerUp); header.removeEventListener("dblclick", resetPosition)
        entries.delete(input.id)
        panel.remove()
        mounted.dispose?.()
      })
      const handle = { key, close }
      entries.set(input.id, handle)
      closeButton.addEventListener("click", close)
      // No backdrop, global Escape handler, focus restoration, inert siblings or
      // focus trap: normal session controls underneath remain fully interactive.
      panel.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return
        event.preventDefault()
        close()
      })
      window.addEventListener("pagehide", close)
      mounted.unsubscribe = host.subscribe((navigation) => {
        if (navigation.sessionID && navigation.directory == null) return
        if (navigation.directory !== input.sessions.directory) close()
      })
      if (controller.signal.aborted) { mounted.unsubscribe(); return handle }
      // Invoke through the promise boundary so synchronous mount failures are
      // handled just like asynchronous failures, including close-before-mount.
      void Promise.resolve().then(() => {
        if (controller.signal.aborted) return
        return input.mount({ element: content, signal: controller.signal, close })
      }).then((dispose) => {
        if (typeof dispose !== "function") return
        if (controller.signal.aborted) return void dispose()
        mounted.dispose = dispose
      }).catch((error) => {
        if (controller.signal.aborted) return
        content.textContent = error instanceof Error ? error.message : "Floating control could not be mounted"
      })
      return handle
    },
  }
}

function floatingPosition(value: string | null) {
  if (!value) return
  try { const parsed = JSON.parse(value); if (Number.isFinite(parsed?.x) && Number.isFinite(parsed?.y)) return { x: parsed.x as number, y: parsed.y as number } } catch {}
}
