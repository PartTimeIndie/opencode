import { afterEach, describe, expect, test } from "bun:test"

const pluginSource = await Bun.file(
  new URL("../../../../.opencode/plugin-sources/session-navigator-app/index.js", import.meta.url),
).text()
const pluginModuleUrl = `data:text/javascript;base64,${Buffer.from(pluginSource).toString("base64")}`
const {
  openSession,
  openSessionRenameDialog,
  refreshLoadedNavigatorGroups,
  refreshFavoriteParents,
  restoreNavigatorState,
  sessionVisualStatus,
  statusLabel,
  subscribeSessionEvents,
  syncActiveSessions,
  updateSessionMeta,
  updateSessionTitleFromEvent,
} = await import(pluginModuleUrl)

function liveEventState(api, projectDirectory) {
  return {
    api,
    host: api.host,
    root: undefined,
    favoriteItems: {},
    favorites: { key: "favorites", sessions: [] },
    recent: {
      key: "recent",
      loaded: true,
      loading: false,
      loadedAll: false,
      hasMore: false,
      sessions: [],
    },
    groups: new Map([
      [
        projectDirectory,
        {
          key: `project:${projectDirectory}`,
          directory: projectDirectory,
          loaded: true,
          loading: false,
          loadedAll: false,
          hasMore: false,
          sessions: [],
        },
      ],
    ]),
    search: { key: "search", sessions: [] },
    query: "",
    showSubagents: true,
    activeSortTimes: {},
    missingSessions: new Set(),
    renderCalls: 0,
    render() {
      this.renderCalls++
    },
  }
}

afterEach(() => {
  document.body.replaceChildren()
})

function stateWithSessions(api) {
  const root = document.createElement("section")
  document.body.append(root)
  return {
    api,
    host: api.host,
    root,
    contextMenu: { open: true },
    recent: {
      sessions: [{ id: "ses_same", title: "Old title", directory: "C:/server-b/project", time: {} }],
    },
    groups: new Map([
      [
        "C:/server-a/project",
        {
          directory: "C:/server-a/project",
          sessions: [{ id: "ses_same", title: "Other server title", time: {} }],
        },
      ],
    ]),
    search: { sessions: [] },
    missingSessions: new Set(),
    favoriteItems: {},
    renderCalls: 0,
    render() {
      this.renderCalls++
    },
  }
}

function serverApi(name, calls, failure) {
  return {
    host: {
      projects: {
        list: () => [{ id: name, name, worktree: "C:/shared/project" }],
      },
      sessions: {
        favorites: {
          list: () => [],
        },
      },
      http: {
        request: async (input) => {
          calls.push(input)
          if (failure) throw new Error(failure)
          if (input.method === "GET" && input.path.endsWith("/exists")) {
            return { ok: true, body: { exists: true, session: { id: "ses_same" } } }
          }
          return { ok: true, body: {} }
        },
      },
    },
    kv: {
      get: (_key, fallback) => fallback,
    },
  }
}

function favoriteServerApi(name, favorites, resolve) {
  const requests = []
  const writes = []
  // Mirrors the host contract: the session id identifies a favorite, the directory is metadata.
  const items = new Map(favorites.map((favorite) => [favorite.id, { ...favorite }]))
  const api = {
    host: {
      projects: {
        list: () => [{ id: name, name, worktree: "C:/shared/project" }],
      },
      sessions: {
        favorites: {
          list: () => [...items.values()].map((favorite) => ({ ...favorite })),
          set: (favorite, picked) => {
            writes.push(picked)
            if (!picked) {
              items.delete(favorite.id)
              return
            }
            items.set(favorite.id, { ...favorite })
          },
        },
      },
      http: {
        request: async (input) => {
          requests.push(input)
          const parts = input.path.split("/")
          const sessionID = decodeURIComponent(parts.at(-1) === "exists" ? parts.at(-2) : parts.at(-1))
          return resolve(sessionID)
        },
      },
    },
    kv: {
      get: (_key, fallback) => fallback,
      set() {},
    },
  }
  return { api, items, requests, writes }
}

function stateWithFavorites(api) {
  return {
    api,
    host: api.host,
    favoriteItems: Object.fromEntries(api.host.sessions.favorites.list().map((favorite) => [favorite.id, favorite])),
    missingFavorites: new Set(),
    renderCalls: 0,
    render() {
      this.renderCalls++
    },
  }
}

