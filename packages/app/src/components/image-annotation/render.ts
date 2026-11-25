import type { Mark } from "./model"

const tiles = new Map<string, { url: string; canvas: HTMLCanvasElement; width: number; height: number }>()
export function textTile(mark: Mark) {
  const color = mark.kind === "emoji" ? "#000000" : mark.color
  const key = JSON.stringify([mark.kind, mark.text, mark.size, color])
  const cached = tiles.get(key)
  if (cached) return cached
  const canvas = document.createElement("canvas")
  const context = canvas.getContext("2d")
  if (!context) throw new Error("Image rendering is unavailable")
  const font = `${mark.size}px ${mark.kind === "emoji" ? '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji",' : ""} sans-serif`
  context.font = font
  const lines = mark.text.split("\n")
  canvas.width = Math.max(1, Math.ceil(Math.max(...lines.map((line) => context.measureText(line).width)) + mark.size * 0.5))
  canvas.height = Math.max(1, Math.ceil(lines.length * mark.size * 1.4))
  context.font = font
  context.textBaseline = "top"
  context.fillStyle = color
  lines.forEach((line, index) => context.fillText(line, mark.size * 0.15, index * mark.size * 1.4))
  const tile = { url: canvas.toDataURL("image/png"), canvas, width: canvas.width, height: canvas.height }
  if (tiles.size >= 200) tiles.delete(tiles.keys().next().value!)
  tiles.set(key, tile)
  return tile
}
export function clearTextTiles() { tiles.clear() }
