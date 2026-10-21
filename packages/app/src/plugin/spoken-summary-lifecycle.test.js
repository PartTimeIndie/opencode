import { expect, test } from "bun:test"
import { fixture } from "../../../../.opencode/plugin-sources/spoken-summary-app/core.test.js"
import { mountToolbar } from "../../../../.opencode/plugin-sources/spoken-summary-app/index.js"

test("toolbar unmount does not cancel source audio; global stop stays usable in another composer", async () => {
  const f = fixture({ player: { playBuffer: () => new Promise(() => {}) } })
  const first = document.createElement("div")
  const second = document.createElement("div")
  const firstScope = new AbortController()
  const secondScope = new AbortController()
  const a = mountToolbar(f.controller, { element: first, signal: firstScope.signal, context: { directory: "/project", sessionID: "ses_a" } })
  const b = mountToolbar(f.controller, { element: second, signal: secondScope.signal, context: { directory: "/project", sessionID: "ses_b" } })
  const pending = f.controller.listen({ directory: "/project", sessionID: "ses_a" })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.controller.state.phase).toBe("speaking")
  firstScope.abort()
  expect(f.controller.state.phase).toBe("speaking")
  const stop = second.querySelector('[data-action="spoken-summary-stop"]')
  expect(stop.hidden).toBe(false)
  stop.click()
  await pending
  expect(f.controller.state.phase).toBe("idle")
  expect(stop.hidden).toBe(true)
  a(); b(); secondScope.abort(); f.owner.abort()
})