async function settle() {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("session navigator rename dialog", () => {
  test("renames through the active server API and exact directory without global prompt", async () => {
    const calls = []
    const api = serverApi("server-b", calls)
    const state = stateWithSessions(api)
    const originalPrompt = window.prompt
    window.prompt = () => {
      throw new Error("window.prompt must not be used")
    }

    try {
      openSessionRenameDialog(api, state, state.recent.sessions[0], "C:/server-b/project")

      await Promise.resolve()
      const dialog = document.querySelector('[role="dialog"]')
      const input = dialog.querySelector('input[name="title"]')
      expect(document.activeElement).toBe(input)
      expect(input.value).toBe("Old title")
      input.value = "  Renamed title  "
      dialog.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await settle()

      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        path: "/session/ses_same",
        method: "PATCH",
        query: { directory: "C:/server-b/project" },
        body: { title: "Renamed title" },
      })
      expect(state.recent.sessions[0].title).toBe("Renamed title")
      expect(state.groups.get("C:/server-a/project").sessions[0].title).toBe("Other server title")
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    } finally {
      window.prompt = originalPrompt
    }
  })

  test("keeps validation and request failures inside the modal and supports cancel", async () => {
    const requests = []
    const api = serverApi("server-b", requests, "Rename unavailable")
    const state = stateWithSessions(api)

    openSessionRenameDialog(api, state, state.recent.sessions[0], "C:/server-b/project")
    const dialog = document.querySelector('[role="dialog"]')
    const input = dialog.querySelector('input[name="title"]')
    input.value = "   "
    dialog.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    expect(requests).toHaveLength(0)
    expect(dialog.querySelector('[aria-live="polite"]').textContent).toBe("Enter a session title.")
    expect(input.getAttribute("aria-invalid")).toBe("true")

    input.value = "Changed"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    dialog.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    expect(requests).toHaveLength(1)
    expect(dialog.querySelector('[aria-live="polite"]').textContent).toBe("Rename unavailable")
    expect(document.querySelector('[role="dialog"]')).toBe(dialog)

    dialog.querySelector('button[type="button"]').click()
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    openSessionRenameDialog(api, state, state.recent.sessions[0], "C:/server-b/project")
    await Promise.resolve()
    const keyboardDialog = document.querySelector('[role="dialog"]')
    const keyboardInput = keyboardDialog.querySelector('input[name="title"]')
    keyboardInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(keyboardDialog.querySelector('button[type="button"]'))
    document.activeElement.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
    )
    expect(document.activeElement).toBe(keyboardInput)
    keyboardDialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  test("partitions A to B to A state and rejects stale cross-host writes", async () => {
    const callsA = []
    const callsB = []
    const apiA = serverApi("server-a", callsA)
    const apiB = serverApi("server-b", callsB)
    const sessionA = { id: "ses_same", title: "Server A title", directory: "C:/shared/project", time: {} }
    const sessionB = { id: "ses_same", title: "Server B title", directory: "C:/shared/project", time: {} }
    const stateA = restoreNavigatorState(apiA, { area: "left" })
    stateA.recent.loaded = true
    stateA.recent.sessions = [sessionA]

    const stateB = restoreNavigatorState(apiB, { area: "left" })
    expect(stateB).not.toBe(stateA)
    expect(stateB.recent.loaded).toBe(false)
    expect(stateB.recent.sessions).toEqual([])
    expect(stateB.projects[0].name).toBe("server-b")

    openSessionRenameDialog(apiB, stateA, sessionA, "C:/shared/project")
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(callsA).toHaveLength(0)
    expect(callsB).toHaveLength(0)

    stateB.recent.loaded = true
    stateB.recent.sessions = [sessionB]
    openSessionRenameDialog(apiB, stateB, sessionB, "C:/shared/project")
    const inputB = document.querySelector('input[name="title"]')
    inputB.value = "Renamed on B"
    inputB.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    expect(callsB).toHaveLength(1)
    expect(callsA).toHaveLength(0)
    expect(stateB.recent.sessions[0].title).toBe("Renamed on B")
    expect(stateA.recent.sessions[0].title).toBe("Server A title")

    const apiAReturn = serverApi("server-a", callsA)
    const restoredA = restoreNavigatorState(apiAReturn, { area: "right" })
    expect(restoredA).not.toBe(stateA)
    expect(restoredA.recent.loaded).toBe(false)
    expect(restoredA.recent.sessions).toEqual([])
    expect(restoredA.dockArea).toBe("right")
    restoredA.recent.loaded = true
    restoredA.recent.sessions = [{ ...sessionA }]
    openSessionRenameDialog(apiAReturn, restoredA, restoredA.recent.sessions[0], "C:/shared/project")
    const inputA = document.querySelector('input[name="title"]')
    inputA.value = "Renamed on A"
    inputA.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    expect(callsA).toHaveLength(1)
    expect(callsB).toHaveLength(1)
    expect(restoredA.recent.sessions[0].title).toBe("Renamed on A")
  })
})

