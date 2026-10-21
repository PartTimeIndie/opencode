import { describe, expect, test } from "bun:test"

type GitActionInput = { action: string; directory?: string } & Record<string, unknown>

type DockMountContext = {
  element: HTMLElement
  signal: AbortSignal
}

type ToolbarRegistration = {
  id: string
  run: (context: { directory?: string; sessionID?: string }) => Promise<void>
}

type WorkbenchPlugin = {
  default: {
    app: (api: Record<string, unknown>) => void
  }
}

const plugin = (await import(
  new URL("../../../../.opencode/plugins/git-workbench-app/index.js", import.meta.url).href
)) as unknown as WorkbenchPlugin

const PROJECT_A = "C:/repos/project-a"
const PROJECT_B = "C:/repos/project-b"

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
async function settle(rounds = 12) {
  for (let index = 0; index < rounds; index++) {
    await tick()
    await flush()
  }
}

function mountWorkbenchFixture(
  navigation: { directory: string; sessionID?: string },
  openProjects = [
    { id: "project-a", worktree: PROJECT_A, name: "project-a" },
    { id: "project-b", worktree: PROJECT_B, name: "project-b" },
  ],
) {
  const actions: GitActionInput[] = []
  let resolveAction: () => void = () => {}
  const actionRecorded = new Promise<void>((resolve) => {
    resolveAction = resolve
  })
  const dockItems = new Map<string, { mount: (context: DockMountContext) => void | (() => void) }>()
  const commands = new Map<string, { run: () => unknown }>()
  const toolbarItems = new Map<string, ToolbarRegistration>()
  const controller = new AbortController()
  let navigationHandler: ((next: { directory: string; sessionID?: string }, event?: { activated?: boolean }) => void) | undefined

  const gitSnapshot = async (input?: { directory?: string; limit?: number }) => ({
    info: { worktree: input?.directory ?? PROJECT_A, branch: "dev", default_branch: "dev" },
    status: [{ file: "src/pending.txt", code: " M" }],
    history: [],
    branches: [],
    remotes: [],
    tags: [],
    stashes: [],
    conflicts: [],
    operation: { inProgress: false },
  })

  const api = {
    settings: {
      get: (_key: string, fallback: unknown) => fallback,
      set: () => {},
      register: () => () => {},
      subscribe: () => () => {},
    },
    kv: {
      get: (_key: string, fallback: unknown) => fallback,
      set: () => {},
      delete: () => {},
    },
    toolbar: {
      register: (item: ToolbarRegistration) => {
        toolbarItems.set(item.id, item)
        return () => {}
      },
    },
    commands: {
      register: (command: { id: string; run: () => unknown }) => {
        commands.set(command.id, command)
      },
    },
    automation: { register: () => {} },
    dock: {
      register: (item: { id: string; mount: (context: DockMountContext) => void | (() => void) }) => {
        dockItems.set(item.id, item)
      },
      open: { item: () => {} },
    },
    lifecycle: { onDispose: () => () => {} },
    host: {
      projects: {
        list: () => openProjects,
        open: () => {},
        subscribe: () => () => {},
      },
      navigation: {
        current: () => ({ ...navigation }),
        subscribe: (handler: typeof navigationHandler) => {
          navigationHandler = handler ?? undefined
          return () => {
            if (navigationHandler === handler) navigationHandler = undefined
          }
        },
      },
      git: {
        snapshot: gitSnapshot,
        discover: async () => ({
          repositories: [
            { worktree: PROJECT_A, name: "project-a" },
            { worktree: PROJECT_B, name: "project-b" },
          ],
          truncated: false,
        }),
        action: async (input: GitActionInput) => {
          actions.push(input)
          resolveAction()
          return { ok: true, message: "ok", commit: "abc123 fix: generated message" }
        },
      },
    },
  }

  plugin.default.app(api)

  const element = document.createElement("div")
  document.body.append(element)
  const item = dockItems.get("gitWorkbench")
  if (!item) throw new Error("git workbench dock item was not registered")
  const cleanup = item.mount({ element, signal: controller.signal })

  return {
    actions,
    actionRecorded,
    commands,
    toolbarItems,
    element,
    emitNavigation: (next: { directory: string; sessionID?: string }, event?: { activated?: boolean }) =>
      navigationHandler?.(next, event),
    dispose: () => {
      if (typeof cleanup === "function") cleanup()
      controller.abort()
      element.remove()
    },
  }
}

