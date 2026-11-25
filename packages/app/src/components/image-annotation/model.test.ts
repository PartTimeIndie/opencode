import { describe, expect, test } from "bun:test"
import { commit, undo, redo, validateScene, type Mark, type Scene } from "./model"
import { imagePoint, move, path, rotate, validGesture } from "./geometry"

const mark: Mark = { id: "a", kind: "arrow", start: { x: 10, y: 20 }, end: { x: 80, y: 90 }, points: [], color: "#ff0000", width: 4, size: 24, text: "" }
const scene: Scene = { version: 1, width: 200, height: 100, marks: [] }
describe("annotation behavior", () => {
  test("arrow head follows the end in every quadrant", () => {
    for (const end of [{ x: 80, y: 90 }, { x: -80, y: 90 }, { x: -80, y: -90 }, { x: 80, y: -90 }, { x: 10, y: -90 }, { x: -80, y: 20 }]) {
      const value = path({ ...mark, end })
      expect(value).toContain(`L${end.x},${end.y}`)
      expect(value.split(`L${end.x},${end.y}`).length).toBe(3)
    }
  })
  test("rotation preserves midpoint, length and terminal head", () => {
    const turned = rotate(mark, Math.PI / 2)
    expect(Math.hypot(turned.end.x - turned.start.x, turned.end.y - turned.start.y)).toBeCloseTo(Math.hypot(70, 70))
    expect(turned.start.x + turned.end.x).toBeCloseTo(90)
    expect(path(turned)).toContain(`L${turned.end.x},${turned.end.y}`)
    expect(move(mark, { x: 4, y: -2 }).end).toEqual({ x: 84, y: 88 })
  })
  test("zoom/pan mapping uses the transformed image bounds", () => {
    expect(imagePoint({ x: 300, y: 150 }, { left: 100, top: 50, width: 400, height: 200 }, 200, 100)).toEqual({ x: 100, y: 50 })
  })
  test("one committed gesture undoes atomically and new changes discard redo", () => {
    const changed = commit({ past: [], present: scene, future: [] }, { ...scene, marks: [mark] })
    expect(undo(changed).present.marks).toHaveLength(0)
    expect(redo(undo(changed)).present.marks).toEqual([mark])
    expect(commit(undo(changed), { ...scene, marks: [{ ...mark, color: "#00ff00" }] }).future).toHaveLength(0)
    expect(changed.present.marks[0]).not.toBe(mark)
  })
  test("invalid geometry and degenerate gestures fail closed", () => {
    expect(validGesture({ ...mark, end: mark.start })).toBe(false)
    expect(() => validateScene({ ...scene, marks: [{ ...mark, width: NaN }] })).toThrow()
    expect(() => validateScene({ ...scene, marks: [mark, mark] })).toThrow()
    expect(() => validateScene({ ...scene, width: 100.5 })).toThrow()
  })
})
