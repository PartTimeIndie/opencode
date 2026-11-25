export type Point = { x: number; y: number }
export type Tool = "select" | "pan" | "freehand" | "line" | "arrow" | "rectangle" | "ellipse" | "text" | "emoji"
export type Mark = {
  id: string
  kind: Exclude<Tool, "select" | "pan">
  start: Point
  end: Point
  points: Point[]
  color: string
  width: number
  size: number
  text: string
}
export type Scene = { version: 1; width: number; height: number; marks: Mark[] }
export type AnnotationRef = { version: 1; documentID: string; revision: number; scope: string }
export type History = { past: Scene[]; present: Scene; future: Scene[] }

export function validateScene(scene: Scene): Scene {
  const point = (p: Point) => p && Number.isFinite(p.x) && Number.isFinite(p.y)
  if (scene.version !== 1 || !Number.isSafeInteger(scene.width) || !Number.isSafeInteger(scene.height) || scene.width <= 0 || scene.height <= 0 || !Array.isArray(scene.marks)) throw new Error("Invalid annotation document")
  const ids = new Set<string>()
  for (const m of scene.marks) {
    if (!m || typeof m.id !== "string" || !m.id || ids.has(m.id) || !["freehand", "line", "arrow", "rectangle", "ellipse", "text", "emoji"].includes(m.kind) || !point(m.start) || !point(m.end) || !Array.isArray(m.points) || !m.points.every(point) || !/^#[\da-f]{6}$/i.test(m.color) || !Number.isFinite(m.width) || m.width <= 0 || !Number.isFinite(m.size) || m.size <= 0 || typeof m.text !== "string") throw new Error("Invalid annotation object")
    ids.add(m.id)
  }
  return scene
}

export function commit(history: History, scene: Scene): History {
  validateScene(scene)
  if (JSON.stringify(scene) === JSON.stringify(history.present)) return history
  return { past: [...history.past, history.present].slice(-100), present: structuredClone(scene), future: [] }
}
export function undo(history: History): History {
  const previous = history.past.at(-1)
  return previous ? { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] } : history
}
export function redo(history: History): History {
  const next = history.future[0]
  return next ? { past: [...history.past, history.present], present: next, future: history.future.slice(1) } : history
}