describe("session navigator activation ownership", () => {
  test("keeps deferred server-A validation scoped after switching to B with the same session ID and path", async () => {
    const directory = "C:/shared/project"
    const session = { id: "ses_same", title: "Shared session", directory, time: {} }
    const requestsA = []
    const requestsB = []
    const navigation = []
    const apiA = serverApi("server-a", requestsA)
    const apiB = serverApi("server-b", requestsB)
    let activeServer = "server-a"
    let resolveA
    apiA.host.http.request = (input) => {
      requestsA.push(input)
      return new Promise((resolve) => {
        resolveA = resolve
      })
    }
    apiA.host.navigation = {
      openSession: (input) => navigation.push({ server: activeServer, input }),
    }
    apiB.host.navigation = {
      openSession: (input) => navigation.push({ server: activeServer, input }),
    }

    const stateA = stateWithSessions(apiA)
    stateA.recent.sessions = [{ ...session }]
    const pendingA = openSession(apiA, stateA, stateA.recent.sessions[0], directory)
    await Promise.resolve()
    expect(requestsA).toHaveLength(1)
    expect(navigation).toEqual([
      {
        server: "server-a",
        input: { directory, sessionID: session.id, area: "middle" },
      },
    ])

    activeServer = "server-b"
    stateA.root.remove()
    stateA.root = undefined
    const stateB = stateWithSessions(apiB)
    stateB.recent.sessions = [{ ...session }]
    resolveA({ ok: true, status: 200, body: { exists: false } })
    await pendingA

    expect(navigation).toHaveLength(1)
    expect(stateA.recent.sessions).toHaveLength(0)
    expect(stateB.recent.sessions).toHaveLength(1)
    await openSession(apiB, stateB, stateB.recent.sessions[0], directory)
    expect(navigation).toEqual([
      {
        server: "server-a",
        input: { directory, sessionID: session.id, area: "middle" },
      },
      {
        server: "server-b",
        input: { directory, sessionID: session.id, area: "middle" },
      },
    ])
    expect(requestsB).toHaveLength(1)
  })
})