function selectProject(element: HTMLElement, worktree: string) {
  const select = element.querySelector<HTMLSelectElement>(".oc-git-workbench__project-select")
  if (!select) throw new Error("project select was not rendered")
  select.value = worktree
  select.dispatchEvent(new Event("change", { bubbles: true }))
}

function selectedProject(element: HTMLElement) {
  return element.querySelector<HTMLSelectElement>(".oc-git-workbench__project-select")?.value ?? ""
}

function commitAllButton(element: HTMLElement) {
  const button = element.querySelector<HTMLButtonElement>('button[aria-label="Commit All Open Changes"]')
  if (!button) throw new Error("commit all open changes button was not rendered")
  return button
}

describe("Git Workbench auto commit with a switched project and another tab open", () => {
  test("workbench button commits the workbench project instead of jumping back to the active tab's project", async () => {
    // The active tab still belongs to project A while the workbench project was switched to B.
    const fixture = mountWorkbenchFixture({ directory: PROJECT_A, sessionID: "ses-project-a" })
    try {
      await settle()
      selectProject(fixture.element, PROJECT_B)
      await settle()
      expect(selectedProject(fixture.element)).toBe(PROJECT_B)

      commitAllButton(fixture.element).click()
      await fixture.actionRecorded
      await settle()

      expect(fixture.actions).toHaveLength(1)
      expect(fixture.actions[0]).toMatchObject({ action: "commitAuto", directory: PROJECT_B })
      expect(selectedProject(fixture.element)).toBe(PROJECT_B)
    } finally {
      fixture.dispose()
    }
  })

  test("ignores a stale active-tab navigation emitted while opening the selected repository", async () => {
    const fixture = mountWorkbenchFixture({ directory: PROJECT_A, sessionID: "ses-project-a" }, [
      { id: "project-a", worktree: PROJECT_A, name: "project-a" },
    ])
    try {
      await settle()
      selectProject(fixture.element, PROJECT_B)
      fixture.emitNavigation({ directory: PROJECT_A, sessionID: "ses-project-a" }, { activated: true })
      await settle()

      expect(selectedProject(fixture.element)).toBe(PROJECT_B)
    } finally {
      fixture.dispose()
    }
  })

  test("auto commit command keeps the workbench project when the active tab is another project", async () => {
    const fixture = mountWorkbenchFixture({ directory: PROJECT_A, sessionID: "ses-project-a" })
    try {
      await settle()
      selectProject(fixture.element, PROJECT_B)
      await settle()

      await fixture.commands.get("gitWorkbench.aiCommit")?.run()
      await settle()

      expect(fixture.actions).toHaveLength(1)
      expect(fixture.actions[0]).toMatchObject({ action: "commitAuto", directory: PROJECT_B })
      expect(selectedProject(fixture.element)).toBe(PROJECT_B)
    } finally {
      fixture.dispose()
    }
  })

  test("composer toolbar commit keeps priority for its own session project", async () => {
    // The composer toolbar button carries the composer session's directory. That explicit context
    // must stay authoritative even while the workbench shows a different project.
    const fixture = mountWorkbenchFixture({ directory: PROJECT_A, sessionID: "ses-project-a" })
    try {
      await settle()
      selectProject(fixture.element, PROJECT_B)
      await settle()

      const aiCommit = fixture.toolbarItems.get("aiCommit")
      if (!aiCommit) throw new Error("composer aiCommit toolbar item was not registered")
      await aiCommit.run({ directory: PROJECT_A, sessionID: "ses-project-a" })
      await settle()

      expect(fixture.actions).toHaveLength(1)
      expect(fixture.actions[0]).toMatchObject({ action: "commitAuto", directory: PROJECT_A })
    } finally {
      fixture.dispose()
    }
  })

  test("empty commit context still resolves to the workbench project, not the active tab", async () => {
    // Defense in depth for future callers: without an explicit context directory the resolution
    // must follow the workbench selection instead of the navigation (active tab) directory.
    const fixture = mountWorkbenchFixture({ directory: PROJECT_A, sessionID: "ses-project-a" })
    try {
      await settle()
      selectProject(fixture.element, PROJECT_B)
      await settle()

      const aiCommit = fixture.toolbarItems.get("aiCommit")
      if (!aiCommit) throw new Error("composer aiCommit toolbar item was not registered")
      await aiCommit.run({})
      await settle()

      expect(fixture.actions).toHaveLength(1)
      expect(fixture.actions[0]).toMatchObject({ action: "commitAuto", directory: PROJECT_B })
    } finally {
      fixture.dispose()
    }
  })
})
