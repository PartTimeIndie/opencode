import { createController, DEFAULTS } from "./core.js"
import { createPlayer } from "./playback.js"

const ICON = new URL("./assets/spoken-summary.svg", import.meta.url).href

export default {
  id: "spoken-summary-app",
  app(api) {
    // Register settings before the controller subscribes: the runtime's subscribe
    // callback fires immediately with a snapshot of registered fields only, so a
    // later registration would replace stored values with defaults.
    api.settings.register({ id: "spokenSummarySettings", title: "Kurz anhören", searchTerms: ["voice", "summary", "TTS", "vorlesen", "Sprachausgabe"], sections: [
      { title: "Zusammenfassung", fields: [
        { key: "summaryTarget", type: "model-target", label: "Zusammenfassungsmodell oder Kette", default: DEFAULTS.summaryTarget, required: true, autoSelectDefault: true, description: "Nur der nötige Chatausschnitt geht an dieses Modell. Kein neuer Agentenchat." },
        { key: "language", type: "text", label: "Sprache", default: "de" },
        { key: "targetWords", type: "number", label: "Zielwortzahl", min: 30, max: 100, default: 60, description: "Meist zwei bis drei Sätze; die tatsächliche Audiodauer hängt von Stimme und Tempo ab." },
        { key: "cacheEnabled", type: "boolean", label: "Letzte Ansage im Arbeitsspeicher wiederverwenden", default: true, description: "Abschaltbar. Der aktuelle Chatstand wird trotzdem geprüft; keine Audio-/Chatdateien werden gespeichert." },
      ] },
      { title: "Sprachausgabe", fields: [
        { key: "speechTarget", type: "model-target", label: "Sprachmodell oder Kette", default: "", required: true, autoSelectSingle: true, filter: { purpose: "speech" }, description: "Nur die kurze Zusammenfassung geht an diesen Dienst. Je nach Anbieter externe Verarbeitung und Kosten." },
        { key: "voice", type: "text", label: "Stimme", default: "", description: "Leere Auswahl nutzt eine unterstützte Anbieter-Stimme." },
        { key: "speed", type: "number", label: "Sprechtempo", min: 0.5, max: 2, default: 1 },
        { key: "voiceOverrides", type: "list", label: "Stimmen pro Modell", default: [], fields: [
          { key: "model", type: "text", label: "Provider/Modell", default: "" },
          { key: "voice", type: "text", label: "Stimmen-ID", default: "" },
        ] },
      ] },
    ] })
    const controller = createController(api, createPlayer())
    api.toolbar.register({ id: "spokenSummary", title: "Kurz anhören", tooltip: "Letztes Ergebnis und offene Fragen kurz anhören", placement: "composer", align: "right", kind: "mount", mobile: "visible", defaultVisible: true, order: 60,
      mount(context) { return mountToolbar(controller, context) },
    })
    api.commands.register({ id: "spoken-summary.listen", title: "Kurz anhören", category: "Sprache", run: () => controller.listen(api.host.navigation.current()) })
    api.commands.register({ id: "spoken-summary.stop", title: "Ansage stoppen", category: "Sprache", run: () => controller.stop() })
    api.commands.register({ id: "spoken-summary.show", title: "Letzte Ansage anzeigen", category: "Sprache", run: () => api.ui.overlay.open({ id: "spoken-summary-text", title: "Kurz anhören", ariaLabel: "Letzte gesprochene Zusammenfassung", mount({ element, signal }) {
      const text = document.createElement("p")
      const source = document.createElement("p")
      const expected = document.createElement("p")
      expected.textContent = "Erwartet: Keine Aktion nötig. Wiederholen oder stoppen ist optional."
      const repeat = document.createElement("button")
      repeat.type = "button"; repeat.textContent = "Wiederholen"
      const stop = document.createElement("button")
      stop.type = "button"; stop.textContent = "Stoppen"
      const unsubscribe = controller.subscribe((state) => {
        text.textContent = state.summary || state.status
        source.textContent = `${state.source?.sessionID ?? "Noch keine Ansage"}${state.partial ? " · Begrenzter Kontext" : ""}`
        repeat.disabled = controller.active() || !state.summary
      })
      const onRepeat = () => { void controller.listen(controller.state.source) }
      const onStop = () => controller.stop()
      repeat.addEventListener("click", onRepeat); stop.addEventListener("click", onStop)
      element.append(expected, source, text, repeat, stop)
      const dispose = () => { unsubscribe(); repeat.removeEventListener("click", onRepeat); stop.removeEventListener("click", onStop) }
      signal.addEventListener("abort", dispose, { once: true })
      return dispose
    } }) })
  },
}

export function mountToolbar(controller, context) {
  const style = document.createElement("style")
  style.textContent = `.oc-spoken-summary{display:inline-flex;align-items:center;gap:3px;color:inherit}.oc-spoken-summary button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:4px;border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer}.oc-spoken-summary button:hover{background:var(--background-stronger)}.oc-spoken-summary button:focus-visible{outline:2px solid currentColor;outline-offset:1px}.oc-spoken-summary button:disabled{opacity:.4;cursor:default}.oc-spoken-summary__icon{width:18px;height:18px;background:currentColor;mask:url("${ICON}") center/contain no-repeat}.oc-spoken-summary [hidden]{display:none}.oc-spoken-summary__stop{width:10px;height:10px;background:currentColor;border-radius:2px}.oc-spoken-summary__live{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}`
  const root = document.createElement("span")
  root.className = "oc-spoken-summary"
  const listen = document.createElement("button")
  listen.type = "button"; listen.dataset.action = "spoken-summary-listen"; listen.setAttribute("aria-label", "Kurz anhören")
  const icon = document.createElement("span")
  icon.className = "oc-spoken-summary__icon"; icon.setAttribute("aria-hidden", "true"); listen.append(icon)
  const stop = document.createElement("button")
  stop.type = "button"; stop.dataset.action = "spoken-summary-stop"; stop.setAttribute("aria-label", "Ansage stoppen")
  const square = document.createElement("span")
  square.className = "oc-spoken-summary__stop"; square.setAttribute("aria-hidden", "true"); stop.append(square)
  const live = document.createElement("span")
  live.className = "oc-spoken-summary__live"; live.setAttribute("role", "status"); live.setAttribute("aria-live", "polite")
  const unsubscribe = controller.subscribe((state) => {
    listen.disabled = !context.context?.directory || !context.context?.sessionID
    listen.title = state.error || state.status
    root.dataset.phase = state.phase
    stop.hidden = !controller.active()
    stop.title = `Ansage stoppen: ${state.source?.sessionID ?? ""}`
    live.textContent = state.status
  })
  const onListen = () => { void controller.listen(context.context) }
  const onStop = () => controller.stop()
  listen.addEventListener("click", onListen); stop.addEventListener("click", onStop)
  root.append(listen, stop, live)
  context.element.replaceChildren(style, root)
  const dispose = () => { unsubscribe(); listen.removeEventListener("click", onListen); stop.removeEventListener("click", onStop); context.element.replaceChildren() }
  context.signal.addEventListener("abort", dispose, { once: true })
  return dispose
}
