import { createController, SECTIONS, formatCapturedAt, labelList, todoDetails } from "./core.js"

const ICON = new URL("./assets/session-schaubild.svg", import.meta.url).href

export default {
  id: "session-schaubild-app",
  app(api) {
    // Settings register before the controller reads them on click; the runtime
    // snapshot semantics are only relevant for subscribe-based controllers.
    api.settings.register({ id: "schaubildSettings", title: "Schaubild", searchTerms: ["Schaubild", "Diagram", "Status", "Übersicht", "Infografik"], sections: [
      { title: "Beschriftungen", fields: [
        { key: "labelTarget", type: "model-target", label: "Beschriftungsmodell oder Kette", default: "default", required: true, autoSelectDefault: true, description: "Nur der nötige Chatkontext geht an dieses Modell, um kurze Schaubild-Beschriftungen zu ziehen. Kein neuer Agentenchat." },
        { key: "language", type: "text", label: "Sprache", default: "de" },
      ] },
    ] })
    const controller = createController(api)
    // The click promise is the finished diagram: the first "done" after a new
    // generation opens the overlay inline; a rerun updates the open overlay.
    // Closing the popup (button, Escape, host dismiss) aborts the mount signal
    // and clears the handle, so the next diagram really opens a fresh popup.
    let overlay
    let awaitingDiagram = false
    const show = () => {
      if (!overlay) overlay = openDiagram(api, controller, () => { overlay = undefined })
    }
    controller.subscribe((state) => {
      if (state.phase === "working") awaitingDiagram = true
      if (state.phase === "done" && awaitingDiagram) {
        awaitingDiagram = false
        show()
      }
    })
    api.toolbar.register({ id: "sessionSchaubild", title: "Schaubild", tooltip: "Schaubild des aktuellen Sessionstands erzeugen", placement: "composer", align: "right", kind: "mount", mobile: "visible", defaultVisible: true, order: 61,
      mount(context) { return mountToolbar(controller, context) },
    })
    api.commands.register({ id: "session-schaubild.generate", title: "Schaubild erzeugen", category: "Schaubild", run: () => { void controller.generate(api.host.navigation.current()) } })
    api.commands.register({ id: "session-schaubild.show", title: "Letztes Schaubild anzeigen", category: "Schaubild", run: () => { openDiagram(api, controller) } })
  },
}

export function mountToolbar(controller, context) {
  const style = document.createElement("style")
  style.textContent = `.oc-session-schaubild button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:4px;border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer}.oc-session-schaubild button:hover{background:var(--background-stronger)}.oc-session-schaubild button:focus-visible{outline:2px solid currentColor;outline-offset:1px}.oc-session-schaubild button:disabled{opacity:.4;cursor:default}.oc-session-schaubild{display:inline-flex;color:inherit}.oc-session-schaubild__icon{width:18px;height:18px;background:currentColor;mask:url("${ICON}") center/contain no-repeat}.oc-session-schaubild [hidden]{display:none}`
  const root = document.createElement("span")
  root.className = "oc-session-schaubild"
  const button = document.createElement("button")
  button.type = "button"
  button.dataset.action = "session-schaubild-generate"
  button.setAttribute("aria-label", "Schaubild erzeugen")
  const icon = document.createElement("span")
  icon.className = "oc-session-schaubild__icon"
  icon.setAttribute("aria-hidden", "true")
  button.append(icon)
  const unsubscribe = controller.subscribe((state) => {
    button.disabled = !context.context?.directory || !context.context?.sessionID || state.phase === "working"
    button.title = state.error || state.status
    root.dataset.phase = state.phase
  })
  const onGenerate = () => { void controller.generate(context.context) }
  button.addEventListener("click", onGenerate)
  root.append(button)
  context.element.replaceChildren(style, root)
  const dispose = () => {
    unsubscribe()
    button.removeEventListener("click", onGenerate)
    context.element.replaceChildren()
  }
  context.signal.addEventListener("abort", dispose, { once: true })
  return dispose
}

