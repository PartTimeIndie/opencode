export const DEFAULTS = { labelTarget: "default", language: "de" }

export const SECTIONS = [
  { key: "done", heading: "Erledigt" },
  { key: "state", heading: "Aktueller Stand" },
  { key: "open", heading: "Offen" },
  { key: "user", heading: "Deine nächsten Schritte" },
  { key: "next", heading: "Nächste Schritte" },
]

const MAX_LABELS = 4
const MAX_LABEL_CHARS = 60

export function settings(value = {}) {
  return {
    labelTarget: typeof value.labelTarget === "string" && value.labelTarget.trim() ? value.labelTarget.trim() : DEFAULTS.labelTarget,
    language: typeof value.language === "string" && value.language.trim() ? value.language.trim().slice(0, 32) : "de",
  }
}

export function modelRequest(target, message) {
  if (!target) throw new Error(message)
  if (target.startsWith("chain:")) {
    if (!target.slice(6).trim()) throw new Error(message)
    return { chain: target.slice(6) }
  }
  const model = target.startsWith("model:") ? target.slice(6) : target
  if (!model.includes("/")) return { chain: model }
  if (!/^[^/\s]+\/\S+$/u.test(model)) throw new Error(message)
  return { model }
}

export function formatCapturedAt(ms) {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ""
  const pad = (value) => String(value).padStart(2, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// Canonical SessionTodo statuses; anything else is labelled honestly instead
// of being remapped into a status it never had.
export const TODO_STATUS_LABELS = { pending: "Offen", in_progress: "In Arbeit", completed: "Erledigt", cancelled: "Verworfen" }
export const TODO_BOARD_LIMIT = 4

export function todoBoard(context) {
  const todos = context?.todos
  if (!todos || !Array.isArray(todos.items)) return { available: false, groups: [], empty: false, total: undefined, truncated: false }
  const known = new Set(Object.keys(TODO_STATUS_LABELS))
  const groups = Object.entries(TODO_STATUS_LABELS)
    .map(([status, label]) => ({ label, items: todos.items.filter((todo) => todo.status === status).map((todo) => todo.content) }))
    .filter((group) => group.items.length > 0)
  const unknown = todos.items.filter((todo) => !known.has(todo.status))
  if (unknown.length > 0) groups.push({ label: "Unbekannter Status", items: unknown.map((todo) => `${todo.content} (${todo.status})`) })
  return { available: true, groups, empty: todos.items.length === 0, total: todos.total, truncated: todos.truncated }
}

export function todoBoardLines(board) {
  if (!board || !board.available) return ["Todos: keine Todo-Liste im Kontext verfügbar (nicht erfunden)."]
  if (board.empty) return ["Todos: leer."]
  const lines = board.groups.map((group) => {
    const shown = group.items.slice(0, TODO_BOARD_LIMIT).join(" | ")
    const more = group.items.length > TODO_BOARD_LIMIT ? ` (+${group.items.length - TODO_BOARD_LIMIT} weitere, Details im Popup)` : ""
    return `${group.label} (${group.items.length}): ${shown}${more}`
  })
  if (board.truncated) lines.push(`Der Speicher enthielt mehr Todos als übertragen (${board.total} gesamt); Details im Popup.`)
  return lines
}

// Popup view: every transferred todo entry, uncut. The board itself is capped
// at transfer time (context.todos), anything beyond that store limit is named
// honestly instead of hidden.
export function todoDetails(board) {
  if (!board || !board.available) return ["Todos: keine Todo-Liste im Kontext verfügbar (nicht erfunden)."]
  if (board.empty) return ["Todos: leer."]
  const lines = []
  let transferred = 0
  for (const group of board.groups) {
    lines.push(`${group.label} (${group.items.length}):`)
    for (const item of group.items) {
      lines.push(`- ${item}`)
      transferred++
    }
  }
  if (board.truncated) lines.push(`Der Speicher enthielt mehr Todos als übertragen (${board.total} gesamt); hier stehen alle ${transferred} übertragenen Einträge.`)
  return lines
}

export function labelsPrompt(context, config) {
  const headings = SECTIONS.map((section) => `"${section.key}" (${section.heading})`).join(", ")
  return {
    system: `Du verdichtest den aktuellen Stand eines Agenten-Chats in kurze Beschriftungen für ein kleines Schaubild. Antworte NUR mit einem JSON-Objekt mit genau diesen Schlüsseln: ${headings}. Jeder Schlüssel enthält maximal ${MAX_LABELS} kurze Beschriftungen mit höchstens ${MAX_LABEL_CHARS} Zeichen. "done": erledigte Ergebnisse. "state": aktueller Zustand. "open": offene Punkte, Blocker, fehlgeschlagene Prüfungen. "user": was der Nutzer konkret tun oder entscheiden muss; leer, wenn nichts nötig ist. "next": nächste Schritte mit Kürzel des Ausführenden in Klammern, z. B. "(Agent)" oder "(Nutzer)". Nur belegte Inhalte aus dem Kontext; erfinde keine Testerfolge, Kennzahlen oder Ergebnisse. Nicht-Erledigtes gehört in "open", nicht in "done". Der Kontext enthält "todos" aus dem kanonischen Session-Todo-Speicher mit den Statuswerten pending/in_progress/completed/cancelled; diese Liste ist verbindlich: completed gehört in "done", pending/in_progress in "open" bzw. "next". Fehlt "todos", vermerke in "state" ehrlich, dass keine Todo-Liste verfügbar ist; erfinde niemals Todos oder Status. Läuft der Agent gerade (activity.working=true), ist alles ein nicht-finaler Zwischenstand: vermerke das kurz in einer "state"-Beschriftung (z. B. "Agent arbeitet noch") und stelle keine unfertige Arbeit als erledigt dar. Sprache: ${config.language}.`,
    prompt: `UNTRUSTED_CONTEXT\n${JSON.stringify(context)}\nEND_CONTEXT`,
  }
}

export function parseLabels(value) {
  const text = typeof value === "string" ? value : ""
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return { ok: false, reason: "Die KI hat kein JSON mit Beschriftungen geliefert." }
  let parsed
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return { ok: false, reason: "Die Beschriftungen sind kein gültiges JSON." }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "Die Beschriftungen sind kein JSON-Objekt." }
  const labels = {}
  for (const section of SECTIONS) {
    if (!Array.isArray(parsed[section.key])) return { ok: false, reason: `Sektion "${section.key}" fehlt oder ist keine Liste.` }
    labels[section.key] = parsed[section.key]
      .filter((item) => typeof item === "string" && item.trim())
      .map((item) => item.trim().slice(0, MAX_LABEL_CHARS))
      .slice(0, MAX_LABELS)
  }
  return { ok: true, labels }
}

export function labelList(labels, key) {
  const items = labels?.[key] ?? []
  return items.length > 0 ? items : ["keine"]
}

export function imagePrompt(labels, meta = {}) {
  const sections = SECTIONS.map((section) => `${section.heading}: ${labelList(labels, section.key).join(" | ")}`).join("\n")
  const noUserAction = (labels?.user ?? []).length === 0
  const captured = formatCapturedAt(meta.capturedAt) || "unbekannter Zeit"
  return [
    "Flat minimal infographic, white background, landscape, clean sans-serif, high legibility, no watermark.",
    `Prominent status banner across the top: "Snapshot von ${captured} Uhr".`,
    ...(meta.interim
      ? ['The banner must additionally read "Agent arbeitet noch". The diagram shows a moment in time, not a final result; later chat progress is not included.']
      : ['The banner must additionally state that this is the state at that moment; later chat progress is not included.']),
    'Title: "Session-Status".',
    "Choose the single clearest layout that shows the relationship between the content - for example a left-to-right flow with arrows, a vertical roadmap, or a before/after split. Avoid a rigid grid of five identical boxes.",
    "All five content groups must still appear with their headings:",
    sections,
    "Add a clearly separated \"Session-Todos\" board built ONLY from these authoritative task entries:",
    ...todoBoardLines(meta.board ?? { available: false, groups: [] }),
    ...(noUserAction
      ? ['The "Deine nächsten Schritte" section must clearly show that no user action is required right now.']
      : ['The "Deine nächsten Schritte" section must be visually emphasized as the action block.']),
    "Use only the provided label texts verbatim, invent no additional content, no fake chart data.",
  ].join("\n")
}

export function createController(api, options = {}) {
  const listeners = new Set()
  const state = { phase: "idle", status: "Schaubild erzeugen", labels: undefined, image: "", source: undefined, partial: false, interim: false, capturedAt: undefined, todos: undefined, error: "" }
  let generation = 0
  let request
  let deadline
  const emit = () => listeners.forEach((listener) => listener(state))
  const active = () => state.phase === "working"
  const clearDeadline = () => clearTimeout(deadline)
  const deadlineTimer = (milliseconds, message) => {
    clearDeadline()
    deadline = setTimeout(() => fail(new Error(message)), milliseconds)
  }
  const fail = (error) => {
    clearDeadline()
    state.phase = "error"
    state.error = error instanceof Error ? error.message : String(error)
    state.status = state.error
    emit()
  }
  const finishIdle = (status) => {
    clearDeadline()
    Object.assign(state, { phase: "idle", status })
    emit()
  }
  const stop = () => {
    generation++
    request?.abort()
    request = undefined
    finishIdle("Gestoppt")
  }
  const dispose = () => {
    generation++
    request?.abort()
    request = undefined
    clearDeadline()
    listeners.clear()
  }
  api.signal.addEventListener("abort", dispose, { once: true })

  const readContext = async (source, signal) => {
    if (typeof api.host.sessions.context !== "function") throw new Error("Host aktualisieren: Session-Kontext-API fehlt.")
    const result = await api.host.sessions.context({ ...source, limit: 80, maxTextChars: 24_000, signal })
    if (signal.aborted) throw new Error("Abgebrochen")
    if (!result.ok) throw new Error(result.error.message)
    if (result.context.session.id !== source.sessionID) throw new Error("Der gelieferte Kontext gehört nicht zum angeklickten Chat.")
    return result.context
  }

  const generate = async (target) => {
    if (!target?.directory || !target.sessionID || api.signal.aborted) return
    if (active()) return
    request?.abort()
    const current = ++generation
    const source = { directory: target.directory, sessionID: target.sessionID }
    const config = settings({ labelTarget: api.settings.get("labelTarget", DEFAULTS.labelTarget), language: api.settings.get("language", DEFAULTS.language) })
    const controller = new AbortController()
    request = controller
    const signal = AbortSignal.any([api.signal, controller.signal])
    const ensure = () => {
      if (current !== generation || signal.aborted) throw new Error("Abgebrochen")
    }
    Object.assign(state, { phase: "working", status: "Sessionstand auswerten", labels: undefined, image: "", source, partial: false, interim: false, capturedAt: undefined, todos: undefined, error: "" })
    emit()
    deadlineTimer(options.labelTimeoutMs ?? 120_000, "Zeitüberschreitung beim Auswerten – bitte erneut erzeugen.")
    try {
      const context = await readContext(source, signal)
      ensure()
      // Snapshot attribution: the popup shows which chat/title/time this
      // frozen snapshot came from, so a later session switch can never
      // silently present an old image as the current chat.
      source.title = context.session.title
      // Read-only snapshot: a running agent is documented as interim instead of
      // being blocked or interrupted. There is deliberately no fingerprint
      // re-read; every capture is timestamped instead.
      const interim = !!context.activity.working
      if (!context.messages.some((message) => message.role === "assistant") && !interim && context.totals.questions + context.totals.controls + context.totals.permissions === 0) {
        finishIdle("Noch kein Agentenergebnis zum Veranschaulichen.")
        return
      }
      state.interim = interim
      state.capturedAt = context.capturedAt
      state.todos = todoBoard(context)
      state.partial = Object.values(context.truncated).some(Boolean) || !context.boundaryComplete
      const target2 = modelRequest(config.labelTarget, "Beschriftungsmodell in den Plugin-Einstellungen auswählen.")
      const base = labelsPrompt(context, config)
      const runLabels = async (input) => {
        const answer = await api.host.ai.run({ ...target2, directory: source.directory, ...input, tools: [], generation: { maxTokens: 2048, temperature: 0.2 }, signal })
        ensure()
        if (!answer.ok) throw new Error(answer.error || "Beschriftungen konnten nicht erzeugt werden.")
        return answer.text
      }
      const raw = await runLabels(base)
      const first = parseLabels(raw)
      const validated = first.ok
        ? first
        : parseLabels(
            await runLabels({
              system: base.system,
              prompt: `${base.prompt}\n\nKorrigiere die vorherige Antwort vollständig. Fehler: ${first.reason}\nUNTRUSTED_DRAFT\n${String(raw).slice(0, 16_000)}\nEND_DRAFT\nAntworte NUR mit dem geforderten JSON-Objekt.`,
            }),
          )
      ensure()
      if (!validated.ok) throw new Error(validated.reason)
      // Atomic click snapshot: evaluation and image are attributed to the
      // frozen click-time context. There is deliberately no re-read that
      // could invalidate live sessions on every generation, no retry loop
      // and no invented todo statuses. Session switches stay bound to the
      // click-time source object (closure); aborts still cancel via ensure().
      Object.assign(state, { labels: validated.labels, status: interim ? "Zwischenstand generieren" : "Schaubild generieren" })
      emit()
      deadlineTimer(options.imageTimeoutMs ?? 330_000, "Zeitüberschreitung bei der Bildgenerierung – bitte erneut erzeugen.")
      const image = await api.host.images.generate({ prompt: imagePrompt(validated.labels, { interim, capturedAt: context.capturedAt, board: todoBoard(context) }), size: "1536x1024", format: "png", signal })
      ensure()
      if (!image.ok) throw new Error(image.error || "Bildgenerierung fehlgeschlagen.")
      clearDeadline()
      Object.assign(state, { phase: "done", status: interim ? "Zwischenstand bereit (Agent läuft weiter)" : "Schaubild bereit", image: `data:${image.mime};base64,${image.data}` })
      emit()
    } catch (error) {
      if (current !== generation || signal.aborted) return
      fail(error)
    } finally {
      if (request === controller) request = undefined
    }
  }

  return { state, generate, stop, active, dispose, subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener) } }
}
