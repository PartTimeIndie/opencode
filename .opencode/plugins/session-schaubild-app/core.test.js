import { describe, expect, test } from "bun:test"
import { DEFAULTS, SECTIONS, formatCapturedAt, imagePrompt, labelsPrompt, modelRequest, parseLabels, settings, todoBoard, todoBoardLines } from "./core.js"

describe("schaubild settings", () => {
  test("normalizes values and falls back to defaults", () => {
    expect(settings({ labelTarget: "model:acme/writer", language: " de " })).toEqual({ labelTarget: "model:acme/writer", language: "de" })
    expect(settings({ labelTarget: "  ", language: "" })).toEqual(DEFAULTS)
    expect(settings({})).toEqual(DEFAULTS)
  })
})

describe("schaubild model target", () => {
  test("parses model and chain references", () => {
    expect(modelRequest("acme/writer", "missing")).toEqual({ model: "acme/writer" })
    expect(modelRequest("model:acme/writer", "missing")).toEqual({ model: "acme/writer" })
    expect(modelRequest("chain:coder", "missing")).toEqual({ chain: "coder" })
    expect(modelRequest("default", "missing")).toEqual({ chain: "default" })
    expect(modelRequest("acme/writer/extra", "missing")).toEqual({ model: "acme/writer/extra" })
    expect(() => modelRequest("", "missing")).toThrow("missing")
    expect(() => modelRequest("chain: ", "missing")).toThrow("missing")
  })
})

describe("schaubild captured-at formatting", () => {
  test("renders a stable HH:MM local timestamp and survives invalid input", () => {
    const local = new Date(2026, 9, 3, 14, 5)
    expect(formatCapturedAt(local.getTime())).toBe("14:05")
    expect(formatCapturedAt(Number.NaN)).toBe("")
  })
})

describe("schaubild label prompt", () => {
  test("covers every section, wraps the context as untrusted and defines the interim rule", () => {
    const prompt = labelsPrompt({ messages: [], activity: { working: true } }, { language: "de" })
    for (const section of SECTIONS) expect(prompt.system).toContain(`"${section.key}"`)
    expect(prompt.system).toContain("Nur belegte Inhalte")
    expect(prompt.system).toContain("nicht-finaler Zwischenstand")
    expect(prompt.system).toContain("Agent arbeitet noch")
    expect(prompt.system).toContain("keine unfertige Arbeit als erledigt")
    expect(prompt.system).toContain("kanonischen Session-Todo-Speicher")
    expect(prompt.system).toContain("pending/in_progress/completed/cancelled")
    expect(prompt.system).toContain("erfinde niemals Todos oder Status")
    expect(prompt.prompt).toContain("UNTRUSTED_CONTEXT")
    expect(prompt.prompt).toContain("END_CONTEXT")
  })
})

describe("schaubild todo board", () => {
  const todos = {
    items: [
      { content: "Regel entfernen", status: "completed", priority: "high" },
      { content: "Bridge bauen", status: "in_progress", priority: "medium" },
      { content: "Deploy vorbereiten", status: "pending", priority: "low" },
      { content: "Alter Ansatz", status: "cancelled", priority: "low" },
      { content: "Mysteriös", status: "warte_auf_lieferant", priority: "low" },
    ],
    total: 5,
    truncated: false,
  }

  test("groups canonical statuses and labels unknown statuses honestly", () => {
    const board = todoBoard({ todos })
    expect(board.available).toBe(true)
    expect(board.empty).toBe(false)
    expect(board.total).toBe(5)
    expect(board.groups.map((group) => group.label)).toEqual(["Offen", "In Arbeit", "Erledigt", "Verworfen", "Unbekannter Status"])
    expect(board.groups.find((group) => group.label === "Unbekannter Status")?.items).toEqual(["Mysteriös (warte_auf_lieferant)"])
  })

  test("missing and empty todo lists stay honest", () => {
    expect(todoBoard({}).available).toBe(false)
    expect(todoBoard(undefined).available).toBe(false)
    const empty = todoBoard({ todos: { items: [], total: 0, truncated: false } })
    expect(empty.available).toBe(true)
    expect(empty.empty).toBe(true)
    expect(todoBoardLines(empty)).toEqual(["Todos: leer."])
    expect(todoBoardLines({ available: false, groups: [] })).toEqual(["Todos: keine Todo-Liste im Kontext verfügbar (nicht erfunden)."])
  })

  test("summarizes many todos per status and keeps details for the popup", () => {
    const board = todoBoard({ todos: { items: [
      { content: "a", status: "pending" }, { content: "b", status: "pending" },
      { content: "c", status: "pending" }, { content: "d", status: "pending" },
      { content: "e", status: "pending" },
    ], total: 5, truncated: false } })
    const lines = todoBoardLines(board)
    expect(lines[0]).toContain("Offen (5): a | b | c | d (+1 weitere, Details im Popup)")
  })

  test("the image prompt carries the authoritative board and honest fallback", () => {
    const withTodos = imagePrompt({ done: [], state: [], open: [], user: [], next: [] }, { board: todoBoard({ todos }) })
    expect(withTodos).toContain("Session-Todos")
    expect(withTodos).toContain("authoritative task entries")
    expect(withTodos).toContain("In Arbeit (1): Bridge bauen")
    expect(withTodos).toContain("Unbekannter Status (1): Mysteriös (warte_auf_lieferant)")
    const withoutTodos = imagePrompt({ done: [], state: [], open: [], user: [], next: [] }, {})
    expect(withoutTodos).toContain("Todos: keine Todo-Liste im Kontext verfügbar (nicht erfunden).")
  })
})

