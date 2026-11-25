import type { AnnotationLabels } from "./image-annotation-editor"

export function annotationLabels(t: (key: `imageAnnotation.${keyof AnnotationLabels}`) => string): AnnotationLabels {
  const keys: (keyof AnnotationLabels)[] = ["title", "apply", "cancel", "discard", "keep", "unsaved", "saving", "color", "width", "size", "search", "all", "undo", "redo", "delete", "text", "select", "pan", "freehand", "line", "arrow", "rectangle", "ellipse", "emoji", "zoomIn", "zoomOut", "fit", "closePicker"]
  return Object.fromEntries(keys.map((key) => [key, t(`imageAnnotation.${key}`)])) as AnnotationLabels
}
