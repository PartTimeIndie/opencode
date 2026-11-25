import { describe, expect, test } from "bun:test"
import plugin from "../../../../.opencode/plugin-sources/main-orchestrator-app/index.js"
import { configuration, operation } from "../../../../.opencode/plugin-sources/main-orchestrator-app/operations.js"

const snapshot = { available: true, state: { mainSessionID: "ses_main", revision: 3 }, tasks: [{ id: "task-a", revision: 7 }] }

describe("thin Main-Orchestrator toolbar", () => {
  test("keeps only the one-shot skill toggle in the composer and registers management in Settings", () => {
    const items = []
    let settings
    let overlay
    let current = {}
    plugin.app({ toolbar: { register: (item) => items.push(item) }, settings: { register: (item) => { settings = item } },
      host: { sessions: { orchestrator: {} }, navigation: { current: () => current } },
      ui: { overlay: { open: (value) => { overlay = value } } } })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ placement: "composer", skill: { name: "main-orchestrator" }, appendOnSubmit: true })
    expect(items[0].run).toBeUndefined()
    expect(items[0].mount).toBeUndefined()
    expect(items[0].icon.src).toEndWith("/assets/orchestrator.svg")
    expect(settings).toMatchObject({ id: "orchestratorControls", title: "Main-Orchestrator" })
    expect(overlay).toBeUndefined()
    const action = settings.sections[0].actions[0]
    expect(() => action.run()).toThrow("Main-Session")
    expect(overlay).toBeUndefined()
    // Resolve the active session on click, not during plugin registration.
    current = { directory: "/fixture", sessionID: "ses_main" }
    action.run()
    expect(overlay.id).toBe("main-orchestrator")
    expect(overlay.mount).toBeFunction()
  })
  test("captures exact task and Main revisions without caller-supplied cache or child bindings", () => {
    expect(operation(snapshot, "integrate", "task-a", "task-a")).toEqual({ action: "integrate", taskID: "task-a", expectedRevision: 7 })
    expect(operation(snapshot, "paused", undefined, "ses_main")).toEqual({ action: "control", control: "paused", expectedRevision: 3 })
    expect(operation(snapshot, "retire", undefined, "ses_main")).toEqual({ action: "retire", expectedRevision: 3 })
    expect(operation(snapshot, "review", "task-a", "task-a", " Checked the actual result ")).toEqual({ action: "review", taskID: "task-a", expectedRevision: 7, review: "Checked the actual result" })
  })
  test("refuses missing, foreign or mismatched confirmation and generic task state updates", () => {
    for (const action of ["integrate", "cancel", "settle", "review"])
      expect(() => operation(snapshot, action, "task-a", "task-b", "review")).toThrow("Task-ID")
    expect(() => operation(snapshot, "running", "task-a", "task-a")).toThrow("Unbekannte")
    expect(() => operation(snapshot, "active", undefined, "task-a")).toThrow("Main-ID")
    expect(() => operation(snapshot, "review", "task-a", "task-a", " ")).toThrow("Ergebnisprüfung")
    expect(() => operation({ ...snapshot, tasks: [] }, "integrate", "task-a", "task-a")).toThrow("Task-ID")
  })
  test("disabled runtime permits only status and conservative controls", () => {
    const disabled = { ...snapshot, available: false }
    expect(operation(disabled, "get")).toEqual({ action: "get" })
    expect(operation(disabled, "paused", undefined, "ses_main")).toMatchObject({ control: "paused" })
    expect(() => operation(disabled, "active", undefined, "ses_main")).toThrow("deaktiviert")
    expect(() => operation(disabled, "integrate", "task-a", "task-a")).toThrow("deaktiviert")
    expect(() => configuration(disabled, {})).toThrow("deaktiviert")
  })
  test("configuration stays bounded to four children and requires explicit finite values", () => {
    const values = { interaction: true, workspaceMode: "mirror", maxWorkers: "4", minCacheReadRatio: "0.8" }
    expect(configuration({ available: true, state: null }, values)).toEqual({ action: "configure", configuration: {
      expectedRevision: 0, interaction: true, workspaceMode: "mirror", maxWorkers: 4, minCacheReadRatio: 0.8 } })
    expect(configuration(snapshot, values).configuration.expectedRevision).toBe(3)
    for (const value of ["", " ", "5", "0", "1.5", "NaN", "Infinity"])
      expect(() => configuration(snapshot, { ...values, maxWorkers: value })).toThrow("Erlaubt")
    for (const value of ["", " ", "-0.1", "1.1", "NaN", "Infinity"])
      expect(() => configuration(snapshot, { ...values, minCacheReadRatio: value })).toThrow("Erlaubt")
  })
})
