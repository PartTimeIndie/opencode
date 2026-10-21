import { afterEach, expect, test } from "bun:test"

const { default: navigator } = await import(
  new URL("../../../../.opencode/plugin-sources/session-navigator-app/index.js", import.meta.url).href
)
const cleanups = []
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

function mountFavorites() {
  const session = { id: "ses_favorite", directory: "C:/project", title: "Favorite session", parentID: null }
  let items = [session]
  let notify = () => {}
  let registration
  const writes = []
  const api = {
    dock: {
      state: { item: () => ({}) },
      register: (input) => { registration = input },
      open: { item: () => {} },
    },
    kv: { get: (_key, fallback) => fallback, set: () => {} },
    host: {
      projects: { list: () => [], subscribe: () => () => {}, open: () => {} },
      sessions: {
        active: () => [], subscribe: () => () => {},
        favorites: {
          list: () => items,
          subscribe: (listener) => { notify = listener; return () => {} },
          set: (input, picked) => {
            writes.push(picked)
            items = picked ? [input] : []
            notify(items)
          },
        },
      },
    },
    client: { experimental: { session: { list: async () => ({ data: [] }) } } },
  }
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  })
  navigator.app(api)
  const element = document.createElement("div")
  document.body.append(element)
  cleanups.push(registration.mount({ area: "left", element, signal: new AbortController().signal }))
  return { element, writes, refresh: () => notify(items) }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test("favorite stays at the trailing edge after hover actions so it cannot shift under the pointer", async () => {
  const fixture = mountFavorites()
  await settle()
  const row = fixture.element.querySelector('[data-group-key="favorites"] .oc-session-nav__session')
  expect(row.lastElementChild.className).toBe("oc-session-nav__favorite")
})

test("favorite star removes the session without opening it", async () => {
  const fixture = mountFavorites()
  await settle()
  fixture.element.querySelector('.oc-session-nav__favorite').click()
  await settle()
  expect(fixture.writes).toEqual([false])
  expect(fixture.element.querySelector('[data-group-key="favorites"] .oc-session-nav__session')).toBeNull()
})

test("favorite star survives a live refresh between pointer press and release exactly once", async () => {
  const fixture = mountFavorites()
  await settle()
  const star = fixture.element.querySelector('.oc-session-nav__favorite')
  star.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 7, clientX: 100, clientY: 100 }))
  fixture.refresh()
  await settle()
  expect(star.isConnected).toBe(false)
  const replacement = fixture.element.querySelector('.oc-session-nav__favorite')
  replacement.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 7, clientX: 100, clientY: 100 }))
  // Some browsers still emit a retargeted click after the interrupted release.
  replacement.click()
  await settle()
  expect(fixture.writes).toEqual([false])
  expect(fixture.element.querySelector('[data-group-key="favorites"] .oc-session-nav__session')).toBeNull()
})

for (const action of ["pointercancel", "moved", "wrong-pointer"]) {
  test(`interrupted favorite press does not toggle after ${action}`, async () => {
    const fixture = mountFavorites()
    await settle()
    const star = fixture.element.querySelector('.oc-session-nav__favorite')
    star.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 7, clientX: 100, clientY: 100 }))
    if (action === "pointercancel") star.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 7 }))
    fixture.refresh()
    await settle()
    fixture.element.querySelector('.oc-session-nav__favorite').dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true,
      pointerId: action === "wrong-pointer" ? 8 : 7,
      clientX: action === "moved" ? 120 : 100,
      clientY: 100,
    }))
    await settle()
    expect(fixture.writes).toEqual([])
  })
}
