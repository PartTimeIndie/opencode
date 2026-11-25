import { describe, expect, test } from "bun:test"
import {
  collectNewSessionDeepLinks,
  collectOpenProjectDeepLinks,
  collectPluginHandoffDeepLinks,
  consumeDeepLinkEvent,
  drainPendingDeepLinks,
  parseDeepLink,
  parseNewSessionDeepLink,
  parsePluginHandoffDeepLink,
} from "./deep-links"
import { type Session } from "@opencode-ai/sdk/v2/client"
import {
  activateHomeProjectSelection,
  childSessionOnPath,
  closeHomeProject,
  displayName,
  effectiveWorkspaceOrder,
  errorMessage,
  hasProjectPermissions,
  homeProjectDirectories,
  homeProjectNavigation,
  homeProjectsFor,
  homeSessionServerStatus,
  getProjectAvatarSource,
  getProjectAvatarMonochrome,
  latestRootSession,
  projectForSession,
  projectsForDirectorySelection,
  resumedProjectDirectories,
  selectHomeProjectSelection,
  sortedRootSessions,
  visibleRootSessions,
} from "./helpers"
import { pathKey } from "@/utils/path-key"
import { ServerConnection } from "@/context/server"

const serverKey = ServerConnection.Key.make

describe("window restore project refresh", () => {
  test("does not cold-bootstrap saved inactive projects", () => {
    const projects = Array.from({ length: 29 }, (_, index) => `E:/projects/${index}`)
    expect(resumedProjectDirectories({
      current: projects[4], projects, questions: [], loaded: () => false,
    })).toEqual([projects[4]!])
  })

  test("preserves already loaded projects and pending questions", () => {
    expect(resumedProjectDirectories({
      current: "E:/active", projects: ["E:/cold", "E:/loaded"], questions: ["E:/question"],
      loaded: (directory) => directory === "E:/loaded",
    })).toEqual(["E:/active", "E:/question", "E:/loaded"])
  })

  test("deduplicates Windows aliases without creating a project on home", () => {
    expect(resumedProjectDirectories({
      projects: ["E:/Loaded"], questions: ["e:\\loaded"], loaded: () => true,
    })).toEqual(["e:\\loaded"])
    expect(resumedProjectDirectories({ projects: ["E:/cold"], questions: [], loaded: () => false })).toEqual([])
  })
})

describe("project avatar source", () => {
  test("uses a user image instead of the built-in monochrome OpenCode mark", () => {
    const openCode = "4b0ea68d7af9a6031a7ffda7ad66e0cb83315750"
    expect(getProjectAvatarSource(openCode)).toStartWith("data:image/svg+xml,")
    expect(getProjectAvatarSource(openCode, { override: "manual" })).toBe("manual")
    expect(getProjectAvatarMonochrome(openCode, { override: "manual" })).toBe(false)
  })

  test("preserves existing layers and replaces only the letter fallback", () => {
    expect(getProjectAvatarSource("project", { override: "manual", url: "favicon", color: "pink", generated: "ai" })).toBe("manual")
    expect(getProjectAvatarSource("project", { url: "favicon", generated: "ai" })).toBe("favicon")
    expect(getProjectAvatarSource("project", { color: "pink", url: "hidden-favicon", generated: "ai" })).toBe("ai")
    expect(getProjectAvatarSource("project", { color: "pink" })).toBeUndefined()
  })
})

const session = (input: Partial<Session> & Pick<Session, "id" | "directory">) =>
  ({
    title: "",
    version: "v2",
    parentID: undefined,
    messageCount: 0,
    permissions: { session: {}, share: {} },
    time: { created: 0, updated: 0, archived: undefined },
    ...input,
  }) as Session

