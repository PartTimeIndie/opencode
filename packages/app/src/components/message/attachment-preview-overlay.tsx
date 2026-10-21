import { Show, createEffect, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"

export interface Attachment {
  id: string
  mediaType: string
  url: string
  filename?: string
  sizeBytes?: number
}

export interface AttachmentPreviewOverlayProps {
  attachment: Attachment | null
  onClose: () => void
}

export const isImageAttachment = (mediaType: string) => mediaType.toLowerCase().startsWith("image/")
export const isVideoAttachment = (mediaType: string) => mediaType.toLowerCase().startsWith("video/")

export const AttachmentPreviewOverlay: Component<AttachmentPreviewOverlayProps> = (props) => {
  const [preview, setPreview] = createStore({ zoom: 1 })

  createEffect(() => {
    props.attachment?.id
    setPreview("zoom", 1)
  })

  const adjustZoom = (delta: number) => setPreview("zoom", Math.min(4, Math.max(1, preview.zoom + delta)))

  return (
    <Portal>
      <Show when={props.attachment}>
        {(current) => (
          <div
            data-component="attachment-fullscreen-overlay"
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6"
            onClick={() => props.onClose()}
          >
            <button
              data-component="attachment-preview-close"
              class="absolute right-4 top-14 z-10 flex size-9 items-center justify-center rounded-full bg-surface-raised-stronger text-text-strong hover:bg-surface-raised-stronger-hover"
              aria-label="Close"
              onClick={(e) => {
                e.stopPropagation()
                props.onClose()
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
            <Show when={isImageAttachment(current().mediaType)}>
              <div
                class="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full bg-surface-raised-stronger/95 p-1 text-text-strong shadow-lg"
                onClick={(e) => e.stopPropagation()}
              >
                <button class="rounded-full px-3 py-1 text-13-medium hover:bg-surface-raised-stronger-hover" onClick={() => adjustZoom(-0.5)}>
                  −
                </button>
                <button class="rounded-full px-3 py-1 text-13-medium hover:bg-surface-raised-stronger-hover" onClick={() => setPreview("zoom", 1)}>
                  {Math.round(preview.zoom * 100)}%
                </button>
                <button class="rounded-full px-3 py-1 text-13-medium hover:bg-surface-raised-stronger-hover" onClick={() => adjustZoom(0.5)}>
                  +
                </button>
              </div>
            </Show>
            <Show
              when={isImageAttachment(current().mediaType)}
              fallback={
                <video
                  // eslint-disable-next-line solid/no-react-specific-props
                  controls
                  autoplay
                  class="max-h-[85vh] max-w-[90vw] rounded-lg"
                  src={current().url}
                  onClick={(e) => e.stopPropagation()}
                />
              }
            >
              <div class="flex max-h-[85vh] max-w-[90vw] overflow-auto rounded-lg" onClick={(e) => e.stopPropagation()}>
                <img
                  class="rounded-lg object-contain"
                  src={current().url}
                  alt={current().filename ?? "attachment"}
                  style={{
                    "max-height": preview.zoom === 1 ? "85vh" : "none",
                    "max-width": preview.zoom === 1 ? "90vw" : "none",
                    width: preview.zoom === 1 ? "auto" : `${preview.zoom * 100}%`,
                  }}
                  onClick={() => setPreview("zoom", preview.zoom === 1 ? 2 : 1)}
                />
              </div>
            </Show>
          </div>
        )}
      </Show>
    </Portal>
  )
}