describe("schaubild label parsing", () => {
  test("accepts fenced JSON and trims items to the caps", () => {
    const payload = {
      done: ["Tests grün", "a".repeat(120)],
      state: ["Implementierung komplett"],
      open: ["Deploy offen"],
      user: ["Freigabe erteilen"],
      next: ["Deploy (Nutzer)", "Aufräumen (Agent)", "x", "y", "z"],
    }
    const raw = `Vorab ein Satz.\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``
    const result = parseLabels(raw)
    expect(result.ok).toBe(true)
    expect(result.labels.done).toHaveLength(2)
    expect(result.labels.done[1].length).toBeLessThanOrEqual(60)
    expect(result.labels.next).toHaveLength(4)
  })

  test("rejects invalid or incomplete answers with a reason", () => {
    expect(parseLabels("no json here").ok).toBe(false)
    expect(parseLabels("{broken").ok).toBe(false)
    expect(parseLabels('{"done":[]}').ok).toBe(false)
    expect(parseLabels('{"done":"x","state":[],"open":[],"user":[],"next":[]}').ok).toBe(false)
  })
})

describe("schaubild image prompt", () => {
  test("final diagram: relationship-aware layout instead of rigid boxes, no interim banner", () => {
    const labels = { done: ["Regel entfernt"], state: ["Plugin fertig"], open: [], user: [], next: ["QA (Nutzer)"] }
    const prompt = imagePrompt(labels)
    expect(prompt).toContain("Session-Status")
    expect(prompt).toContain("Choose the single clearest layout")
    expect(prompt).toContain("flow with arrows")
    expect(prompt).toContain("before/after")
    expect(prompt).toContain("Avoid a rigid grid")
    for (const section of SECTIONS) expect(prompt).toContain(section.heading)
    expect(prompt).not.toContain("Zwischenstand")
    expect(prompt).toContain("Deine nächsten Schritte: keine")
    expect(prompt).toContain("no user action is required")
    expect(prompt).toContain("invent no additional content")
  })

  test("interim diagram: banner with agent-still-working hint and capture time", () => {
    const capturedAt = new Date(2026, 9, 3, 14, 5).getTime()
    const prompt = imagePrompt({ done: [], state: ["Agent arbeitet noch"], open: ["E2E offen"], user: [], next: [] }, { interim: true, capturedAt })
    expect(prompt).toContain("Snapshot von 14:05 Uhr")
    expect(prompt).toContain("Agent arbeitet noch")
    expect(prompt).toContain("not a final result")
    expect(prompt).toContain("Offen: E2E offen")
    expect(prompt).toContain("invent no additional content")
  })

  test("emphasizes the action block when user steps exist", () => {
    const prompt = imagePrompt({ done: [], state: [], open: [], user: ["Freigabe erteilen"], next: [] })
    expect(prompt).toContain("Freigabe erteilen")
    expect(prompt).toContain("visually emphasized")
  })
})