describe("session navigator semantic title events", () => {
  test("refreshes loaded caches after title events were missed while the dock was unmounted", async () => {
    const directory = "C:/project"
    const stale = {
      id: "ses_remount",
      title: "New session - 2026-07-15T08:00:00.000Z",
      directory,
      time: { created: 10, updated: 10 },
    }
    const current = { ...stale, title: "Generated after unmount", time: { ...stale.time, updated: 42 } }
    const api = {
      client: {
        experimental: {
          session: {
            list: async () => ({ data: [current] }),
          },
        },
      },
      host: {
        sessions: {
          working: () => false,
          status: () => "done",
        },
      },
    }
    const state = {
      api,
      host: api.host,
      root: undefined,
      showSubagents: true,
      activeSortTimes: {},
      recent: {
        key: "recent",
        loaded: true,
        loadedAll: false,
        loading: false,
        reloadPreview: false,
        hasMore: true,
        sessions: [{ ...stale }],
      },
      groups: new Map([
        [
          directory,
          {
            key: `project:${directory}`,
            directory,
            loaded: true,
            loadedAll: false,
            loading: false,
            reloadPreview: false,
            hasMore: true,
            sessions: [{ ...stale }],
          },
        ],
      ]),
    }

    await refreshLoadedNavigatorGroups(api, state)

    expect(state.recent.sessions[0]).toEqual(current)
    expect(state.groups.get(directory).sessions[0]).toEqual(current)
    const meta = document.createElement("div")
    updateSessionMeta(api, meta, state.recent.sessions[0], directory)
    expect(meta.querySelector('[data-slot="session-status-dot"][data-status="done"]')).toBeTruthy()
  })

  test("updates cached lists when V2 title generation does not emit session.updated", () => {
    const handlers = new Map()
    const api = {
      event: {
        on(type, handler) {
          handlers.set(type, handler)
          return () => handlers.delete(type)
        },
      },
      host: {},
    }
    const session = {
      id: "ses_title",
      title: "New session - 2026-07-12T01:26:01.508Z",
      directory: "C:/project",
      time: { created: 10, updated: 10 },
    }
    const state = {
      api,
      host: api.host,
      root: undefined,
      favoriteItems: {},
      favorites: { key: "favorites", sessions: [] },
      recent: { key: "recent", loaded: true, loading: false, sessions: [{ ...session }] },
      groups: new Map([
        ["C:/project", { key: "project:C:/project", directory: "C:/project", sessions: [{ ...session }] }],
      ]),
      search: { sessions: [{ ...session }] },
      query: "",
      renderCalls: 0,
      render() {
        this.renderCalls++
      },
    }

    const unsubscribe = subscribeSessionEvents(api, state)
    expect(handlers.has("session.next.title.updated")).toBe(true)
    handlers.get("session.next.title.updated")({
      type: "session.next.title.updated",
      properties: { sessionID: session.id, title: "Semantic session title", timestamp: 42 },
    })

    expect(state.recent.sessions[0]).toMatchObject({ title: "Semantic session title", time: { updated: 42 } })
    expect(state.groups.get("C:/project").sessions[0]).toMatchObject({
      title: "Semantic session title",
      time: { updated: 42 },
    })
    expect(state.search.sessions[0]).toMatchObject({ title: "Semantic session title", time: { updated: 42 } })
    expect(state.renderCalls).toBe(1)

    unsubscribe()
    expect(handlers.size).toBe(0)
  })

  test("re-evaluates active search membership after a generated title changes", () => {
    const api = { host: {} }
    const session = {
      id: "ses_search_title",
      title: "New session - 2026-07-12T01:26:01.508Z",
      directory: "C:/project",
      time: { created: 10, updated: 10 },
    }
    const state = {
      api,
      host: api.host,
      root: undefined,
      favoriteItems: {},
      favorites: { key: "favorites", sessions: [] },
      recent: { key: "recent", loaded: true, loading: false, sessions: [{ ...session }] },
      groups: new Map(),
      search: { sessions: [] },
      searchContent: {},
      query: "semantic",
      showSubagents: true,
      activeSortTimes: {},
      renderCalls: 0,
      render() {
        this.renderCalls++
      },
    }

    updateSessionTitleFromEvent(api, state, {
      properties: { sessionID: session.id, title: "Semantic title", timestamp: 42 },
    })
    expect(state.search.sessions.map((item) => item.id)).toEqual([session.id])
    expect(state.renderCalls).toBe(1)

    state.renderCalls = 0
    state.recent.sessions = []
    state.recent.loaded = false
    state.root = document.createElement("section")
    const row = document.createElement("div")
    row.className = "oc-session-nav__session"
    row.dataset.sessionId = session.id
    row.dataset.directory = session.directory
    state.root.append(row)
    updateSessionTitleFromEvent(api, state, {
      properties: { sessionID: session.id, title: "Unrelated title", timestamp: 43 },
    })
    expect(state.search.sessions).toEqual([])
    expect(state.renderCalls).toBe(1)
  })

  test("updates and re-sorts the direct favorites cache", () => {
    const api = { host: {} }
    const session = {
      id: "ses_favorite_title",
      title: "New session - 2026-07-12T01:26:01.508Z",
      directory: "C:/project",
      time: { created: 10, updated: 10 },
    }
    const other = {
      id: "ses_other_favorite",
      title: "Other favorite",
      directory: "C:/other",
      time: { created: 20, updated: 20 },
    }
    const state = {
      api,
      host: api.host,
      root: undefined,
      favoriteItems: {
        [session.id]: { ...session },
        [other.id]: { ...other },
      },
      favorites: { key: "favorites", sessions: [{ ...other }, { ...session }] },
      recent: { key: "recent", loaded: false, loading: false, sessions: [] },
      groups: new Map(),
      search: { sessions: [] },
      query: "",
      showSubagents: true,
      activeSortTimes: {},
    }

    updateSessionTitleFromEvent(api, state, {
      properties: { sessionID: session.id, title: "Generated favorite title", timestamp: 42 },
    })

    expect(state.favoriteItems[session.id]).toMatchObject({
      title: "Generated favorite title",
      time: { updated: 42 },
    })
    expect(state.favorites.sessions.map((item) => item.id)).toEqual([session.id, other.id])
    expect(state.favorites.sessions[0].title).toBe("Generated favorite title")
  })

  test("updates a mixed-case favorite by session id and keeps its persisted directory", () => {
    const api = { host: {} }
    const session = {
      id: "ses_mixed_case_favorite",
      title: "New session - 2026-07-12T01:26:01.508Z",
      directory: "c:/project",
      time: { created: 10, updated: 10 },
    }
    const favorite = { ...session, directory: "C:/project" }
    const state = {
      api,
      host: api.host,
      root: undefined,
      favoriteItems: { [favorite.id]: favorite },
      favorites: { key: "favorites", sessions: [{ ...favorite }] },
      recent: { key: "recent", loaded: true, loading: false, sessions: [{ ...session }] },
      groups: new Map(),
      search: { sessions: [] },
      query: "",
      showSubagents: true,
      activeSortTimes: {},
    }

    updateSessionTitleFromEvent(api, state, {
      properties: { sessionID: session.id, title: "Mixed-case favorite title", timestamp: 42 },
    })

    expect(state.recent.sessions[0]).toMatchObject({
      directory: "c:/project",
      title: "Mixed-case favorite title",
      time: { updated: 42 },
    })
    expect(state.favoriteItems[favorite.id]).toMatchObject({
      directory: "C:/project",
      title: "Mixed-case favorite title",
      time: { updated: 42 },
    })
    expect(state.favorites.sessions[0]).toMatchObject({
      directory: "C:/project",
      title: "Mixed-case favorite title",
      time: { updated: 42 },
    })
  })

  test("scopes generated title updates to the event directory", () => {
    const api = { host: {} }
    const first = {
      id: "ses_shared_title",
      title: "Project A title",
      directory: "C:/Project-A",
      time: { created: 10, updated: 10 },
    }
    const second = {
      ...first,
      title: "Project B title",
      directory: "C:/Project-B",
    }
    const state = {
      api,
      host: api.host,
      root: undefined,
      favoriteItems: {
        [first.id]: { ...first },
      },
      favorites: { key: "favorites", sessions: [{ ...first }] },
      recent: { key: "recent", loaded: true, loading: false, sessions: [{ ...first }, { ...second }] },
      groups: new Map([
        [first.directory, { key: `project:${first.directory}`, directory: first.directory, sessions: [{ ...first }] }],
        [second.directory, { key: `project:${second.directory}`, directory: second.directory, sessions: [{ ...second }] }],
      ]),
      search: { sessions: [{ ...first }, { ...second }] },
      query: "",
      showSubagents: true,
      activeSortTimes: {},
    }

    updateSessionTitleFromEvent(
      api,
      state,
      { properties: { sessionID: first.id, title: "Generated Project A title", timestamp: 42 } },
      { directory: "c:/project-a/" },
    )

    for (const sessions of [state.recent.sessions, state.search.sessions]) {
      expect(sessions.find((session) => session.directory === first.directory)?.title).toBe("Generated Project A title")
      expect(sessions.find((session) => session.directory === second.directory)?.title).toBe("Project B title")
    }
    // A favorite is identified by its session id, so the same id cannot be listed twice.
    expect(state.favorites.sessions.map((session) => session.directory)).toEqual([first.directory])
    expect(state.favorites.sessions[0].title).toBe("Generated Project A title")
    expect(state.groups.get(first.directory).sessions[0].title).toBe("Generated Project A title")
    expect(state.groups.get(second.directory).sessions[0].title).toBe("Project B title")
  })

  test("reloads recent and only the matching loaded project group after a cache miss", async () => {
    const calls = []
    const api = {
      client: {
        experimental: {
          session: {
            async list(input) {
              calls.push(input.directory)
              return { data: [] }
            },
          },
        },
      },
      host: {},
    }
    const project = {
      key: "project:C:/Project",
      directory: "C:/Project",
      loaded: true,
      loading: false,
      sessions: [],
    }
    const unrelated = {
      key: "project:C:/Other",
      directory: "C:/Other",
      loaded: true,
      loading: false,
      sessions: [],
    }
    const state = {
      api,
      host: api.host,
      root: undefined,
      favoriteItems: {},
      favorites: { key: "favorites", sessions: [] },
      recent: { key: "recent", loaded: true, loading: false, sessions: [] },
      groups: new Map([
        [project.directory, project],
        [unrelated.directory, unrelated],
      ]),
      search: { sessions: [] },
      query: "",
      showSubagents: true,
      activeSortTimes: {},
    }

    updateSessionTitleFromEvent(
      api,
      state,
      { properties: { sessionID: "ses_cache_miss", title: "Generated title", timestamp: 42 } },
      { directory: "c:/project" },
    )
    await Bun.sleep(0)

    expect(calls).toEqual([undefined, "C:/Project"])
    expect(unrelated.loading).toBe(false)
  })
})

