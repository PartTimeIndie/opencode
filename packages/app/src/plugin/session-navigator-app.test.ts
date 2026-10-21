import { beforeEach, describe, expect, test } from "bun:test"

type SessionNavigatorModule = {
  default: {
    app: (api: unknown) => void
  }
  probeSession: (
    api: unknown,
    input: { directory: string; sessionID: string },
  ) => Promise<{ exists: boolean; session?: unknown }>
  subscribeSessionEvents: (api: unknown, state: object) => () => void
}

type DockRegistration = {
  mount: (context: { area: string; element: HTMLElement; signal: AbortSignal }) => () => void
}

const navigator = (await import(
  new URL("../../../../.opencode/plugins/session-navigator-app/index.js", import.meta.url).href
)) as unknown as SessionNavigatorModule

beforeEach(() => {
  document.body.replaceChildren()
  localStorage.clear()
})

describe("session navigator responsive ordering", () => {
  test("declares the capabilities used by the session navigator", async () => {
    const manifest = await Bun.file(
      new URL("../../../../.opencode/plugins/session-navigator-app/package.json", import.meta.url),
    ).json()

    expect(manifest.opencode.app.capabilities).toEqual([
      "ui:dock",
      "kv",
      "client",
      "events",
      "host:projects",
      "host:navigation",
      "host:sessions",
      "host:http",
    ])
  })

  test("falls back to the client when host http is exposed without a capability grant", async () => {
    let hostRequests = 0
    let clientRequests = 0
    const result = await navigator.probeSession(
      {
        capabilities: new Set(["client"]),
        host: {
          http: {
            request: async () => {
              hostRequests++
              return { ok: false, status: 403, statusText: "Missing host:http capability" }
            },
          },
        },
        client: {
          session: {
            get: async () => {
              clientRequests++
              return { data: { id: "ses_mobile" } }
            },
          },
        },
      },
      { directory: "C:\\repo", sessionID: "ses_mobile" },
    )

    expect(result).toEqual({ exists: true, session: { id: "ses_mobile" } })
    expect(hostRequests).toBe(0)
    expect(clientRequests).toBe(1)
  })

  test("keeps every working session in Recent above preview-limited inactive sessions", async () => {
    Object.defineProperty(window, "matchMedia", {
      value: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
      configurable: true,
    })
    const active = Array.from({ length: 7 }, (_, index) => ({
      id: `ses_active_${index}`,
      directory: `C:/project-${index}`,
      title: `Active ${index}`,
      time: { created: index, updated: index },
    }))
    let registration: DockRegistration | undefined
    const api = {
      dock: {
        state: { item: () => ({}) },
        register: (input: DockRegistration) => {
          registration = input
        },
        open: { item: () => {} },
      },
      kv: { get: () => true, set: () => {} },
      host: {
        projects: {
          list: () => [],
          subscribe: (listener: (projects: unknown[]) => void) => {
            listener([])
            return () => {}
          },
          open: () => {},
        },
        sessions: {
          active: () => active,
          working: () => true,
          status: () => "running",
          subscribe: () => () => {},
          favorites: {
            list: () => [],
            subscribe: () => () => {},
          },
        },
      },
      client: {
        experimental: {
          session: {
            list: async () => ({ data: [] }),
          },
        },
      },
    }
    navigator.default.app(api)

    const element = document.createElement("div")
    document.body.append(element)
    const abort = registration?.mount({ area: "left", element, signal: new AbortController().signal })
    await Promise.resolve()

    expect(element.querySelector('[data-group-key="active"]')).toBeNull()
    const recent = element.querySelector('[data-group-key="recent"]')
    expect(recent?.querySelector(".oc-session-nav__group-title")?.textContent).toBe("Recent sessions")
    expect(recent?.querySelectorAll(".oc-session-nav__session")).toHaveLength(7)

    abort?.()
  })

  test("moves a newly active session to Recent and keeps it there after completion", async () => {
    Object.defineProperty(window, "matchMedia", {
      value: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
      configurable: true,
    })
    let registration: DockRegistration | undefined
    let active: Array<{ id: string; directory: string; title: string }> = []
    let statusListener = () => {}
    const api = {
      dock: {
        state: { item: () => ({}) },
        register: (input: DockRegistration) => {
          registration = input
        },
        open: { item: () => {} },
      },
      kv: { get: () => true, set: () => {} },
      host: {
        projects: {
          list: () => [],
          subscribe: (listener: (projects: unknown[]) => void) => {
            listener([])
            return () => {}
          },
          open: () => {},
        },
        sessions: {
          active: () => active,
          working: () => active.length > 0,
          status: () => (active.length > 0 ? "running" : "idle"),
          subscribe: (listener: () => void) => {
            statusListener = listener
            return () => {}
          },
          favorites: {
            list: () => [],
            subscribe: () => () => {},
          },
        },
      },
      client: {
        experimental: {
          session: {
            list: async () => ({ data: [] }),
          },
        },
      },
    }
    navigator.default.app(api)

    const element = document.createElement("div")
    document.body.append(element)
    const abort = registration?.mount({ area: "left", element, signal: new AbortController().signal })
    await Promise.resolve()
    expect(element.querySelector('[data-group-key="active"]')).toBeNull()

    active = [{ id: "ses_started", directory: "C:/project", title: "Started after mount" }]
    statusListener()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(element.querySelector('[data-group-key="active"]')).toBeNull()
    expect(element.querySelector('[data-group-key="recent"] .oc-session-nav__session')?.textContent).toContain(
      "Started after mount",
    )

    active = []
    statusListener()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(element.querySelector('[data-group-key="active"]')).toBeNull()
    expect(element.querySelector('[data-group-key="recent"] .oc-session-nav__session')?.textContent).toContain(
      "Started after mount",
    )

    abort?.()
  })

  test("falls back only for the synthetic missing-capability response", async () => {
    let clientRequests = 0
    const api = {
      capabilities: new Set(["host:http"]),
      host: {
        http: {
          request: async () => ({ ok: false, status: 403, statusText: "Missing host:http capability" }),
        },
      },
      client: {
        session: {
          get: async () => {
            clientRequests++
            return { data: { id: "ses_mobile" } }
          },
        },
      },
    }

    await expect(
      navigator.probeSession(api, { directory: "C:\\repo", sessionID: "ses_mobile" }),
    ).resolves.toEqual({ exists: true, session: { id: "ses_mobile" } })
    expect(clientRequests).toBe(1)

    api.host.http.request = async () => ({ ok: false, status: 403, statusText: "Forbidden", text: "Denied" })
    await expect(
      navigator.probeSession(api, { directory: "C:\\repo", sessionID: "ses_mobile" }),
    ).rejects.toThrow("Denied")
    expect(clientRequests).toBe(1)
  })

  test("accepts the Effect HTTP success envelope for session existence", async () => {
    const result = await navigator.probeSession(
      {
        capabilities: new Set(["host:http"]),
        host: {
          http: {
            request: async () => ({
              ok: true,
              body: { data: { exists: true, session: { id: "ses_mobile" } } },
            }),
          },
        },
      },
      { directory: "C:\\repo", sessionID: "ses_mobile" },
    )

    expect(result).toEqual({ exists: true, session: { id: "ses_mobile" } })
  })

  test("rejects malformed successful session existence responses", async () => {
    await expect(
      navigator.probeSession(
        {
          capabilities: new Set(["host:http"]),
          host: { http: { request: async () => ({ ok: true, body: { data: { exists: true } } }) } },
        },
        { directory: "C:\\repo", sessionID: "ses_mobile" },
      ),
    ).rejects.toThrow("Session existence response was invalid")
  })

  test("moves recent sessions above favorites only while the mobile dock query matches", async () => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>()
    const mobile = {
      matches: false,
      media: "(max-width: 767px), (pointer: coarse) and (max-height: 600px)",
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    }
    Object.defineProperty(window, "matchMedia", {
      value: () => mobile,
      configurable: true,
    })

    let registration: DockRegistration | undefined
    const projects = {
      list: () => [],
      subscribe: (listener: (projects: unknown[]) => void) => {
        listener([])
        return () => {}
      },
      open: () => {},
    }
    const api = {
      dock: {
        state: { item: () => ({}) },
        register: (input: DockRegistration) => {
          registration = input
        },
        open: { item: () => {} },
      },
      host: {
        projects,
        sessions: {
          favorites: {
            list: () => [],
            subscribe: () => () => {},
          },
          subscribe: () => () => {},
        },
      },
      client: {
        experimental: {
          session: {
            list: async () => ({ data: [] }),
          },
        },
      },
    }
    navigator.default.app(api)

    const element = document.createElement("div")
    document.body.append(element)
    const abort = registration?.mount({ area: "left", element, signal: new AbortController().signal })
    const titles = () => [...element.querySelectorAll(".oc-session-nav__group-title")].map((node) => node.textContent)

    expect(titles()).toEqual(["Favorites", "Recent sessions"])
    expect(listeners.size).toBe(1)

    mobile.matches = true
    listeners.forEach((listener) => listener({ matches: true } as MediaQueryListEvent))
    await Promise.resolve()

    expect(titles()).toEqual(["Recent sessions", "Favorites"])

    abort?.()
    expect(listeners.size).toBe(0)
  })

  test("keeps the durable source and generated runtime copy synchronized", async () => {
    const source = await Bun.file(
      new URL("../../../../.opencode/plugin-sources/session-navigator-app/index.js", import.meta.url),
    ).text()
    const runtime = await Bun.file(
      new URL("../../../../.opencode/plugins/session-navigator-app/index.js", import.meta.url),
    ).text()

    expect(runtime.replaceAll("\r\n", "\n")).toBe(source.replaceAll("\r\n", "\n"))
  })
})

