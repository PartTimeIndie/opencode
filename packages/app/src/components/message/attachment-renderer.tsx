import { For, Show, createSignal, type Component } from "solid-js"
import {
  AttachmentPreviewOverlay,
  isImageAttachment,
  isVideoAttachment,
  type Attachment,
} from "./attachment-preview-overlay"
export type { Attachment } from "./attachment-preview-overlay"

// Feature 2 — AttachmentRenderer.
// Renders media/file attachments the agent produces (via the `attach` tool) inline
// in the chat. Images and videos get a fullscreen overlay; other files get a
// download card. Dispatch is by `mediaType`, so it reuses the existing FilePart
// shape (`mediaType`/`url`/`filename`) without a new schema variant for rendering.

export interface AttachmentRendererProps {
  attachments: Attachment[]
  // Optional heading rendered above the grid (e.g. "Attached deliverables").
  label?: string
}

function formatSize(bytes?: number) {
  if (!bytes && bytes !== 0) return undefined
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const AttachmentRenderer: Component<AttachmentRendererProps> = (props) => {
  const [active, setActive] = createSignal<Attachment | null>(null)

  return (
    <div data-component="attachment-renderer" class="w-full">
      <Show when={props.label}>
        <div class="text-12-medium text-text-weak mb-1.5 px-1">{props.label}</div>
      </Show>
      <div class="flex flex-wrap gap-2">
        <For each={props.attachments}>
          {(attachment) => (
            <Show
              when={isImageAttachment(attachment.mediaType)}
              fallback={
                <Show
                  when={isVideoAttachment(attachment.mediaType)}
                  fallback={<FileCard attachment={attachment} />}
                >
                  <VideoCard attachment={attachment} onOpen={() => setActive(attachment)} />
                </Show>
              }
            >
              <ImageCard attachment={attachment} onOpen={() => setActive(attachment)} />
            </Show>
          )}
        </For>
      </div>

      <AttachmentPreviewOverlay attachment={active()} onClose={() => setActive(null)} />
    </div>
  )
}

const ImageCard: Component<{ attachment: Attachment; onOpen: () => void }> = (props) => (
  <button
    data-attachment-id={props.attachment.id}
    data-attachment-kind="image"
    class="group relative overflow-hidden rounded-lg border border-border-weak-base bg-surface-base"
    title={props.attachment.filename ?? "image"}
    onClick={() => props.onOpen()}
  >
    <img class="h-32 w-32 object-cover" src={props.attachment.url} alt={props.attachment.filename ?? "image"} />
    <span class="absolute bottom-0 left-0 right-0 truncate bg-black/55 px-1.5 py-0.5 text-11-regular text-white opacity-0 group-hover:opacity-100">
      {props.attachment.filename}
    </span>
  </button>
)

const VideoCard: Component<{ attachment: Attachment; onOpen: () => void }> = (props) => (
  <button
    data-attachment-id={props.attachment.id}
    data-attachment-kind="video"
    class="group relative flex h-32 w-48 items-center justify-center overflow-hidden rounded-lg border border-border-weak-base bg-black"
    title={props.attachment.filename ?? "video"}
    onClick={() => props.onOpen()}
  >
    <video class="h-full w-full object-cover" src={props.attachment.url} preload="metadata" />
    <span class="absolute flex size-10 items-center justify-center rounded-full bg-white/85 text-black shadow-lg transition group-hover:scale-110">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M8 5v14l11-7z" />
      </svg>
    </span>
    <span class="absolute bottom-0 left-0 right-0 truncate bg-black/55 px-1.5 py-0.5 text-11-regular text-white">
      {props.attachment.filename}
    </span>
  </button>
)

const FileCard: Component<{ attachment: Attachment }> = (props) => (
  <a
    data-attachment-id={props.attachment.id}
    data-attachment-kind="file"
    class="flex w-56 items-center gap-2.5 rounded-lg border border-border-weak-base bg-surface-base px-3 py-2 text-left hover:bg-surface-raised-base-hover"
    href={props.attachment.url}
    download={props.attachment.filename}
  >
    <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-raised-base text-icon-info-active">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" />
      </svg>
    </span>
    <span class="min-w-0">
      <span class="block truncate text-13-medium text-text-strong">{props.attachment.filename ?? "file"}</span>
      <Show when={formatSize(props.attachment.sizeBytes) || props.attachment.mediaType}>
        {(meta) => <span class="block truncate text-11-regular text-text-weak">{meta()}</span>}
      </Show>
    </span>
  </a>
)