describe("session navigator live event upserts", () => {
  test("inserts a session.created payload whose directory spelling differs from the loaded group", async () => {
    const api = { host: {} }
    // Group loaded with one Windows spelling...
    const state = liveEventState(api, "C:/GitRepros/opencode")
    const created = {
      id: "ses_live_created",
      title: "Live created session",
      directory: "C:\\GitRepros\\opencode",
      time: { created: 30, updated: 30 },
    }

    let onCreated
    const apiWithEvents = {
      ...api,
      event: {
        on(type, handler) {
          if (type === "session.created") onCreated = handler
          return () => {}
        },
      },
    }

    const unsubscribe = subscribeSessionEvents(apiWithEvents, state)
    onCreated({ type: "session.created", properties: { info: created } })
    unsubscribe()

    expect(state.recent.sessions.map((session) => session.id)).toEqual(["ses_live_created"])
    expect(state.groups.get("C:/GitRepros/opencode").sessions.map((session) => session.id)).toEqual(["ses_live_created"])
  })

  test("replaces an existing row on session.updated instead of leaving a duplicate", async () => {
    const api = { host: {} }
    const directory = "C:/GitRepros/opencode"
    const state = liveEventState(api, directory)
    const existing = {
      id: "ses_existing",
      title: "Old title",
      directory,
      time: { created: 10, updated: 10 },
    }
    state.recent.sessions = [{ ...existing }]
    state.groups.get(directory).sessions = [{ ...existing }]

    let onUpdated
    const apiWithEvents = {
      host: {},
      event: {
        on(type, handler) {
          if (type === "session.updated") onUpdated = handler
          return () => {}
        },
      },
    }

    const unsubscribe = subscribeSessionEvents(apiWithEvents, state)
    onUpdated({
      type: "session.updated",
      properties: {
        info: { ...existing, title: "New title", time: { created: 10, updated: 50 }, directory },
      },
    })
    unsubscribe()

    expect(state.recent.sessions).toHaveLength(1)
    expect(state.groups.get(directory).sessions).toHaveLength(1)
    expect(state.recent.sessions[0].title).toBe("New title")
  })

  test("does not insert the same session into a group of a different directory", () => {
    const api = { host: {} }
    const state = liveEventState(api, "C:/GitRepros/opencode")
    const unrelated = {
      id: "ses_unrelated",
      title: "Unrelated session",
      directory: "D:/Other",
      time: { created: 30, updated: 30 },
    }

    let onCreated
    const apiWithEvents = {
      host: {},
      event: {
        on(type, handler) {
          if (type === "session.created") onCreated = handler
          return () => {}
        },
      },
    }

    const unsubscribe = subscribeSessionEvents(apiWithEvents, state)
    onCreated({ type: "session.created", properties: { info: unrelated } })
    unsubscribe()

    expect(state.groups.get("C:/GitRepros/opencode").sessions).toEqual([])
  })

  test("keeps same-id sessions in other groups when a delete event lacks directory context", () => {
    const api = { host: {} }
    const first = {
      id: "ses_shared_delete",
      title: "Project A session",
      directory: "C:/Project-A",
      time: { created: 10, updated: 10 },
    }
    const second = {
      ...first,
      title: "Project B session",
      directory: "C:/Project-B",
    }
    const state = {
      api,
      host: api.host,
      root: undefined,
      favoriteItems: {
        [first.id]: { ...first },
      },
      favorites: { key: "favorites", sessions: [{ ...first }] },
      recent: { key: "recent", loaded: true, loading: false, sessions: [{ ...first }, { ...second }] },
      groups: new Map([
        [first.directory, { key: `project:${first.directory}`, directory: first.directory, sessions: [{ ...first }] }],
        [second.directory, { key: `project:${second.directory}`, directory: second.directory, sessions: [{ ...second }] }],
      ]),
      search: { sessions: [{ ...first }, { ...second }] },
      query: "",
      showSubagents: true,
      activeSortTimes: {},
      confirmDelete: { session: first },
      renderCalls: 0,
      render() {
        this.renderCalls++
      },
    }
    const handlers = new Map()
    const apiWithEvents = {
      ...api,
      event: {
        on(type, handler) {
          handlers.set(type, handler)
          return () => handlers.delete(type)
        },
      },
    }

    const unsubscribe = subscribeSessionEvents(apiWithEvents, state)
    handlers.get("session.deleted")({
      type: "session.deleted",
      properties: { sessionID: first.id },
    })
    unsubscribe()

    expect(state.recent.sessions.map((session) => session.title)).toEqual(["Project A session", "Project B session"])
    expect(state.groups.get(first.directory).sessions.map((session) => session.title)).toEqual(["Project A session"])
    expect(state.groups.get(second.directory).sessions.map((session) => session.title)).toEqual(["Project B session"])
    expect(state.search.sessions.map((session) => session.title)).toEqual(["Project A session", "Project B session"])
    // A favorite is identified by its session id, so the deleted id leaves the list.
    expect(state.favoriteItems).toEqual({})
  })
})