describe("session navigator global event scope", () => {
  type NavigatorSession = { id: string; directory?: string; title?: string; time?: { created?: number; updated?: number } }
  type NavigatorGroup = { key: string; directory: string | undefined; loaded: boolean; loadedAll: boolean; sessions: NavigatorSession[]; [key: string]: unknown }

  const group = (directory: string | undefined, key: string): NavigatorGroup => ({
    key,
    directory,
    expanded: true,
    loading: false,
    reloadPreview: false,
    loaded: true,
    loadedAll: true,
    hasMore: false,
    sessions: [],
  })

  function navigatorState(api: unknown) {
    return {
      api,
      host: (api as { host?: unknown }).host ?? api,
      query: "",
      projects: [] as unknown[],
      groups: new Map<string, NavigatorGroup>([
        ["C:\\GitRepros\\PU", group("C:\\GitRepros\\PU", "project:C:\\GitRepros\\PU")],
        ["global", group("global", "project:global")],
      ]),
      active: group(undefined, "active"),
      favorites: group(undefined, "favorites"),
      favoriteItems: {} as Record<string, unknown>,
      activeSortTimes: {} as Record<string, number>,
      activeSortSequence: 0,
      recent: group(undefined, "recent"),
      search: { sequence: 0, loading: false, showLoading: false, sessions: [] as NavigatorSession[], duration: 0 },
      searchContent: {} as Record<string, unknown>,
      missingSessions: new Set<string>(),
      showSubagents: true,
      confirmDelete: undefined,
      contextMenu: undefined,
      pendingSessionActivation: undefined,
      suppressedSessionActivation: undefined,
      dockArea: "left",
      renderQueued: false,
    }
  }

  test("keeps the payload directory when a session event arrives via the global scope", () => {
    const handlers = new Map<string, (event: unknown, context: unknown) => void>()
    const api = {
      event: {
        on: (type: string, handler: (event: unknown, context: unknown) => void) => {
          handlers.set(type, handler)
          return () => handlers.delete(type)
        },
      },
    }
    const state = navigatorState(api)
    const unsubscribe = navigator.subscribeSessionEvents(api, state)

    const session: NavigatorSession = {
      id: "ses_pu_global_scope",
      directory: "C:/GitRepros/PU",
      title: "PU session",
      time: { created: 1000, updated: 2000 },
    }
    handlers.get("session.updated")!({ properties: { info: session } }, { directory: "global" })

    const normalized = String(session.directory).replaceAll("\\", "/").toLowerCase()
    expect(normalized).toBe("c:/gitrepros/pu")
    const puGroup = state.groups.get("C:\\GitRepros\\PU")!
    expect(puGroup.sessions.map((item) => item.id)).toContain(session.id)
    const globalGroup = state.groups.get("global")!
    expect(globalGroup.sessions.map((item) => item.id)).not.toContain(session.id)
    expect(state.recent.sessions.map((item) => item.id)).toContain(session.id)
    unsubscribe()
  })

  test.each(["session.created", "session.updated"])("%s does not mutate the shared event session", (type) => {
    const handlers = new Map<string, (event: unknown, context: unknown) => void>()
    const api = {
      event: {
        on: (type: string, handler: (event: unknown, context: unknown) => void) => {
          handlers.set(type, handler)
          return () => handlers.delete(type)
        },
      },
    }
    const state = navigatorState(api)
    const unsubscribe = navigator.subscribeSessionEvents(api, state)
    // Host reducers and other plugins consume this same event object.
    const session = Object.freeze({
      id: "ses_shared_project_event",
      directory: "C:/GitRepros/PU",
      title: "PU session",
      time: { created: 1000, updated: 2000 },
    })
    handlers.get(type)!({ properties: { info: session } }, { directory: "global" })

    expect(session.directory).toBe("C:/GitRepros/PU")
    const puGroup = state.groups.get("C:\\GitRepros\\PU")!
    expect(puGroup.sessions[0]?.directory).toBe("C:\\GitRepros\\PU")
    expect(puGroup.sessions[0]).not.toBe(session)
    expect(state.groups.get("global")!.sessions).toEqual([])
    unsubscribe()
  })

  test("still adopts the transport directory for path spelling on a project stream", () => {
    const handlers = new Map<string, (event: unknown, context: unknown) => void>()
    const api = {
      event: {
        on: (type: string, handler: (event: unknown, context: unknown) => void) => {
          handlers.set(type, handler)
          return () => handlers.delete(type)
        },
      },
    }
    const state = navigatorState(api)
    const unsubscribe = navigator.subscribeSessionEvents(api, state)

    const session: NavigatorSession = {
      id: "ses_pu_path_spelling",
      directory: undefined,
      title: "PU session",
      time: { created: 1000, updated: 2000 },
    }
    handlers.get("session.updated")!({ properties: { info: session } }, { directory: "C:\\GitRepros\\PU" })

    const puGroup = state.groups.get("C:\\GitRepros\\PU")!
    expect(puGroup.sessions.map((item) => item.id)).toContain(session.id)
    const globalGroup = state.groups.get("global")!
    expect(globalGroup.sessions.map((item) => item.id)).not.toContain(session.id)
    unsubscribe()
  })
})