describe("layout deep links", () => {
  test("parses open-project deep links", () => {
    expect(parseDeepLink("opencode://open-project?directory=/tmp/demo")).toBe("/tmp/demo")
  })

  test("ignores non-project deep links", () => {
    expect(parseDeepLink("opencode://other?directory=/tmp/demo")).toBeUndefined()
    expect(parseDeepLink("https://example.com")).toBeUndefined()
  })

  test("ignores malformed deep links safely", () => {
    expect(() => parseDeepLink("opencode://open-project/%E0%A4%A%")).not.toThrow()
    expect(parseDeepLink("opencode://open-project/%E0%A4%A%")).toBeUndefined()
  })

  test("parses links when URL.canParse is unavailable", () => {
    const original = Object.getOwnPropertyDescriptor(URL, "canParse")
    Object.defineProperty(URL, "canParse", { configurable: true, value: undefined })
    try {
      expect(parseDeepLink("opencode://open-project?directory=/tmp/demo")).toBe("/tmp/demo")
    } finally {
      if (original) Object.defineProperty(URL, "canParse", original)
      if (!original) Reflect.deleteProperty(URL, "canParse")
    }
  })

  test("ignores open-project deep links without directory", () => {
    expect(parseDeepLink("opencode://open-project")).toBeUndefined()
    expect(parseDeepLink("opencode://open-project?directory=")).toBeUndefined()
  })

  test("collects only valid open-project directories", () => {
    const result = collectOpenProjectDeepLinks([
      "opencode://open-project?directory=/a",
      "opencode://other?directory=/b",
      "opencode://open-project?directory=/c",
    ])
    expect(result).toEqual(["/a", "/c"])
  })

  test("parses new-session deep links with optional prompt", () => {
    expect(parseNewSessionDeepLink("opencode://new-session?directory=/tmp/demo")).toEqual({ directory: "/tmp/demo" })
    expect(parseNewSessionDeepLink("opencode://new-session?directory=/tmp/demo&prompt=hello%20world")).toEqual({
      directory: "/tmp/demo",
      prompt: "hello world",
    })
  })

  test("ignores new-session deep links without directory", () => {
    expect(parseNewSessionDeepLink("opencode://new-session")).toBeUndefined()
    expect(parseNewSessionDeepLink("opencode://new-session?directory=")).toBeUndefined()
  })

  test("collects only valid new-session deep links", () => {
    const result = collectNewSessionDeepLinks([
      "opencode://new-session?directory=/a",
      "opencode://open-project?directory=/b",
      "opencode://new-session?directory=/c&prompt=ship%20it",
    ])
    expect(result).toEqual([{ directory: "/a" }, { directory: "/c", prompt: "ship it" }])
  })

  test("parses generic plugin handoffs and rejects malformed or legacy envelopes", () => {
    const link = `opencode://plugin-handoff?${new URLSearchParams({ pluginID: "@example/export", handlerID: "open", directory: "/tmp/demo", payload: JSON.stringify({ archive: "123" }) })}`
    expect(parsePluginHandoffDeepLink(link)).toEqual({ pluginID: "@example/export", handlerID: "open", directory: "/tmp/demo", payload: { archive: "123" } })
    expect(parsePluginHandoffDeepLink(link.replace("plugin-handoff?", "plugin-handoff/?"))).toEqual({
      pluginID: "@example/export",
      handlerID: "open",
      directory: "/tmp/demo",
      payload: { archive: "123" },
    })
    expect(collectPluginHandoffDeepLinks([link, "opencode://open-project?directory=/a"])).toHaveLength(1)
    expect(parsePluginHandoffDeepLink(link + "&payload=null")).toBeUndefined()
    expect(parsePluginHandoffDeepLink(link.replace("plugin-handoff?", "plugin-handoff/unexpected?"))).toBeUndefined()
    expect(parsePluginHandoffDeepLink(link.replace("payload=", "missing="))).toBeUndefined()
    expect(parsePluginHandoffDeepLink("opencode://scheduled-job-run?directory=/a&scopeId=scope&slug=job&runId=1")).toBeUndefined()
  })

  test("drains global deep links once", () => {
    const target = {
      __OPENCODE__: {
        deepLinks: ["opencode://open-project?directory=/a"],
      },
    } as unknown as Window & { __OPENCODE__?: { deepLinks?: string[] } }

    expect(drainPendingDeepLinks(target)).toEqual(["opencode://open-project?directory=/a"])
    expect(drainPendingDeepLinks(target)).toEqual([])
  })

  test("consumes queued and live deep links without duplicates", () => {
    const scheduled = "opencode://plugin-handoff?directory=/a&pluginID=example&handlerID=open&payload=null"
    const target = {
      __OPENCODE__: {
        deepLinks: [scheduled, "opencode://open-project?directory=/b"],
      },
    } as unknown as Window & { __OPENCODE__?: { deepLinks?: string[] } }

    expect(consumeDeepLinkEvent(target, [scheduled])).toEqual([
      scheduled,
      "opencode://open-project?directory=/b",
    ])
    expect(drainPendingDeepLinks(target)).toEqual([])
  })
})

