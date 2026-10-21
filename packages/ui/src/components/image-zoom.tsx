import { createSignal, onCleanup, onMount } from "solid-js"
import "./image-zoom.css"

export interface ZoomableImageProps {
  src: string
  alt?: string
  /** sizing/base classes for the <img> (e.g. max-h/max-w + object-contain) */
  imgClass?: string
  /** called when Escape is pressed (optional) */
  onClose?: () => void
}

const MIN_SCALE = 1
const MAX_SCALE = 8
const clampNum = (min: number, value: number, max: number) => Math.max(min, Math.min(max, value))

/**
 * A zoomable, pannable image intended for fullscreen lightbox overlays.
 * - wheel / + / - zoom (toward the cursor for wheel)
 * - double-click toggles 1x <-> 2x (toward the click)
 * - drag to pan when zoomed in (clamped to image bounds)
 * - 0 resets to fit; Escape calls onClose
 */
export function ZoomableImage(props: ZoomableImageProps) {
  let imgRef: HTMLImageElement | undefined
  // displayed (scale-1) size, measured on load/resize; read inside event handlers
  let baseW = 0
  let baseH = 0
  let pointerId: number | null = null
  let dragOrigin = { x: 0, y: 0, tx: 0, ty: 0 }

  const [scale, setScale] = createSignal(1)
  const [tx, setTx] = createSignal(0)
  const [ty, setTy] = createSignal(0)
  const [dragging, setDragging] = createSignal(false)

  const transform = () => `translate(${tx()}px, ${ty()}px) scale(${scale()})`
  const cursor = () => (scale() <= MIN_SCALE ? "zoom-in" : dragging() ? "grabbing" : "grab")

  const measureBase = () => {
    const rect = imgRef?.getBoundingClientRect()
    if (rect && rect.width > 0 && rect.height > 0) {
      baseW = rect.width
      baseH = rect.height
    }
  }

  const reset = () => {
    setScale(MIN_SCALE)
    setTx(0)
    setTy(0)
  }

  const applyClamped = (s: number, x: number, y: number) => {
    const ns = clampNum(MIN_SCALE, s, MAX_SCALE)
    if (ns <= MIN_SCALE) {
      reset()
      return
    }
    const maxX = Math.max(0, (baseW * ns - window.innerWidth) / 2)
    const maxY = Math.max(0, (baseH * ns - window.innerHeight) / 2)
    setScale(ns)
    setTx(clampNum(-maxX, x, maxX))
    setTy(clampNum(-maxY, y, maxY))
  }

  // Zoom while keeping the point under the cursor fixed.
  const zoomAtPoint = (clientX: number, clientY: number, factor: number) => {
    const cur = scale()
    const ns = clampNum(MIN_SCALE, cur * factor, MAX_SCALE)
    if (ns === cur) {
      if (ns <= MIN_SCALE) reset()
      return
    }
    const px = clientX - window.innerWidth / 2
    const py = clientY - window.innerHeight / 2
    const r = ns / cur
    applyClamped(ns, px * (1 - r) + tx() * r, py * (1 - r) + ty() * r)
  }

  const zoomCenter = (factor: number) => zoomAtPoint(window.innerWidth / 2, window.innerHeight / 2, factor)

  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    zoomAtPoint(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15)
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    pointerId = e.pointerId
    dragOrigin = { x: e.clientX, y: e.clientY, tx: tx(), ty: ty() }
    setDragging(true)
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent) => {
    if (pointerId !== e.pointerId) return
    applyClamped(scale(), dragOrigin.tx + (e.clientX - dragOrigin.x), dragOrigin.ty + (e.clientY - dragOrigin.y))
  }
  const onPointerUp = (e: PointerEvent) => {
    if (pointerId !== e.pointerId) return
    pointerId = null
    setDragging(false)
    ;(e.currentTarget as Element).releasePointerCapture?.(e.pointerId)
  }

  const onDoubleClick = (e: MouseEvent) => {
    e.stopPropagation()
    if (scale() <= MIN_SCALE) zoomAtPoint(e.clientX, e.clientY, 2)
    else reset()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "+" || e.key === "=") {
      e.preventDefault()
      zoomCenter(1.2)
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault()
      zoomCenter(1 / 1.2)
    } else if (e.key === "0") {
      e.preventDefault()
      reset()
    } else if (e.key === "Escape") {
      props.onClose?.()
    }
  }

  const onResize = () => {
    reset()
    measureBase()
  }

  onMount(() => {
    imgRef?.addEventListener("wheel", onWheel, { passive: false })
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("resize", onResize)
    measureBase()
  })
  onCleanup(() => {
    imgRef?.removeEventListener("wheel", onWheel)
    window.removeEventListener("keydown", onKeyDown)
    window.removeEventListener("resize", onResize)
  })

  const percent = () => `${Math.round(scale() * 100)}%`
  const stop = (e: MouseEvent) => e.stopPropagation()

  return (
    <>
      <img
        ref={imgRef}
        data-slot="image-zoom-img"
        class={props.imgClass}
        src={props.src}
        alt={props.alt ?? ""}
        draggable={false}
        style={{ transform: transform(), "transform-origin": "center center", cursor: cursor() }}
        onLoad={() => {
          reset()
          measureBase()
        }}
        onClick={stop}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDblClick={onDoubleClick}
      />
      <div data-slot="image-zoom-toolbar" onClick={stop}>
        <button
          type="button"
          aria-label="Zoom in"
          disabled={scale() >= MAX_SCALE}
          onClick={() => zoomCenter(1.2)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        <span data-slot="image-zoom-percent">{percent()}</span>
        <button
          type="button"
          aria-label="Zoom out"
          disabled={scale() <= MIN_SCALE}
          onClick={() => zoomCenter(1 / 1.2)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M5 12h14" />
          </svg>
        </button>
        <button type="button" aria-label="Reset zoom" onClick={reset}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" />
          </svg>
        </button>
      </div>
    </>
  )
}
