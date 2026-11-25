import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { useI18n } from "../context/i18n"
import { IconButton } from "./icon-button"
import { ZoomableImage } from "./image-zoom"

export interface ImagePreviewProps {
  src: string
  alt?: string
  onAnnotate?: () => void
  annotateLabel?: string
}

export function ImagePreview(props: ImagePreviewProps) {
  const i18n = useI18n()
  return (
    <div data-component="image-preview">
      <div data-slot="image-preview-container">
        <Kobalte.Content data-slot="image-preview-content">
          <div data-slot="image-preview-header">
            {props.onAnnotate && <button type="button" data-action="annotate-copy" onClick={props.onAnnotate}>{props.annotateLabel ?? "Edit as new copy"}</button>}
            <Kobalte.CloseButton
              data-slot="image-preview-close"
              as={IconButton}
              icon="close"
              variant="ghost"
              aria-label={i18n.t("ui.common.close")}
            />
          </div>
          <div data-slot="image-preview-body">
            <ZoomableImage
              src={props.src}
              alt={props.alt ?? i18n.t("ui.imagePreview.alt")}
              imgClass="image-preview-image max-h-[calc(90vh-100px)] max-w-full rounded-lg object-contain"
            />
          </div>
        </Kobalte.Content>
      </div>
    </div>
  )
}
