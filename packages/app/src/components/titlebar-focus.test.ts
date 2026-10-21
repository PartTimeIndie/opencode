import { expect, test } from "bun:test"
import { observeTitlebarFocus } from "./titlebar-focus"

test("pane content focus replaces stale plugin focus without resize and cleans up", () => {
  const host = document.createElement("div")
  host.innerHTML = '<div data-dock-pane="plugin"><button>Plugin</button></div><div data-dock-pane="session"><button>Session</button></div>'
  document.body.append(host)
  const changes: string[] = []
  const dispose = observeTitlebarFocus(document, (pane) => changes.push(pane))
  host.querySelector('[data-dock-pane="plugin"] button')!.dispatchEvent(new Event("pointerdown", { bubbles: true }))
  host.querySelector('[data-dock-pane="session"] button')!.dispatchEvent(new Event("focusin", { bubbles: true }))
  expect(changes).toEqual(["plugin", "session"])
  dispose()
  host.querySelector("button")!.dispatchEvent(new Event("pointerdown", { bubbles: true }))
  expect(changes).toEqual(["plugin", "session"])
  host.remove()
})
