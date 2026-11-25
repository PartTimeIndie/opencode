import { path } from "./geometry"
import { validateScene, type Scene } from "./model"
import { textTile } from "./render"
import { requireStaticImage } from "./source-format"

export async function decodeImage(blob: Blob) {
  await requireStaticImage(blob)
  const url = URL.createObjectURL(blob)
  const image = new Image()
  image.src = url
  return image.decode().then(() => image).finally(() => URL.revokeObjectURL(url))
}
export async function exportAnnotation(original: Blob, scene: Scene): Promise<Blob> {
  validateScene(scene)
  await document.fonts?.ready
  const image = await decodeImage(original)
  if (image.naturalWidth !== scene.width || image.naturalHeight !== scene.height) throw new Error("Annotation dimensions do not match the original image")
  const canvas = document.createElement("canvas")
  canvas.width = scene.width
  canvas.height = scene.height
  const context = canvas.getContext("2d")
  if (!context || canvas.width !== scene.width || canvas.height !== scene.height) throw new Error("Image exceeds the canvas limits")
  context.drawImage(image, 0, 0, scene.width, scene.height)
  scene.marks.forEach((mark) => {
    if (mark.kind === "text" || mark.kind === "emoji") {
      context.drawImage(textTile(mark).canvas, mark.start.x, mark.start.y)
      return
    }
    context.strokeStyle = mark.color
    context.lineWidth = mark.width
    context.lineCap = "round"
    context.lineJoin = "round"
    context.stroke(new Path2D(path(mark)))
  })
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob?.size ? resolve(blob) : reject(new Error("PNG export failed. Your edits have been kept.")), "image/png"))
}