describe("session navigator favorite parent resolution", () => {
  test("resolves roots once, marks 404s without removing them, and retains transient failures", async () => {
    const directory = "C:/shared/project"
    const roots = ["ses_root_1", "ses_root_2", "ses_root_3"]
    const stale = "ses_stale"
    const transient = "ses_transient"
    let staleExists = false
    const server = favoriteServerApi(
      "server-a",
      [...roots, stale, transient].map((id) => ({ id, directory, title: id })),
      (sessionID) => {
        if (roots.includes(sessionID)) {
          return { ok: true, status: 200, body: { exists: true, session: { id: sessionID } } }
        }
        if (sessionID === stale) {
          return staleExists
            ? { ok: true, status: 200, body: { exists: true, session: { id: sessionID } } }
            : { ok: true, status: 200, body: { exists: false } }
        }
        return { ok: false, status: 500, statusText: "Server Error" }
      },
    )
    const state = stateWithFavorites(server.api)

    await refreshFavoriteParents(server.api, state)
    await refreshFavoriteParents(server.api, state)

    for (const id of roots) {
      expect(server.requests.filter((request) => request.path.endsWith(`/${id}/exists`))).toHaveLength(1)
      expect(state.favoriteItems[id]?.parentID).toBeNull()
      expect(server.items.get(id)?.parentID).toBeNull()
    }
    // A favorite whose session is gone is marked, never removed on the user's behalf.
    expect(server.requests.filter((request) => request.path.endsWith(`/${stale}/exists`))).toHaveLength(2)
    expect(state.favoriteItems[stale]).toBeDefined()
    expect(state.missingFavorites.has(stale)).toBe(true)
    expect(server.items.has(stale)).toBe(true)
    expect(server.writes).not.toContain(false)
    expect(server.requests.filter((request) => request.path.endsWith(`/${transient}/exists`))).toHaveLength(2)
    expect(state.favoriteItems[transient]).toBeDefined()
    expect(state.missingFavorites.has(transient)).toBe(false)
    expect(server.items.has(transient)).toBe(true)

    staleExists = true
    await refreshFavoriteParents(server.api, state)
    expect(state.missingFavorites.has(stale)).toBe(false)
    expect(state.favoriteItems[stale]?.parentID).toBeNull()
  })

  test("isolates the same directory and session ID across server hosts", async () => {
    const directory = "C:/shared/project"
    const favorite = { id: "ses_same", directory, title: "Shared ID" }
    const serverA = favoriteServerApi("server-a", [favorite], () => ({
      ok: true,
      status: 200,
      body: { exists: false },
    }))
    const serverB = favoriteServerApi("server-b", [favorite], () => ({
      ok: true,
      status: 200,
      body: { exists: true, session: { id: favorite.id } },
    }))
    const stateA = stateWithFavorites(serverA.api)
    const stateB = stateWithFavorites(serverB.api)

    await Promise.all([
      refreshFavoriteParents(serverA.api, stateA),
      refreshFavoriteParents(serverB.api, stateB),
    ])

    // Server A only marks its favorite; neither host store receives a removal.
    expect(stateA.favoriteItems[favorite.id]).toBeDefined()
    expect(stateA.missingFavorites.has(favorite.id)).toBe(true)
    expect(serverA.items.has(favorite.id)).toBe(true)
    expect(stateB.favoriteItems[favorite.id]?.parentID).toBeNull()
    expect(stateB.missingFavorites.has(favorite.id)).toBe(false)
    expect(serverB.items.get(favorite.id)?.parentID).toBeNull()
    expect([...serverA.writes, ...serverB.writes]).toEqual([true])
    expect(serverA.requests).toHaveLength(1)
    expect(serverB.requests).toHaveLength(1)
  })
})

