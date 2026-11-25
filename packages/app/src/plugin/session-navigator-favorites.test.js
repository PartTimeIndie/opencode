import { afterEach, expect, test } from "bun:test"

const { default: navigator } = await import(
  new URL("../../../../.opencode/plugin-sources/session-navigator-app/index.js", import.meta.url).href
)
const cleanups = []
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

function mountFavorites(options = {}) {
  // Mirrors the host contract: the session id identifies a favorite, the directory is metadata.
  let items = options.items ?? [
    { id: "ses_favorite", directory: "C:/project", title: "Favorite session", parentID: null },
  ]
  let notify = () => {}
  let registration
  const writes = []
  const opened = []
  const api = {
    dock: {
      state: { item: () => ({}) },
      register: (input) => { registration = input },
      open: { item: () => {} },
    },
    kv: options.kv ?? { get: (_key, fallback) => fallback, set: () => {} },
    host: {
      projects: { list: () => [], subscribe: () => () => {}, open: () => {} },
      navigation: { openSession: (input) => opened.push(input), current: () => ({}), newSession: () => {} },
      ...(options.request ? { http: { request: options.request } } : {}),
      sessions: {
        active: () => [], subscribe: () => () => {},
        ...(options.favoritesAPI === false ? {} : {
          favorites: {
            list: () => items,
            subscribe: (listener) => { notify = listener; return () => {} },
            set: (input, picked) => {
              writes.push(picked)
              items = picked
                ? [input, ...items.filter((item) => item.id !== input.id)]
                : items.filter((item) => item.id !== input.id)
              notify(items)
            },
          },
        }),
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
  return { element, writes, opened, refresh: () => notify(items) }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const favoriteIDs = (fixture) =>
  [...fixture.element.querySelectorAll('[data-group-key="favorites"] .oc-session-nav__session')].map(
    (row) => row.dataset.sessionId,
  )

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

const click = (target, detail) =>
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail }))

test("the same session stored under two directories renders as one favorite row", async () => {
  const fixture = mountFavorites({
    items: [
      { id: "ses_moved", directory: "E:/GitRepros/repo", title: "Moved session", parentID: null, time: { updated: 20 } },
      { id: "ses_moved", directory: "C:/GitRepros/repo", title: "Moved session", parentID: null, time: { updated: 10 } },
    ],
  })
  await settle()
  const rows = [...fixture.element.querySelectorAll('[data-group-key="favorites"] .oc-session-nav__session')]
  expect(rows.map((row) => row.dataset.sessionId)).toEqual(["ses_moved"])
  // The host lists the newest entry first; that entry owns the row and its directory.
  expect(rows[0].dataset.directory).toBe("E:/GitRepros/repo")
})

test("a double-click on the star toggles exactly once", async () => {
  const fixture = mountFavorites({
    items: [
      { id: "ses_first", directory: "C:/project", title: "First", parentID: null, time: { updated: 20 } },
      { id: "ses_second", directory: "C:/project", title: "Second", parentID: null, time: { updated: 10 } },
    ],
  })
  await settle()
  click(fixture.element.querySelector(".oc-session-nav__favorite"), 1)
  await settle()
  // Removing the first row moved the second row's star under the pointer.
  click(fixture.element.querySelector(".oc-session-nav__favorite"), 2)
  await settle()
  expect(fixture.writes).toEqual([false])
  expect(favoriteIDs(fixture)).toEqual(["ses_second"])
})

const notFound = async (input) =>
  input.path.endsWith("/exists")
    ? { ok: true, status: 200, body: { exists: false } }
    : { ok: false, status: 404, statusText: "Not Found" }

async function openMissingFavorite(fixture) {
  const main = fixture.element.querySelector(".oc-session-nav__session-main")
  for (const detail of [1, 2]) click(main, detail)
  await settle()
}

test("opening a favorite whose session is gone keeps and marks the row instead of removing it", async () => {
  const fixture = mountFavorites({ request: notFound })
  await settle()
  await openMissingFavorite(fixture)
  const row = fixture.element.querySelector('[data-group-key="favorites"] .oc-session-nav__session')
  expect(favoriteIDs(fixture)).toEqual(["ses_favorite"])
  expect(row.classList.contains("oc-session-nav__session--missing")).toBe(true)
  expect(fixture.writes).toEqual([])
  expect(fixture.opened).toEqual([])
})

test("a missing favorite can still be removed with its star", async () => {
  const fixture = mountFavorites({ request: notFound })
  await settle()
  await openMissingFavorite(fixture)
  fixture.element.querySelector(".oc-session-nav__favorite").click()
  await settle()
  expect(fixture.writes).toEqual([false])
  expect(favoriteIDs(fixture)).toEqual([])
})

test("Delete removes a missing favorite although the server no longer has the session", async () => {
  const fixture = mountFavorites({ request: notFound })
  await settle()
  await openMissingFavorite(fixture)
  const row = fixture.element.querySelector('[data-group-key="favorites"] .oc-session-nav__session')
  ;[...row.querySelectorAll("button")].find((button) => button.textContent === "Delete").click()
  await settle()
  const confirm = [...fixture.element.querySelectorAll(".oc-session-nav__confirm button")]
  confirm.find((button) => button.textContent === "Yes").click()
  await settle()
  await settle()
  expect(fixture.writes).toEqual([false])
  expect(favoriteIDs(fixture)).toEqual([])
})

test("hosts without the favorites API keep the kv fallback, re-keyed by session id", async () => {
  const storage = new Map([
    ["favorites.v1", {
      "c:/project:ses_legacy": { id: "ses_legacy", directory: "C:/project", title: "Legacy favorite", parentID: null },
    }],
  ])
  const fixture = mountFavorites({
    favoritesAPI: false,
    kv: { get: (key, fallback) => storage.get(key) ?? fallback, set: (key, value) => storage.set(key, value) },
  })
  await settle()
  expect(favoriteIDs(fixture)).toEqual(["ses_legacy"])
  fixture.element.querySelector(".oc-session-nav__favorite").click()
  await settle()
  expect(storage.get("favorites.v1")).toEqual({})
  expect(favoriteIDs(fixture)).toEqual([])
})