describe("layout workspace helpers", () => {
  test("normalizes trailing slash in workspace key", () => {
    expect(String(pathKey("/tmp/demo///"))).toBe("/tmp/demo")
    expect(String(pathKey("C:\\tmp\\demo\\\\"))).toBe("C:/tmp/demo")
  })

  test("preserves posix and drive roots in workspace key", () => {
    expect(String(pathKey("/"))).toBe("/")
    expect(String(pathKey("///"))).toBe("/")
    expect(String(pathKey("C:\\"))).toBe("C:/")
    expect(String(pathKey("C://"))).toBe("C:/")
    expect(String(pathKey("C:///"))).toBe("C:/")
  })

  test("keeps local first while preserving known order", () => {
    const result = effectiveWorkspaceOrder("/root", ["/root", "/b", "/c"], ["/root", "/c", "/a", "/b"])
    expect(result).toEqual(["/root", "/c", "/b"])
  })

  test("finds the latest root session across workspaces", () => {
    const result = latestRootSession(
      [
        {
          path: { directory: "/root" },
          session: [session({ id: "root", directory: "/root", time: { created: 1, updated: 1, archived: undefined } })],
        },
        {
          path: { directory: "/workspace" },
          session: [
            session({
              id: "workspace",
              directory: "/workspace",
              time: { created: 2, updated: 2, archived: undefined },
            }),
          ],
        },
      ],
      120_000,
    )

    expect(result?.id).toBe("workspace")
  })

  test("detects project permissions with a filter", () => {
    const result = hasProjectPermissions(
      {
        root: [{ id: "perm-root" }, { id: "perm-hidden" }],
        child: [{ id: "perm-child" }],
      },
      (item) => item.id === "perm-child",
    )

    expect(result).toBe(true)
  })

  test("ignores project permissions filtered out", () => {
    const result = hasProjectPermissions(
      {
        root: [{ id: "perm-root" }],
      },
      () => false,
    )

    expect(result).toBe(false)
  })

  test("ignores archived and child sessions when finding latest root session", () => {
    const result = latestRootSession(
      [
        {
          path: { directory: "/workspace" },
          session: [
            session({
              id: "archived",
              directory: "/workspace",
              time: { created: 10, updated: 10, archived: 10 },
            }),
            session({
              id: "child",
              directory: "/workspace",
              parentID: "parent",
              time: { created: 20, updated: 20, archived: undefined },
            }),
            session({
              id: "root",
              directory: "/workspace",
              time: { created: 30, updated: 30, archived: undefined },
            }),
          ],
        },
      ],
      120_000,
    )

    expect(result?.id).toBe("root")
  })

  test("sorts visible root sessions by explicit updated time", () => {
    const result = sortedRootSessions(
      {
        path: { directory: "/workspace" },
        session: [
          session({ id: "older", directory: "/workspace", time: { created: 1, updated: 100, archived: undefined } }),
          session({ id: "child", directory: "/workspace", parentID: "root" }),
          session({ id: "newer", directory: "/workspace", time: { created: 1, updated: 200, archived: undefined } }),
        ],
      },
      1_000,
    )

    expect(result.map((item) => item.id)).toEqual(["newer", "older"])
  })

  test("reads visible root sessions without promoting their stores to full bootstrap", () => {
    const acquired: { directory: string; bootstrap: false }[] = []
    const sessions = [
      session({ id: "root-session", directory: "/root" }),
      session({ id: "inactive-session", directory: "/inactive" }),
    ]

    const result = visibleRootSessions(
      ["/root", "/inactive"],
      (directory, options) => {
        acquired.push({ directory, bootstrap: options.bootstrap })
        return {
          0: {
            path: { directory },
            session: sessions.filter((item) => item.directory === directory),
          },
        }
      },
      1_000,
    )

    expect(acquired).toEqual([
      { directory: "/root", bootstrap: false },
      { directory: "/inactive", bootstrap: false },
    ])
    expect(result.map((item) => item.id)).toEqual(["root-session", "inactive-session"])
  })

  test("keeps Windows sessions visible when the server normalizes path casing", () => {
    const result = sortedRootSessions(
      {
        path: { directory: "c:/opencode/project" },
        session: [session({ id: "windows", directory: "C:/OpenCode/Project" })],
      },
      1_000,
    )

    expect(result.map((item) => item.id)).toEqual(["windows"])
  })

  test("anchors active root sessions until they become idle", () => {
    const store = {
      path: { directory: "/workspace" },
      session: [
        session({ id: "active-anchor-a", directory: "/workspace", time: { created: 1, updated: 100, archived: undefined } }),
        session({ id: "active-anchor-b", directory: "/workspace", time: { created: 1, updated: 200, archived: undefined } }),
      ],
      session_status: { "active-anchor-a": { type: "busy" as const } } as Record<string, { type: "busy" } | undefined>,
    }

    expect(sortedRootSessions(store, 1_000).map((item) => item.id)).toEqual(["active-anchor-a", "active-anchor-b"])

    store.session[0] = session({
      id: "active-anchor-a",
      directory: "/workspace",
      time: { created: 1, updated: 5_000, archived: undefined },
    })
    store.session_status["active-anchor-b"] = { type: "busy" }
    expect(sortedRootSessions(store, 2_000).map((item) => item.id)).toEqual(["active-anchor-b", "active-anchor-a"])

    store.session[0] = session({
      id: "active-anchor-a",
      directory: "/workspace",
      time: { created: 1, updated: 9_000, archived: undefined },
    })
    expect(sortedRootSessions(store, 3_000).map((item) => item.id)).toEqual(["active-anchor-b", "active-anchor-a"])

    delete store.session_status["active-anchor-a"]
    expect(sortedRootSessions(store, 4_000).map((item) => item.id)).toEqual(["active-anchor-a", "active-anchor-b"])
  })

  test("finds the direct child on the active session path", () => {
    const list = [
      session({ id: "root", directory: "/workspace" }),
      session({ id: "child", directory: "/workspace", parentID: "root" }),
      session({ id: "leaf", directory: "/workspace", parentID: "child" }),
    ]

    expect(childSessionOnPath(list, "root", "leaf")?.id).toBe("child")
    expect(childSessionOnPath(list, "child", "leaf")?.id).toBe("leaf")
    expect(childSessionOnPath(list, "root", "root")).toBeUndefined()
    expect(childSessionOnPath(list, "root", "other")).toBeUndefined()
  })

  test("formats fallback project display name", () => {
    expect(displayName({ worktree: "/tmp/app" })).toBe("app")
    expect(displayName({ worktree: "/tmp/app", name: "My App" })).toBe("My App")
    expect(displayName({ worktree: "/" })).toBe("/")
  })

  test("prefers session project id when matching a moved session to a project", () => {
    const result = projectForSession(
      session({ id: "moved", directory: "/old", projectID: "project-new" }),
      [
        { id: "project-old", worktree: "/old" },
        { id: "project-new", worktree: "/new" },
      ],
    )

    expect(result?.worktree).toBe("/new")
  })

  test("validates home project selection against the clicked server projects", () => {
    const current = { server: serverKey("https://windows.example"), directory: "C:\\work\\shared" }
    const debian = serverKey("https://debian.example")

    expect(selectHomeProjectSelection(current, debian, "/home/luke/shared", [{ worktree: "/home/luke/other" }])).toBeUndefined()
    expect(selectHomeProjectSelection(current, debian, "/home/luke/shared", [{ worktree: "/home/luke/shared" }])).toEqual({
      server: debian,
      directory: "/home/luke/shared",
    })
    expect(
      selectHomeProjectSelection({ server: debian, directory: "/home/luke/shared" }, debian, "/home/luke/shared", [
        { worktree: "/home/luke/shared" },
      ]),
    ).toEqual({ server: debian, directory: "/home/luke/shared" })
    expect(
      selectHomeProjectSelection(current, debian, "/home/luke/shared/", [{ worktree: "/home/luke/shared" }]),
    ).toEqual({ server: debian, directory: "/home/luke/shared/" })
  })

  test("keeps the active directory selectable while persisted and API projects load", () => {
    expect(projectsForDirectorySelection([], [], "C:\\OpenCode\\NewSessionShortcut")).toEqual([
      { worktree: "C:\\OpenCode\\NewSessionShortcut", expanded: true },
    ])
    expect(
      projectsForDirectorySelection(
        [{ worktree: "C:\\OpenCode\\Project", expanded: true, sandboxes: ["C:\\OpenCode\\Project-copy"] }],
        [],
        "C:/OpenCode/Project-copy/",
      ),
    ).toHaveLength(1)
  })

  test("uses API projects when the persisted project list is empty", () => {
    const api = [
      { id: "project-api", name: "API Project", worktree: "/api/project" },
      { id: "project-invalid", name: "Missing worktree" },
    ]

    expect(homeProjectsFor([], api)).toEqual([
      { id: "project-api", name: "API Project", worktree: "/api/project", expanded: true },
    ])
    expect(homeProjectsFor([{ worktree: "/persisted", expanded: false }], api)).toEqual([
      { worktree: "/persisted", expanded: false },
    ])
  })

  test("keeps one project per equivalent path, not per name or Git history", () => {
    const first = { id: "old", worktree: "C:/Projects/PU/./", name: "PU", time: { created: 1, updated: 2 } }
    const current = { id: "current", worktree: "c:\\projects\\pu", name: "PU", time: { created: 3, updated: 4 }, icon: { override: "custom" } }
    const separate = { ...current, worktree: "D:/Projects/PU" }
    expect(homeProjectsFor([], [first, current, separate])).toEqual([
      { ...current, expanded: true },
      { ...separate, expanded: true },
    ])
  })

  test("opens an API fallback project before touching and selecting it", () => {
    const calls: string[] = []
    const next = activateHomeProjectSelection(
      { server: serverKey("https://windows.example") },
      serverKey("https://debian.example"),
      "/api/project",
      homeProjectsFor([], [{ id: "project-api", worktree: "/api/project" }]),
      {
        open: (directory) => calls.push(`open:${directory}`),
        touch: (directory) => calls.push(`touch:${directory}`),
      },
    )

    expect(calls).toEqual(["open:/api/project", "touch:/api/project"])
    expect(next).toEqual({ server: serverKey("https://debian.example"), directory: "/api/project" })
  })

  test("closes a home project through its server context", () => {
    const closed: string[] = []

    expect(
      closeHomeProject(
        { server: serverKey("https://windows.example"), directory: "/shared" },
        serverKey("https://debian.example"),
        { close: (directory) => closed.push(directory) },
        "/shared",
      ),
    ).toEqual({ server: serverKey("https://windows.example"), directory: "/shared" })
    expect(closed).toEqual(["/shared"])
    expect(
      closeHomeProject(
        { server: serverKey("https://debian.example"), directory: "/shared" },
        serverKey("https://debian.example"),
        { close: (directory) => closed.push(directory) },
        "/shared",
      ),
    ).toEqual({ server: serverKey("https://debian.example") })
  })

  test("defers home project navigation until its server is active", () => {
    expect(
      homeProjectNavigation(serverKey("sidecar"), serverKey("https://debian.example"), "/YW1hem9u/session"),
    ).toEqual({
      server: serverKey("https://debian.example"),
      href: "/YW1hem9u/session",
    })
    expect(
      homeProjectNavigation(
        serverKey("https://debian.example"),
        serverKey("https://debian.example"),
        "/YW1hem9u/session",
      ),
    ).toEqual({
      href: "/YW1hem9u/session",
    })
  })

  test("preserves picker order when adding multiple projects", () => {
    expect(homeProjectDirectories(["/first", "/second"])).toEqual(["/first", "/second"])
    expect(homeProjectDirectories("/only")).toEqual(["/only"])
    expect(homeProjectDirectories(null)).toEqual([])
  })

  test("hides status derived from an inactive server", () => {
    let reads = 0
    const status = () => {
      reads++
      return { working: true, tint: "red" }
    }
    expect(homeSessionServerStatus(false, status)).toEqual({
      working: false,
      tint: undefined,
    })
    expect(reads).toBe(0)
    expect(homeSessionServerStatus(true, status)).toEqual({
      working: true,
      tint: "red",
    })
    expect(reads).toBe(1)
  })

  test("extracts api error message and fallback", () => {
    expect(errorMessage({ data: { message: "boom" } }, "fallback")).toBe("boom")
    expect(errorMessage(new Error("broken"), "fallback")).toBe("broken")
    expect(errorMessage("unknown", "fallback")).toBe("fallback")
  })
})