describe("session navigator status indicators", () => {
  function statusApi(status) {
    return {
      host: {
        sessions: {
          status: () => status,
        },
      },
    }
  }

  function metaNode() {
    return document.createElement("span")
  }

  const session = { id: "ses_status", title: "Status session", directory: "C:/project", time: { updated: Date.now() } }

  test("sessionVisualStatus forwards every resolved host status and drops unknown values", () => {
    expect(sessionVisualStatus(statusApi("running"), session, "C:/project")).toBe("running")
    expect(sessionVisualStatus(statusApi("attention"), session, "C:/project")).toBe("attention")
    expect(sessionVisualStatus(statusApi("done"), session, "C:/project")).toBe("done")
    expect(sessionVisualStatus(statusApi("incomplete"), session, "C:/project")).toBe("incomplete")
    expect(sessionVisualStatus(statusApi(undefined), session, "C:/project")).toBeUndefined()
    expect(sessionVisualStatus(statusApi("idle"), session, "C:/project")).toBeUndefined()
  })

  test("renders a spinner with the loading class when the host reports running", () => {
    const node = metaNode()
    updateSessionMeta(statusApi("running"), node, session, "C:/project")
    expect(node.classList.contains("oc-session-nav__session-meta--loading")).toBe(true)
    expect(node.querySelector(".oc-session-nav__spinner")).toBeTruthy()
    expect(node.querySelector(".oc-session-nav__status-dot")).toBeNull()
    expect(node.getAttribute("aria-label")).toBe("Session is running")
  })

  test("renders an orange attention dot for an open question", () => {
    const node = metaNode()
    updateSessionMeta(statusApi("attention"), node, session, "C:/project")
    const dot = node.querySelector(".oc-session-nav__status-dot")
    expect(dot).toBeTruthy()
    expect(dot.dataset.status).toBe("attention")
    expect(dot.className).toContain("oc-session-nav__status-dot--attention")
    expect(node.querySelector(".oc-session-nav__spinner")).toBeNull()
  })

  test("renders a green done dot for a fully completed session", () => {
    const node = metaNode()
    updateSessionMeta(statusApi("done"), node, session, "C:/project")
    const dot = node.querySelector(".oc-session-nav__status-dot")
    expect(dot.dataset.status).toBe("done")
    expect(dot.className).toContain("oc-session-nav__status-dot--done")
  })

  test("renders a red incomplete dot for a failed turn", () => {
    const node = metaNode()
    updateSessionMeta(statusApi("incomplete"), node, session, "C:/project")
    const dot = node.querySelector(".oc-session-nav__status-dot")
    expect(dot.dataset.status).toBe("incomplete")
    expect(dot.className).toContain("oc-session-nav__status-dot--incomplete")
  })

  test("renders only the relative timestamp when idle with no status", () => {
    const node = metaNode()
    updateSessionMeta(statusApi(undefined), node, session, "C:/project")
    expect(node.classList.contains("oc-session-nav__session-meta--loading")).toBe(false)
    expect(node.querySelector(".oc-session-nav__spinner")).toBeNull()
    expect(node.querySelector(".oc-session-nav__status-dot")).toBeNull()
    expect(node.textContent).not.toBe("")
  })

  test("priority is owned by the host resolver, so running never coexists with a dot", () => {
    // The host resolves running > attention > terminal before the plugin renders, so the
    // navigator only ever receives a single decisive status and cannot show a stale dot
    // while a session is running.
    const node = metaNode()
    updateSessionMeta(statusApi("running"), node, session, "C:/project")
    expect(node.querySelector(".oc-session-nav__status-dot")).toBeNull()
    expect(node.querySelector(".oc-session-nav__spinner")).toBeTruthy()
  })

  test("statusLabel covers every host status including attention", () => {
    expect(statusLabel("running")).toBe("Session is running")
    expect(statusLabel("attention")).toBe("Session needs attention")
    expect(statusLabel("done")).toBe("Session completed")
    expect(statusLabel("incomplete")).toBe("Session incomplete")
  })
})

