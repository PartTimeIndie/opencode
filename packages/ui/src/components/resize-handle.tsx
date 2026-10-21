import { onCleanup, splitProps, type JSX } from "solid-js"

export interface ResizeHandleProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "onResize"> {
  direction: "horizontal" | "vertical"
  edge?: "start" | "end"
  size: number
  min: number
  max: number
  onResize: (size: number) => void
  onCollapse?: () => void
  collapseThreshold?: number
}

export function ResizeHandle(props: ResizeHandleProps) {
  const [local, rest] = splitProps(props, [
    "direction",
    "edge",
    "size",
    "min",
    "max",
    "onResize",
    "onCollapse",
    "collapseThreshold",
    "class",
    "classList",
    "onPointerDown",
    "onKeyDown",
  ])

  let cleanupActiveDrag: (() => void) | undefined

  const handlePointerDown: JSX.EventHandler<HTMLDivElement, PointerEvent> = (e) => {
    invokeHandler(local.onPointerDown, e)
    if (e.defaultPrevented || !e.isPrimary || e.button !== 0 || cleanupActiveDrag) return

    e.preventDefault()
    const edge = local.edge ?? (local.direction === "vertical" ? "start" : "end")
    const start = local.direction === "horizontal" ? e.clientX : e.clientY
    const startSize = local.size
    const target = e.currentTarget
    const pointerID = e.pointerId
    const previousUserSelect = document.body.style.userSelect
    const previousOverflow = document.body.style.overflow
    let rawSize = startSize

    document.body.style.userSelect = "none"
    document.body.style.overflow = "hidden"

    const resize = (moveEvent: PointerEvent) => {
      const pos = local.direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY
      const delta =
        local.direction === "vertical"
          ? edge === "end"
            ? pos - start
            : start - pos
          : edge === "start"
            ? start - pos
            : pos - start
      rawSize = startSize + delta
      local.onResize(Math.min(local.max, Math.max(local.min, rawSize)))
    }

    const cleanup = () => {
      if (!cleanupActiveDrag) return
      cleanupActiveDrag = undefined
      target.removeEventListener("pointermove", onPointerMove)
      target.removeEventListener("pointerup", onPointerUp)
      target.removeEventListener("pointercancel", onPointerCancel)
      target.removeEventListener("lostpointercapture", onLostPointerCapture)
      window.removeEventListener("blur", cleanup)
      document.body.style.userSelect = previousUserSelect
      document.body.style.overflow = previousOverflow
      if (target.hasPointerCapture(pointerID)) target.releasePointerCapture(pointerID)
    }

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerID) return
      resize(moveEvent)
    }

    const onPointerUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerID) return
      resize(upEvent)
      cleanup()
      const threshold = local.collapseThreshold ?? 0
      if (local.onCollapse && threshold > 0 && rawSize < threshold) local.onCollapse()
    }

    const onPointerCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== pointerID) return
      cleanup()
    }

    const onLostPointerCapture = (lostEvent: PointerEvent) => {
      if (lostEvent.pointerId !== pointerID) return
      cleanup()
    }

    cleanupActiveDrag = cleanup
    target.addEventListener("pointermove", onPointerMove)
    target.addEventListener("pointerup", onPointerUp)
    target.addEventListener("pointercancel", onPointerCancel)
    target.addEventListener("lostpointercapture", onLostPointerCapture)
    window.addEventListener("blur", cleanup)
    target.setPointerCapture(pointerID)
  }

  const handleKeyDown: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (e) => {
    invokeHandler(local.onKeyDown, e)
    if (e.defaultPrevented) return

    const edge = local.edge ?? (local.direction === "vertical" ? "start" : "end")
    const direction = keyboardDirection(local.direction, edge, e.key)
    if (direction === 0) return

    e.preventDefault()
    local.onResize(Math.min(local.max, Math.max(local.min, local.size + direction * 16)))
  }

  onCleanup(() => cleanupActiveDrag?.())

  return (
    <div
      {...rest}
      data-component="resize-handle"
      data-direction={local.direction}
      data-edge={local.edge ?? (local.direction === "vertical" ? "start" : "end")}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      role="separator"
      tabIndex={0}
      aria-orientation={local.direction === "horizontal" ? "vertical" : "horizontal"}
      aria-valuemin={local.min}
      aria-valuemax={local.max}
      aria-valuenow={local.size}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
    />
  )
}

function invokeHandler<E extends Event>(
  handler: JSX.EventHandlerUnion<HTMLDivElement, E> | undefined,
  event: E & { currentTarget: HTMLDivElement; target: Element },
) {
  if (typeof handler === "function") {
    handler(event)
    return
  }
  if (handler) handler[0](handler[1], event)
}

function keyboardDirection(direction: "horizontal" | "vertical", edge: "start" | "end", key: string) {
  if (direction === "horizontal") {
    if (key === "ArrowLeft") return edge === "start" ? 1 : -1
    if (key === "ArrowRight") return edge === "start" ? -1 : 1
    return 0
  }
  if (key === "ArrowUp") return edge === "start" ? 1 : -1
  if (key === "ArrowDown") return edge === "start" ? -1 : 1
  return 0
}
