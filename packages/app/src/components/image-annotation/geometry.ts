import type { Mark, Point } from "./model"

export function imagePoint(client: Point, rect: { left: number; top: number; width: number; height: number }, width: number, height: number): Point {
  return { x: (client.x - rect.left) * width / rect.width, y: (client.y - rect.top) * height / rect.height }
}
export function move(mark: Mark, delta: Point): Mark {
  const translate = (p: Point) => ({ x: p.x + delta.x, y: p.y + delta.y })
  return { ...mark, start: translate(mark.start), end: translate(mark.end), points: mark.points.map(translate) }
}
export function rotate(mark: Mark, radians: number): Mark {
  const center = { x: (mark.start.x + mark.end.x) / 2, y: (mark.start.y + mark.end.y) / 2 }
  const turn = (p: Point) => ({ x: center.x + (p.x - center.x) * Math.cos(radians) - (p.y - center.y) * Math.sin(radians), y: center.y + (p.x - center.x) * Math.sin(radians) + (p.y - center.y) * Math.cos(radians) })
  return { ...mark, start: turn(mark.start), end: turn(mark.end), points: mark.points.map(turn) }
}
export function path(mark: Mark): string {
  const a = mark.start
  const b = mark.end
  if (mark.kind === "freehand") return mark.points.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ")
  if (mark.kind === "rectangle") return `M${a.x},${a.y} L${b.x},${a.y} L${b.x},${b.y} L${a.x},${b.y} Z`
  if (mark.kind === "ellipse") {
    const rx = Math.abs(b.x - a.x) / 2
    const ry = Math.abs(b.y - a.y) / 2
    const cy = (a.y + b.y) / 2
    return `M${Math.min(a.x, b.x)},${cy} a${rx},${ry} 0 1,0 ${2 * rx},0 a${rx},${ry} 0 1,0 ${-2 * rx},0`
  }
  const stem = `M${a.x},${a.y} L${b.x},${b.y}`
  if (mark.kind !== "arrow") return stem
  const angle = Math.atan2(b.y - a.y, b.x - a.x)
  const head = Math.min(Math.hypot(b.x - a.x, b.y - a.y) * 0.4, Math.max(12, mark.width * 4))
  const wing = (offset: number) => `${b.x - head * Math.cos(angle + offset)},${b.y - head * Math.sin(angle + offset)}`
  return `${stem} M${wing(0.5)} L${b.x},${b.y} L${wing(-0.5)}`
}
export function validGesture(mark: Mark) {
  return mark.kind === "text" || mark.kind === "emoji" || Math.hypot(mark.end.x - mark.start.x, mark.end.y - mark.start.y) >= 2 || (mark.kind === "freehand" && mark.points.length > 2)
}