describe("session navigator recent-only active projection", () => {
  function state() {
    return {
      active: { key: "active", sessions: [] },
      recent: { key: "recent", sessions: [] },
      search: { key: "search", sessions: [] },
      favoriteItems: {},
      activeSortTimes: {},
      activeSortSequence: 0,
      groups: new Map(),
    }
  }

  test("does not define a separate Active sessions section", () => {
    expect(pluginSource).not.toContain('title: "Active sessions"')
  })

  test("merges active sessions into Recent once by directory and id", () => {
    const first = { id: "ses_shared", directory: "C:/Project-A", time: { updated: 1 } }
    const duplicate = { ...first, title: "duplicate transport copy" }
    const sameIDOtherProject = { ...first, directory: "C:/Project-B", time: { updated: 2 } }
    const api = {
      host: {
        sessions: {
          active: () => [first, duplicate, sameIDOtherProject],
          status: () => "running",
          working: () => true,
        },
      },
    }
    const current = state()

    syncActiveSessions(api, current)
    syncActiveSessions(api, current)

    expect(current.active.sessions).toHaveLength(2)
    expect(current.recent.sessions).toHaveLength(2)
    expect(current.recent.sessions.map((session) => session.directory).sort()).toEqual(["C:/Project-A", "C:/Project-B"])
  })

  test("sorts running and attention sessions before newer idle sessions", () => {
    const running = { id: "ses_running", directory: "C:/Project", time: { updated: 1 } }
    const attention = { id: "ses_attention", directory: "C:/Project", time: { updated: 2 } }
    const idle = { id: "ses_idle", directory: "C:/Project", time: { updated: 999 } }
    const statuses = { [running.id]: "running", [attention.id]: "attention" }
    const api = {
      host: {
        sessions: {
          active: () => [idle, running, attention],
          status: ({ sessionID }) => statuses[sessionID],
          working: ({ sessionID }) => sessionID === running.id,
        },
      },
    }
    const current = state()

    syncActiveSessions(api, current)

    expect(current.recent.sessions.map((session) => session.id).slice(0, 2).sort()).toEqual(
      [running.id, attention.id].sort(),
    )
    expect(current.recent.sessions.at(-1)?.id).toBe(idle.id)
  })

  test("moves the most recently activated session ahead of already active sessions", () => {
    const first = { id: "ses_first", directory: "C:/Project", time: { updated: 1 } }
    const second = { id: "ses_second", directory: "C:/Project", time: { updated: 2 } }
    const active = [first]
    const api = {
      host: {
        sessions: {
          active: () => active,
          status: () => "running",
          working: () => true,
        },
      },
    }
    const current = state()

    syncActiveSessions(api, current)
    active.unshift(second)
    syncActiveSessions(api, current)

    expect(current.recent.sessions.slice(0, 2).map((session) => session.id)).toEqual([second.id, first.id])
  })
})