export function openDiagram(api, controller, onClosed) {
  const overlay = api.ui.overlay.open({ id: "session-schaubild", title: "Schaubild", ariaLabel: "Schaubild des Sessionstands", mount({ element, signal }) {
    // Fires for every close path (close button, Escape, host dismiss).
    if (onClosed) signal.addEventListener("abort", onClosed, { once: true })
    const expected = document.createElement("p")
    const status = document.createElement("p")
    const image = document.createElement("img")
    image.alt = "Schaubild des Sessionstands"
    image.style.cssText = "max-width:100%;height:auto;display:none;border-radius:8px"
    const labels = document.createElement("div")
    const todos = document.createElement("div")
    todos.style.cssText = "white-space:pre-line"
    const source = document.createElement("p")
    source.style.cssText = "opacity:.7"
    const regenerate = document.createElement("button")
    regenerate.type = "button"
    regenerate.textContent = "Neu erzeugen"
    const close = document.createElement("button")
    close.type = "button"
    close.textContent = "Schließen"
    const actions = document.createElement("div")
    actions.style.cssText = "display:flex;gap:8px;margin-top:10px"
    for (const button of [regenerate, close]) button.style.cssText = "padding:6px 12px;border-radius:6px;border:1px solid var(--border, currentColor);background:transparent;color:inherit;cursor:pointer"
    const render = (state) => {
      const stand = state.capturedAt ? ` Stand: ${formatCapturedAt(state.capturedAt)} Uhr.` : ""
      expected.textContent = state.phase === "working"
        ? "Erwartet: Kurz warten, das Schaubild wird erzeugt."
        : state.interim
          ? `Erwartet: Keine Aktion nötig. Zwischenstand – der Agent läuft weiter.${stand} Späterer Chatverlauf ist nicht enthalten.`
          : `Erwartet: Keine Aktion nötig. Snapshot eines Moments${stand} Späterer Chatverlauf ist nicht enthalten.`
      status.textContent = state.status
      image.style.display = state.image ? "block" : "none"
      if (state.image) image.src = state.image
      labels.replaceChildren(
        ...SECTIONS.map((section) => {
          const row = document.createElement("p")
          row.textContent = `${section.heading}: ${labelList(state.labels, section.key).join(" · ")}`
          return row
        }),
      )
      labels.hidden = !state.labels
      // Popup keeps the full authoritative todo details that the image only summarizes.
      todos.replaceChildren(
        ...todoDetails(state.todos).map((line) => {
          const row = document.createElement("p")
          row.textContent = line
          return row
        }),
      )
      todos.hidden = !state.todos
      const origin = state.source?.sessionID ? `${state.source.title ? `${state.source.title} · ` : ""}${state.source.sessionID}` : "Noch kein Schaubild"
      source.textContent = `${origin}${state.capturedAt ? ` · Stand: ${formatCapturedAt(state.capturedAt)} Uhr` : ""}${state.partial ? " · Begrenzter Kontext" : ""}`
      regenerate.disabled = state.phase === "working" || !state.source
    }
    const onRegenerate = () => { void controller.generate(controller.state.source) }
    // A local close controller makes closing deterministic even when a host
    // does not abort the mount signal: button, Escape/host dismiss and our own
    // close() all end in the same dispose + onClosed path.
    const closeController = new AbortController()
    const unsubscribe = controller.subscribe(render)
    render(controller.state)
    const dispose = () => {
      unsubscribe()
      regenerate.removeEventListener("click", onRegenerate)
      close.removeEventListener("click", onClose)
    }
    const onClose = () => {
      closeController.abort()
      overlay.close()
    }
    closeController.signal.addEventListener("abort", () => {
      dispose()
      if (onClosed) onClosed()
    }, { once: true })
    signal.addEventListener("abort", () => closeController.abort(), { once: true })
    regenerate.addEventListener("click", onRegenerate)
    close.addEventListener("click", onClose)
    actions.append(regenerate, close)
    element.append(expected, status, image, labels, todos, source, actions)
    return dispose
  } })
  return overlay
}
